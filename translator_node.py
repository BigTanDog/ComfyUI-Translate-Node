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


# ---------------- 下游透传节点模式探测 ----------------
def _get_workflow(extra_pnginfo):
    """extra_pnginfo 可能是 dict 或 list，兼容两种取 workflow"""
    if isinstance(extra_pnginfo, list) and extra_pnginfo:
        return extra_pnginfo[0].get("workflow") or {}
    if isinstance(extra_pnginfo, dict):
        return extra_pnginfo.get("workflow") or {}
    return {}


def _downstream_pt_in_content_mode(extra_pnginfo, unique_id):
    """沿本节点输出链（穿透 Reroute）查找「文本(透传)」节点，
    若存在处于内容模式（use_input_text=False）者返回 True。"""
    try:
        wf = _get_workflow(extra_pnginfo)
        nodes = {str(n.get("id")): n for n in wf.get("nodes", [])}
        links = {str(l[0]): l for l in wf.get("links", []) if isinstance(l, (list, tuple)) and l}
        queue = [str(unique_id)]
        seen = set()
        while queue and len(seen) < 64:
            cur = queue.pop(0)
            if cur in seen:
                continue
            seen.add(cur)
            node = nodes.get(cur)
            if not node:
                continue
            out_links = []
            for o in node.get("outputs", []) or []:
                out_links += o.get("links") or []
            for lid in out_links:
                l = links.get(str(lid))
                if not l or len(l) < 4:
                    continue
                tgt = nodes.get(str(l[3]))
                if not tgt:
                    continue
                ttype = str(tgt.get("type", ""))
                if ttype == "DanbooruTextPassthrough":
                    inp = next((i for i in tgt.get("inputs", []) if i.get("name") == "use_input_text"), None)
                    if inp is not None and inp.get("value") is False:
                        return True  # 内容模式
                elif "Reroute" in ttype:
                    queue.append(str(tgt.get("id")))
        return False
    except Exception:
        return False  # 探测失败时默认接受数据，不阻断原流程


# ---------------- ComfyUI 节点 ----------------
class ComfyTranslateNode:
    """AI 翻译节点。翻译动作由前端按钮触发（走上方 /ctn/translate 路由）。

    text 输入接口（lazy）：接收上游（如本地反推插件）输出的文本。
    - 下游「文本(透传)」节点为 📥 输入 模式时：正常求值上游并回传（前端填入左框）
    - 下游为 📝 内容 模式时：check_lazy_status 返回空 → 上游反推整条不求值不执行，
      且不回传文本，保护左框中用户互换过来的原文
    节点为 OUTPUT_NODE，保证参与队列执行。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                # lazy：由 check_lazy_status 决定是否向上游求值
                "text": ("STRING", {"forceInput": True, "lazy": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "文本处理"
    OUTPUT_NODE = True

    @classmethod
    def check_lazy_status(cls, unique_id=None, extra_pnginfo=None, **kwargs):
        # 下游透传为内容模式 → 不需要 text，上游反推整条不执行
        # （写法对齐 DanbooruTextPassthrough：恒定返回，执行器自行处理已求值情况）
        if _downstream_pt_in_content_mode(extra_pnginfo, unique_id):
            return []
        return ["text"]

    def run(self, text=None, unique_id=None, extra_pnginfo=None):
        out = text or ""
        suppress = _downstream_pt_in_content_mode(extra_pnginfo, unique_id)
        # 内容模式：不回传（前端 onExecuted 收到空文本不覆盖左框）；输出接口仍直通
        ui_text = [""] if suppress else [out]
        return {"ui": {"text": ui_text}, "result": (out,)}


NODE_CLASS_MAPPINGS = {"ComfyTranslateNode": ComfyTranslateNode}
NODE_DISPLAY_NAME_MAPPINGS = {"ComfyTranslateNode": "AI 翻译 🌐"}
