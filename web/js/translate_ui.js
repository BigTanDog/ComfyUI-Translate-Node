/**
 * ComfyUI AI 翻译节点 — 前端 UI
 * 双文本框（可复制粘贴）+ 翻译按钮 + 齿轮设置弹窗（模型切换 / API 密钥）
 * 兼容新版 Vue 前端：DOM widget 显式 computeSize，避免 0 高度不可见
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const COMFY_CLASS = "ComfyTranslateNode";

const MODEL_INFO = {
  deepseek: { label: "DeepSeek-V4-Flash", keyStorage: "ctn_key_deepseek" },
  glm: { label: "GLM-5.3-Flash", keyStorage: "ctn_key_glm" },
};

const NODE_W = 480;    // 节点最小宽（左右双框布局）
const BOX_MIN_H = 150; // 文本框初始固定高度
const BOX_MAX_H = 600; // 高度上限，超出后框内滚动
const HEADER_H = 80;   // 节点标题 + 输入输出接口区高度

// ---------------- 样式注入 ----------------
(function injectStyle() {
  if (document.getElementById("ctn-style")) return;
  const style = document.createElement("style");
  style.id = "ctn-style";
  style.textContent = `
.ctn-ui {
  display:flex; flex-direction:column; gap:4px;
  padding:4px 6px 8px; box-sizing:border-box; width:100%;
}
.ctn-boxes { display:flex; gap:8px; align-items:stretch; }
.ctn-ui textarea {
  display:block; flex:1 1 0; min-width:0; box-sizing:border-box; resize:none;
  height:${BOX_MIN_H}px; overflow-y:auto;
  background:var(--comfy-input-bg, #232323); color:var(--input-text, #ddd);
  border:1px solid var(--border-color, #444); border-radius:6px;
  padding:6px 8px; font-size:13px; font-family:inherit; line-height:1.45;
  user-select:text; -webkit-user-select:text;
}
.ctn-ui textarea:focus { outline:1px solid var(--accent-color, #4a9eff); }
.ctn-row { display:flex; gap:8px; align-items:center; }
.ctn-mid {
  flex:0 0 76px; display:flex; flex-direction:column; gap:6px;
  align-items:stretch; justify-content:center;
}
.ctn-mid-row { display:flex; gap:6px; }
.ctn-btn {
  height:34px; width:100%; padding:0; border:none; border-radius:6px; cursor:pointer;
  font-size:13px; color:#fff; background:linear-gradient(135deg,#2d6cdf,#5b3df0);
}
.ctn-btn:hover { filter:brightness(1.15); }
.ctn-btn:disabled { opacity:.55; cursor:wait; }
.ctn-btn-copy, .ctn-gear {
  flex:1; min-width:0; height:28px; padding:0; border:none; border-radius:6px;
  cursor:pointer; background:#3a3a3a; color:#ccc; font-size:12px; line-height:1;
}
.ctn-gear { font-size:14px; }
.ctn-btn-copy:hover, .ctn-gear:hover { background:#4a4a4a; }
.ctn-swap {
  height:28px; width:100%; padding:0; border:none; border-radius:6px; cursor:pointer;
  display:flex; align-items:center; justify-content:center; gap:4px;
  background:#0e8a6d; color:#fff; font-size:12px;
}
.ctn-swap:hover:not(:disabled) { filter:brightness(1.15); }
.ctn-swap:disabled { background:#2a2a2a; color:#666; cursor:not-allowed; }
.ctn-swap svg { flex:0 0 auto; }
.ctn-status { font-size:11px; min-height:14px; line-height:14px; color:#888; }
.ctn-status.err { color:#e05656; }
.ctn-status.ok { color:#4fc06a; }

/* 设置弹窗 */
#ctn-overlay {
  position:fixed; inset:0; z-index:99999; background:rgba(0,0,0,.55);
  display:flex; align-items:center; justify-content:center;
}
.ctn-panel {
  width:340px; background:var(--comfy-menu-bg, #1e1e1e); color:var(--input-text, #ddd);
  border:1px solid var(--border-color, #444); border-radius:10px;
  padding:16px; display:flex; flex-direction:column; gap:10px;
  box-shadow:0 8px 32px rgba(0,0,0,.5);
}
.ctn-panel .ctn-title { font-size:15px; font-weight:600; text-align:center; }
.ctn-panel .ctn-line { font-size:13px; }
.ctn-panel .ctn-cur { color:#7ab8ff; }
.ctn-panel button {
  padding:7px 0; border:1px solid var(--border-color, #444); border-radius:6px;
  cursor:pointer; font-size:13px; background:#2c2c2c; color:var(--input-text, #ddd);
}
.ctn-panel button:hover { background:#3a3a3a; }
.ctn-panel button.ctn-active {
  background:linear-gradient(135deg,#2d6cdf,#5b3df0); color:#fff; border-color:transparent;
}
.ctn-panel input {
  width:100%; box-sizing:border-box; padding:7px 9px; font-size:13px;
  background:var(--comfy-input-bg, #232323); color:var(--input-text, #ddd);
  border:1px solid var(--border-color, #444); border-radius:6px;
}
.ctn-panel .ctn-row button { flex:1; }
.ctn-panel .ctn-ok { background:#2d6cdf !important; color:#fff !important; border-color:transparent !important; }
`;
  document.head.appendChild(style);
})();

// ---------------- 设置弹窗 ----------------
function closeSettings() {
  document.getElementById("ctn-overlay")?.remove();
}

function openSettings(node) {
  closeSettings();
  let selected = node.properties.translate_model || "deepseek";

  const overlay = document.createElement("div");
  overlay.id = "ctn-overlay";
  overlay.innerHTML = `
    <div class="ctn-panel">
      <div class="ctn-title">⚙️ 翻译节点设置</div>
      <div class="ctn-line">当前模型：<span class="ctn-cur" id="ctn-cur">${MODEL_INFO[selected].label}</span></div>
      <div class="ctn-row">
        <button data-m="deepseek" class="${selected === "deepseek" ? "ctn-active" : ""}">DeepSeek-V4-Flash</button>
        <button data-m="glm" class="${selected === "glm" ? "ctn-active" : ""}">GLM-5.3-Flash</button>
      </div>
      <div class="ctn-line">API 密钥（<span id="ctn-key-label">${MODEL_INFO[selected].label}</span>）：</div>
      <input id="ctn-key" type="password" placeholder="sk-..." autocomplete="off">
      <div class="ctn-row">
        <button id="ctn-ok" class="ctn-ok">确认</button>
        <button id="ctn-cancel">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const keyInput = overlay.querySelector("#ctn-key");
  const curLabel = overlay.querySelector("#ctn-cur");
  const keyLabel = overlay.querySelector("#ctn-key-label");
  keyInput.value = localStorage.getItem(MODEL_INFO[selected].keyStorage) || "";

  // 切换模型：高亮 + 同步显示对应模型的已存密钥
  overlay.querySelectorAll("button[data-m]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selected = btn.dataset.m;
      overlay.querySelectorAll("button[data-m]").forEach((b) =>
        b.classList.toggle("ctn-active", b === btn)
      );
      curLabel.textContent = MODEL_INFO[selected].label;
      keyLabel.textContent = MODEL_INFO[selected].label;
      keyInput.value = localStorage.getItem(MODEL_INFO[selected].keyStorage) || "";
    });
  });

  const close = () => overlay.remove();
  overlay.querySelector("#ctn-cancel").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); }
  });

  // 确认：保存密钥 + 切换模型
  overlay.querySelector("#ctn-ok").addEventListener("click", () => {
    localStorage.setItem(MODEL_INFO[selected].keyStorage, keyInput.value.trim());
    node.properties.translate_model = selected;
    close();
  });
}

// ---------------- 节点 UI 构建 ----------------
function buildUI(node) {
  const el = document.createElement("div");
  el.className = "ctn-ui";
  el.innerHTML = `
    <div class="ctn-boxes">
      <textarea class="ctn-input" placeholder="输入原文（自动识别语言：非中文→译为中文，中文→译为英文）"></textarea>
      <div class="ctn-mid">
        <button class="ctn-btn ctn-go">翻译</button>
        <div class="ctn-mid-row">
          <button class="ctn-gear" title="设置：切换模型 / 填写 API 密钥">⚙️</button>
          <button class="ctn-btn-copy ctn-copy" title="复制译文">复制</button>
        </div>
        <button class="ctn-swap ctn-swapbtn" title="把右侧译文换到左侧输入框（两边内容互换）" disabled>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 20V6"/><path d="M3 10l4-4 4 4"/><path d="M17 4v14"/><path d="M13 14l4 4 4-4"/></svg>互换
        </button>
      </div>
      <textarea class="ctn-output" placeholder="翻译结果" readonly></textarea>
    </div>
    <div class="ctn-status"></div>`;

  const inputEl = el.querySelector(".ctn-input");
  const outputEl = el.querySelector(".ctn-output");
  const goBtn = el.querySelector(".ctn-go");
  const statusEl = el.querySelector(".ctn-status");
  const copyBtn = el.querySelector(".ctn-copy");
  const swapBtn = el.querySelector(".ctn-swapbtn");

  // 挂到节点上，供 onConfigure 加载工作流时回填
  node.ctn = { inputEl, outputEl, sync: null, updateSwap: null };

  // 关键：新版 Vue 前端要求 type 非空字符串（shouldRenderAsVue: !!widget.type），
  // 传空字符串会导致整个 widget 不被渲染
  const w = node.addDOMWidget("ctn_ui", "ctn_translate_ui", el, { serialize: false });

  // 高度自适应：框宽固定（平分节点宽度），高度跟随内容，双框始终等高
  let boxH = BOX_MIN_H;
  w.computeSize = () => [node.size[0] - 16, boxH + 30];

  const sync = () => {
    if (!el.isConnected) return;
    // 先归零再量 scrollHeight，否则量到的永远 ≥ 当前高度，无法回落
    const measure = (ta) => { ta.style.height = "0px"; return ta.scrollHeight; };
    const h = Math.min(
      Math.max(measure(inputEl), measure(outputEl), BOX_MIN_H),
      BOX_MAX_H
    );
    inputEl.style.height = h + "px";
    outputEl.style.height = h + "px";
    boxH = h;
    // 节点高度 = 头部(标题+接口) + 框高 + 状态栏/间距，跟随内容伸缩
    const total = HEADER_H + h + 30;
    if (Math.abs(node.size[1] - total) > 2) {
      node.size[1] = total;
      node.setDirtyCanvas?.(true, true);
    }
  };
  node.ctn.sync = sync;

  // 互换按钮状态：右侧（译文）为空时灰禁
  const updateSwapState = () => {
    swapBtn.disabled = !outputEl.value.trim();
  };
  node.ctn.updateSwap = updateSwapState;

  // 元素被 Vue 挂载后再做首次同步（挂载前 scrollHeight 量不到内容）
  let tries = 0;
  const syncWhenReady = () => {
    if (el.isConnected) sync();
    else if (tries++ < 600) requestAnimationFrame(syncWhenReady);
  };
  syncWhenReady();
  // 节点宽度变化时（用户拖拽）重新量高
  new ResizeObserver(() => sync()).observe(el);

  // 输入/输出内容持久化到节点属性（随工作流保存）
  inputEl.value = node.properties.ctn_input || "";
  outputEl.value = node.properties.ctn_output || "";
  inputEl.addEventListener("input", () => { node.properties.ctn_input = inputEl.value; sync(); });
  outputEl.addEventListener("input", () => { node.properties.ctn_output = outputEl.value; sync(); updateSwapState(); });
  updateSwapState();

  // 互换：左↔右内容交换（译文回到左侧待翻译框，原文换到右侧）
  swapBtn.addEventListener("click", () => {
    if (swapBtn.disabled) return;
    const inV = inputEl.value;
    inputEl.value = outputEl.value;
    outputEl.value = inV;
    node.properties.ctn_input = inputEl.value;
    node.properties.ctn_output = outputEl.value;
    statusEl.textContent = "";
    statusEl.className = "ctn-status";
    sync();
    updateSwapState();
  });

  // 复制译文
  copyBtn.addEventListener("click", async () => {
    const t = outputEl.value;
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
    } catch {
      outputEl.removeAttribute("readonly");
      outputEl.select();
      document.execCommand("copy");
      outputEl.setAttribute("readonly", "");
    }
    statusEl.textContent = "已复制到剪贴板";
    statusEl.className = "ctn-status ok";
    setTimeout(() => (statusEl.textContent = ""), 2000);
  });

  // 翻译
  goBtn.addEventListener("click", async () => {
    const text = inputEl.value.trim();
    statusEl.textContent = "";
    statusEl.className = "ctn-status";
    if (!text) {
      statusEl.textContent = "请先输入要翻译的内容";
      statusEl.className = "ctn-status err";
      return;
    }
    const provider = node.properties.translate_model || "deepseek";
    const apiKey = localStorage.getItem(MODEL_INFO[provider].keyStorage) || "";

    goBtn.disabled = true;
    goBtn.textContent = "翻译中…";
    try {
      const resp = await api.fetchApi("/ctn/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey, text }),
      });
      const data = await resp.json();
      if (data.error) {
        statusEl.textContent = data.error;
        statusEl.className = "ctn-status err";
      } else {
        outputEl.value = data.translated;
        node.properties.ctn_output = data.translated;
        statusEl.textContent = `✓ ${MODEL_INFO[provider].label}`;
        statusEl.className = "ctn-status ok";
        sync();
        updateSwapState();
      }
    } catch (e) {
      statusEl.textContent = "请求失败: " + e.message;
      statusEl.className = "ctn-status err";
    } finally {
      goBtn.disabled = false;
      goBtn.textContent = "翻译";
    }
  });

  // 齿轮 → 设置弹窗
  el.querySelector(".ctn-gear").addEventListener("click", () => openSettings(node));

  // 初始尺寸：宽度固定起步，高度 = 头部 + 初始框高 + 状态栏
  if (node.size[0] < NODE_W) node.size[0] = NODE_W;
  const minTotal = HEADER_H + BOX_MIN_H + 30;
  if (node.size[1] < minTotal) node.size[1] = minTotal;
}

