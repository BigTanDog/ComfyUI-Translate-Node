"""ComfyUI AI 翻译节点 — 入口"""

from .translator_node import (
    NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS,
)

WEB_DIRECTORY = "./web/js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
