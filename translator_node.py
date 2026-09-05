"""AI 翻译节点：后端节点 + 翻译 HTTP 路由（DeepSeek-V4-Flash / GLM-5.3-Flash）"""

import aiohttp
from aiohttp import web

try:
    from server import PromptServer
except Exception:  # 非ComfyUI环境导入不报错
    PromptServer = None

# ---------------- 模型配置 ----------------
PROVIDERS = {
    "deepseek": {
        "url": "https://api.deepseek.com/chat/completions",
        "model": "deepseek-v4-flash",
    },
    "glm": {
        "url": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        "model": "glm-5.3-flash",
    },
}

SYSTEM_PROMPT = (
    "你是一个翻译引擎。自动检测用户输入的语言："
    "如果不是中文，将其翻译成简体中文；"
    "如果是中文（含繁体），将其翻译成英文。"
    "只输出译文本身，不要输出任何解释、引号或多余内容，"
    "保持原文的段落、换行和格式，专有名词保留原样。"
)

REQUEST_TIMEOUT = 120  # 秒


# ---------------- 翻译路由 ----------------
async def _translate_handler(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except Exception:
        return web.json_response({"error": "无效的请求体"}, status=400)

    provider = (payload.get("provider") or "deepseek").strip()
    api_key = (payload.get("api_key") or "").strip()
    text = (payload.get("text") or "").strip()

    if provider not in PROVIDERS:
        return web.json_response({"error": f"未知模型: {provider}"}, status=400)
    if not api_key:
        return web.json_response({"error": "请先点击齿轮⚙️在设置中填写 API 密钥"})
    if not text:
        return web.json_response({"error": "请先输入要翻译的内容"})

    conf = PROVIDERS[provider]
    body = {
        "model": conf["model"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
        "stream": False,
        "temperature": 0.3,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    try:
        timeout = aiohttp.ClientTimeout(total=REQUEST_TIMEOUT)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(conf["url"], json=body, headers=headers) as resp:
                try:
                    data = await resp.json()
                except Exception:
                    data = {"error": {"message": (await resp.text())[:200]}}
                if resp.status != 200:
                    msg = ""
                    if isinstance(data, dict):
                        err = data.get("error")
                        msg = err.get("message", "") if isinstance(err, dict) else str(err)
                    return web.json_response(
                        {"error": f"API 返回 {resp.status}: {msg or '请求失败'}"}
                    )
                content = data["choices"][0]["message"]["content"].strip()
                return web.json_response({"translated": content})
    except aiohttp.ClientError as e:
        return web.json_response({"error": f"网络请求失败: {e}"})
    except Exception as e:
        return web.json_response({"error": f"翻译失败: {e}"})


# 注册路由（模块导入时执行一次）
if PromptServer is not None:
    _ps = PromptServer.instance
    if _ps is not None:
        _ps.routes.post("/ctn/translate")(_translate_handler)


# ---------------- ComfyUI 节点 ----------------
class ComfyTranslateNode:
    """AI 翻译节点。翻译动作由前端按钮触发（走上方 /ctn/translate 路由）。

    text 输入接口：接收上游（如本地反推插件）输出的文本。
    节点标记为 OUTPUT_NODE 以确保参与队列执行：执行时收到的 text
    会通过 ui.text 回传给前端，由前端 onExecuted 填入左侧待翻译框。
    输出接口当前为直通（下游可拿到收到的 text），暂无其他功能。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                # 仅作为接口占位（forceInput → 纯 socket，不生成输入框）
                "text": ("STRING", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "文本处理"
    OUTPUT_NODE = True

    def run(self, text=None):
        out = text or ""
        # ui.text 回传前端（onExecuted 接收）；result 直通给下游输出接口
        return {"ui": {"text": [out]}, "result": (out,)}


NODE_CLASS_MAPPINGS = {"ComfyTranslateNode": ComfyTranslateNode}
NODE_DISPLAY_NAME_MAPPINGS = {"ComfyTranslateNode": "AI 翻译 🌐"}