// ---------------- 扩展注册 ----------------
app.registerExtension({
  name: "ComfyUI.TranslateNode",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== COMFY_CLASS) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      try {
        if (!this.properties.translate_model) this.properties.translate_model = "deepseek";
        buildUI(this);
      } catch (e) {
        console.error("[TranslateNode] UI 构建失败:", e);
        this.title += " ⚠️UI错误";
      }
      return r;
    };

    // 执行完成：上游（如本地反推插件）经 socket 传来的文本回填到左侧待翻译框
    // （Python 侧 OUTPUT_NODE + ui.text 回传；空文本不覆盖已有内容）
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExecuted?.apply(this, arguments);
      const t = message?.text?.[0];
      if (typeof t === "string" && t && this.ctn) {
        this.ctn.inputEl.value = t;
        this.properties.ctn_input = t;
        this.ctn.sync?.();
        this.ctn.updateSwap?.();
      }
      return r;
    };

    // 加载已保存的工作流时，把属性里的内容回填到文本框并重算高度
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      const ui = this.ctn;
      if (ui) {
        ui.inputEl.value = this.properties.ctn_input || "";
        ui.outputEl.value = this.properties.ctn_output || "";
        // 挂载可能尚未完成，走 sync 内部的就绪检测
        ui.sync?.();
        ui.updateSwap?.();
      }
      return r;
    };
  },
});
