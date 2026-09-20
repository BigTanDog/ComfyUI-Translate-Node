# -*- coding: utf-8 -*-
"""本地 GGUF 模型翻译后端（llama.cpp · 全 GPU）

设计要点（均经实测确认）：
- 懒加载单例：首次翻译时加载（约 3-5 秒），之后常驻显存复用，每次翻译 0.4~1.5 秒
- 全 GPU：n_gpu_layers=-1，33/33 层进显存，约占 5.6GB
- ctx_checkpoints=0：关闭 hybrid 模型的检查点机制。该机制每次调用会做约 1.6 秒的
  显存→内存状态拷贝（llama.cpp fork 作者注释明确这是为 ComfyUI 单次调用场景预留的开关）
- 手动 no-think 预填：模型自带 thinking 模式，直接在提示词中预填空的思考块
  `<think></think>`，跳过思考直接输出译文（比 reasoning_budget 方案输出更干净）
- 空闲自动卸载：超过设定时长未使用自动释放显存；支持"每次翻译后立即释放"与"不自动释放"
- 卸载可靠：close + 解除引用 + GC 后显存完整归还（实测 6472→995 MiB）

本模块不依赖 ComfyUI，可独立测试。
"""

from __future__ import annotations

import gc
import os
import threading
import time

# ---------------- 配置 ----------------
MODEL_FILENAME = "Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf"
_FALLBACK_MODEL = r"D:\ComfyUI-aki-v3.2\ComfyUI\models\LLM" + "\\" + MODEL_FILENAME

DEFAULT_N_CTX = 4096
DEFAULT_MAX_TOKENS = 1024
DEFAULT_IDLE_SECONDS = 180      # 空闲 3 分钟自动释放显存
IDLE_IMMEDIATE = 0              # 0 = 每次翻译后立即释放
IDLE_NEVER = -1                 # -1 = 不自动释放

MAX_INPUT_CHARS = 6000          # 超长保护（n_ctx=4096 下的安全上限）

# 待翻译文本分隔标记：防止“文本内指令”被模型当作命令执行（如实测的
# “Start directly with the description.” 会让模型跳过翻译直接编造描述）
DELIM_OPEN = "<待翻译文本>"
DELIM_CLOSE = "</待翻译文本>"

WATCHDOG_INTERVAL = 5           # 看门狗轮询间隔（秒）

# ---------------- 状态 ----------------
_lock = threading.RLock()
_llm = None
_loading = False
_last_used = 0.0
_idle_seconds = DEFAULT_IDLE_SECONDS
_last_error = ""
_load_count = 0
_unload_count = 0
_watchdog_started = False


# ---------------- 路径解析 ----------------
def resolve_model_path() -> str:
    """环境变量 CTN_LOCAL_MODEL > ComfyUI models/LLM/ > 兜底绝对路径"""
    env = os.environ.get("CTN_LOCAL_MODEL")
    if env and os.path.isfile(env):
        return env
    try:
        import folder_paths  # ComfyUI 环境内可用
        p = os.path.join(str(folder_paths.models_dir), "LLM", MODEL_FILENAME)
        if os.path.isfile(p):
            return p
    except Exception:
        pass
    return _FALLBACK_MODEL


def _ensure_gpu_dll_path() -> None:
    """llama_cpp 的 CUDA 后端依赖 CUDA 运行库（cudart/cublas）。
    ComfyUI 进程中 torch 会加载并注册 torch/lib 目录；此处兜底确保路径存在，
    否则 ggml-cuda.dll 加载失败会静默退化为 CPU（慢 20 倍以上）。"""
    try:
        import torch  # noqa: F401
        lib = os.path.join(os.path.dirname(torch.__file__), "lib")
        if os.path.isdir(lib):
            try:
                os.add_dll_directory(lib)
            except (AttributeError, OSError):
                pass
    except Exception:
        pass


# ---------------- 提示词 ----------------
def build_prompt(system_prompt: str, text: str) -> str:
    """按 Qwen 对话模板手工拼装：
    - 待翻译文本用 <待翻译文本>…</待翻译文本> 包裹（防止文本内指令被模型执行）
    - assistant 前缀预填空思考块（关思考）
    """
    return (
        f"<|im_start|>system\n{system_prompt}<|im_end|>\n"
        f"<|im_start|>user\n{DELIM_OPEN}\n{text}\n{DELIM_CLOSE}<|im_end|>\n"
        f"<|im_start|>assistant\n<think>\n\n</think>\n\n"
    )


def clean_output(s: str) -> str:
    """防御性清理：去掉可能残留的思考标记、分隔标记与首尾空白"""
    if not s:
        return ""
    s = s.strip()
    for marker in ("</think>", "<think>", "<|im_start|>", "<|im_end|>", DELIM_OPEN, DELIM_CLOSE):
        while s.startswith(marker):
            s = s[len(marker):].lstrip()
    for marker in (DELIM_CLOSE, DELIM_OPEN, "<|im_end|>"):
        if s.endswith(marker):
            s = s[: -len(marker)].rstrip()
    return s.strip()


