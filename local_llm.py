# -*- coding: utf-8 -*-
"""本地 GGUF 模型翻译后端（llama.cpp · 全 GPU）

设计要点（均经实测确认）：
- 懒加载单例：首次翻译时加载（约 3-5 秒），之后常驻显存复用，每次翻译 0.4~1.5 秒
- 全 GPU：n_gpu_layers=-1（显存占用与所选模型文件大小相当，如 5.2GB 的 Q4_K_M）
- 可选模型：扫描 `models/LLM/*.gguf`（排除 mmproj），支持翻译时按选择自动切换
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
DEFAULT_MODEL_FILENAME = "Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf"
_FALLBACK_MODEL_DIR = r"D:\ComfyUI-aki-v3.2\ComfyUI\models\LLM"

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
_loaded_model = None      # 当前已加载的模型文件名
_selected_model = None    # 最近一次请求选用的模型文件名（卸载后重载时沿用）


# ---------------- 模型路径与列表 ----------------
def model_dir() -> str:
    """本地模型目录：环境变量 CTN_LOCAL_MODEL_DIR > ComfyUI models/LLM > 兜底路径"""
    env = os.environ.get("CTN_LOCAL_MODEL_DIR")
    if env and os.path.isdir(env):
        return env
    try:
        import folder_paths  # ComfyUI 环境内可用
        d = os.path.join(str(folder_paths.models_dir), "LLM")
        if os.path.isdir(d):
            return d
    except Exception:
        pass
    return _FALLBACK_MODEL_DIR


def list_models() -> list:
    """列出可选的本地 GGUF 模型（排除 mmproj 视觉投影文件）"""
    d = model_dir()
    out = []
    try:
        for fn in sorted(os.listdir(d)):
            low = fn.lower()
            if not low.endswith(".gguf") or "mmproj" in low:
                continue
            p = os.path.join(d, fn)
            if os.path.isfile(p):
                size = os.path.getsize(p)
                out.append({
                    "name": fn,
                    "size_bytes": size,
                    "size_gb": round(size / (1024 ** 3), 2),
                })
    except Exception:
        pass
    return out


def resolve_model_path(model_name: str = None) -> str:
    """解析模型路径：请求指定（模型目录内文件名）> 环境变量 CTN_LOCAL_MODEL > 目录内默认文件名"""
    d = model_dir()
    name = (model_name or "").strip()
    if name:
        p = name if os.path.isabs(name) else os.path.join(d, name)
        if os.path.isfile(p):
            return p
    env = os.environ.get("CTN_LOCAL_MODEL")
    if env and os.path.isfile(env):
        return env
    return os.path.join(d, DEFAULT_MODEL_FILENAME)


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


def _load_locked(model_name: str = None):
    """（须持有锁）确保目标模型已加载并返回实例。
    若当前加载的不是目标模型，先卸载再加载（切换模型）。"""
    global _llm, _loading, _last_error, _last_used, _load_count, _loaded_model, _selected_model

    if model_name:
        _selected_model = os.path.basename(model_name)
    want = _selected_model or DEFAULT_MODEL_FILENAME

    if _llm is not None:
        if _loaded_model == want:
            return _llm
        _unload_locked("switch_model")  # 切换模型：先释放当前显存

    path = resolve_model_path(want)
    if not os.path.isfile(path):
        raise FileNotFoundError(
            f"未找到本地模型文件：{path}\n"
            f"（模型需放在 {model_dir()}，或用环境变量 CTN_LOCAL_MODEL 指定）"
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
        _loaded_model = os.path.basename(path)
        _last_used = time.time()
        _start_watchdog_locked()
        print(f"[TranslateNode] 本地模型已加载（{time.time() - t0:.1f}s）：{_loaded_model}")
        return _llm
    except Exception as e:
        _last_error = str(e)
        _llm = None
        _loaded_model = None
        raise
    finally:
        _loading = False


def _unload_locked(reason: str = "") -> bool:
    """（须持有锁）卸载模型并释放显存"""
    global _llm, _unload_count, _loaded_model
    if _llm is None:
        return False
    try:
        _llm.close()
    except Exception:
        pass
    _llm = None
    _loaded_model = None
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
    model: str = None,
) -> str:
    """本地模型翻译。idle_seconds 语义：
    >0 空闲该秒数后自动释放；0 翻译完成后立即释放；-1 不自动释放；None 保持当前设置
    model：模型目录内的 .gguf 文件名；与当前已加载模型不同则自动切换。"""
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

        llm = _load_locked(model)
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
        path = resolve_model_path(_selected_model)
        loaded = _llm is not None
        remaining = None
        if loaded and _idle_seconds > 0:
            remaining = max(0, int(_idle_seconds - (time.time() - _last_used)))
        loaded_size = None
        if loaded and _loaded_model:
            p = resolve_model_path(_loaded_model)
            if os.path.isfile(p):
                loaded_size = round(os.path.getsize(p) / (1024 ** 3), 2)
        return {
            "loaded": loaded,
            "loading": _loading,
            "model": os.path.basename(path),
            "model_path": path,
            "model_exists": os.path.isfile(path),
            "model_dir": model_dir(),
            "selected_model": _selected_model or DEFAULT_MODEL_FILENAME,
            "loaded_model": _loaded_model,
            "loaded_model_size_gb": loaded_size,
            "device": "GPU (n_gpu_layers=-1)",
            "idle_seconds": _idle_seconds,
            "idle_remaining": remaining,
            "load_count": _load_count,
            "unload_count": _unload_count,
            "last_error": _last_error,
        }