# ---------------- 加载 / 卸载 ----------------
def _start_watchdog_locked() -> None:
    global _watchdog_started
    if _watchdog_started:
        return
    _watchdog_started = True

    def loop():
        while True:
            time.sleep(WATCHDOG_INTERVAL)
            try:
                with _lock:
                    if _llm is None:
                        continue
                    if _idle_seconds <= 0:
                        continue  # 0=立即释放模式由翻译流程处理；-1=不自动释放
                    if (time.time() - _last_used) >= _idle_seconds:
                        _unload_locked("idle_timeout")
            except Exception:
                pass

    threading.Thread(target=loop, name="ctn-local-llm-watchdog", daemon=True).start()


def _load_locked():
    """（须持有锁）确保模型已加载并返回实例"""
    global _llm, _loading, _last_error, _last_used, _load_count
    if _llm is not None:
        return _llm

    path = resolve_model_path()
    if not os.path.isfile(path):
        raise FileNotFoundError(
            f"未找到本地模型文件：{path}\n"
            f"（可通过环境变量 CTN_LOCAL_MODEL 指定其他 .gguf 路径）"
        )

    _loading = True
    _last_error = ""
    try:
        _ensure_gpu_dll_path()
        import llama_cpp  # 延迟导入：不影响 ComfyUI 启动速度

        t0 = time.time()
        _llm = llama_cpp.Llama(
            model_path=path,
            n_gpu_layers=-1,        # 全 GPU
            n_ctx=DEFAULT_N_CTX,
            ctx_checkpoints=0,      # 关闭 hybrid 检查点（单次调用场景，省 ~1.6s/次）
            verbose=False,
        )
        _load_count += 1
        _last_used = time.time()
        _start_watchdog_locked()
        print(f"[TranslateNode] 本地模型已加载（{time.time() - t0:.1f}s）：{os.path.basename(path)}")
        return _llm
    except Exception as e:
        _last_error = str(e)
        _llm = None
        raise
    finally:
        _loading = False


def _unload_locked(reason: str = "") -> bool:
    """（须持有锁）卸载模型并释放显存"""
    global _llm, _unload_count
    if _llm is None:
        return False
    try:
        _llm.close()
    except Exception:
        pass
    _llm = None
    gc.collect()
    _unload_count += 1
    if reason:
        print(f"[TranslateNode] 本地模型已卸载（{reason}），显存已释放")
    return True


def unload(reason: str = "manual") -> bool:
    """手动卸载（线程安全）"""
    with _lock:
        return _unload_locked(reason)


# ---------------- 翻译 ----------------
def translate(
    text: str,
    system_prompt: str,
    idle_seconds=None,
    max_tokens: int = None,
) -> str:
    """本地模型翻译。idle_seconds 语义：
    >0 空闲该秒数后自动释放；0 翻译完成后立即释放；-1 不自动释放；None 保持当前设置"""
    global _last_used, _idle_seconds
    text = (text or "").strip()
    if not text:
        raise ValueError("请先输入要翻译的内容")
    if len(text) > MAX_INPUT_CHARS:
        raise ValueError(
            f"文本过长（{len(text)} 字符，本地模型上限约 {MAX_INPUT_CHARS} 字符），请分段翻译"
        )
    if max_tokens is None:
        # 输出预算随输入长度自适应（中文译文 token 数通常不超过原文字符数）
        max_tokens = max(512, min(2048, len(text)))

    with _lock:
        if idle_seconds is not None:
            try:
                v = int(idle_seconds)
                _idle_seconds = max(IDLE_NEVER, min(v, 86400))
            except (TypeError, ValueError):
                pass

        llm = _load_locked()
        prompt = build_prompt(system_prompt, text)
        # 每次翻译前强制清空上下文（注意力 KV + 循环状态）。
        # 该模型为 hybrid 架构：复用上一轮 KV 时，循环状态理论上可能残留旧内容，
        # 导致译文与当前输入不符。全量重算仅增加约 0.1~0.5 秒，换取结果确定性。
        try:
            llm.reset()
        except Exception:
            pass

        def _run() -> str:
            res = llm.create_completion(
                prompt=prompt,
                temperature=0.3,
                max_tokens=max_tokens,
                stop=["<|im_end|>", "<|im_start|>"],
            )
            return clean_output(res["choices"][0]["text"])

        out = _run()
        # 兜底：长文本被原样返回（未翻译，采样偶发）→ 自动重试一次
        if out and len(text) > 20 and out.strip() == text.strip():
            out = _run()

        _last_used = time.time()

        # 每次翻译后立即释放模式
        if _idle_seconds == IDLE_IMMEDIATE:
            _unload_locked("after_translate")

        if not out:
            raise RuntimeError("本地模型没有输出内容，请重试")
        return out


# ---------------- 状态 ----------------
def status() -> dict:
    with _lock:
        path = resolve_model_path()
        loaded = _llm is not None
        remaining = None
        if loaded and _idle_seconds > 0:
            remaining = max(0, int(_idle_seconds - (time.time() - _last_used)))
        return {
            "loaded": loaded,
            "loading": _loading,
            "model": os.path.basename(path),
            "model_path": path,
            "model_exists": os.path.isfile(path),
            "device": "GPU (n_gpu_layers=-1)",
            "idle_seconds": _idle_seconds,
            "idle_remaining": remaining,
            "load_count": _load_count,
            "unload_count": _unload_count,
            "last_error": _last_error,
        }
