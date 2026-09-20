/**
 * ComfyUI AI 翻译节点 — 前端 UI
 * 双文本框（可复制粘贴）+ 翻译按钮 + 齿轮设置弹窗（模型切换 / API 密钥）
 * 兼容新版 Vue 前端：DOM widget 显式 computeSize，避免 0 高度不可见
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const COMFY_CLASS = "ComfyTranslateNode";

const MODEL_INFO = {
  deepseek: { label: "DeepSeek-V4-Flash", keyStorage: "ctn_key_deepseek", regUrl: "https://platform.deepseek.com/api_keys" },
  glm: { label: "GLM-5.3-Flash", keyStorage: "ctn_key_glm", regUrl: "https://open.bigmodel.cn/usercenter/apikeys" },
  local: { label: "本地 Qwen3.5-9B", local: true },
};

// 本地模型空闲释放设置（秒）：0=每次翻译后立即释放，-1=不自动释放
function localIdleSeconds() {
  const v = localStorage.getItem("ctn_local_idle");
  if (v === null) return 180;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 180;
}

const NODE_W = 480;    // 节点最小宽（左右双框布局）
const BOX_MIN_H = 150; // 文本框初始固定高度
const BOX_MAX_H = 600; // 高度上限，超出后框内滚动
const HEADER_H = 80;   // 节点标题 + 输入输出接口区高度

// ---------------- API key 混淆存取（XOR+Base64，防误览；非加密）----------------
const CTN_OBF_PREFIX = "obf1:";
const CTN_OBF_KEY = "ComfyTranslateNode@local";
function ctnObf(plain) {
  const data = new TextEncoder().encode(plain);
  const k = new TextEncoder().encode(CTN_OBF_KEY);
  let bin = "";
  data.forEach((b, i) => { bin += String.fromCharCode(b ^ k[i % k.length]); });
  return CTN_OBF_PREFIX + btoa(bin);
}
function ctnDeobf(stored) {
  if (!stored.startsWith(CTN_OBF_PREFIX)) return null; // 旧明文（未混淆）
  const bin = atob(stored.slice(CTN_OBF_PREFIX.length));
  const k = new TextEncoder().encode(CTN_OBF_KEY);
  const bytes = new Uint8Array([...bin].map((c, i) => c.charCodeAt(0) ^ k[i % k.length]));
  return new TextDecoder().decode(bytes);
}
function keySave(provider, key) {
  try { localStorage.setItem(MODEL_INFO[provider].keyStorage, key ? ctnObf(key) : ""); }
  catch (e) { localStorage.setItem(MODEL_INFO[provider].keyStorage, key); }
}
function keyLoad(provider) {
  const raw = localStorage.getItem(MODEL_INFO[provider].keyStorage) || "";
  if (!raw) return "";
  try {
    const s = ctnDeobf(raw);
    if (s !== null) return s;
  } catch (e) {}
  // 旧明文密钥：读取时自动迁移为混淆存储
  try { localStorage.setItem(MODEL_INFO[provider].keyStorage, ctnObf(raw)); } catch (e) {}
  return raw;
}

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
.ctn-input-wrap { flex:1 1 0; min-width:0; position:relative; display:flex; }
.ctn-clear {
  position:absolute; right:8px; bottom:8px; width:22px; height:22px;
  border:none; border-radius:50%; cursor:pointer;
  background:#e05656; color:#fff; font-size:12px; line-height:1;
  display:flex; align-items:center; justify-content:center; opacity:.7;
  transition:opacity .15s;
}
.ctn-clear:hover { opacity:1; }
.ctn-clear.ctn-hide { display:none; }
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
.ctn-sendbtn {
  height:28px; width:100%; padding:0; border:none; border-radius:6px; cursor:pointer;
  display:flex; align-items:center; justify-content:center; gap:4px;
  background:#b8770e; color:#fff; font-size:12px;
}
.ctn-sendbtn:hover:not(:disabled) { filter:brightness(1.15); }
.ctn-sendbtn:disabled { background:#2a2a2a; color:#666; cursor:not-allowed; }
.ctn-sendbtn svg { flex:0 0 auto; }

/* 发送目标选择弹窗（多透传节点时） */
#ctn-send-overlay {
  position:fixed; inset:0; z-index:99999; background:rgba(0,0,0,.55);
  display:flex; align-items:center; justify-content:center;
}
.ctn-send-panel {
  width:320px; background:var(--comfy-menu-bg, #1e1e1e); color:var(--input-text, #ddd);
  border:1px solid var(--border-color, #444); border-radius:10px;
  padding:14px; display:flex; flex-direction:column; gap:8px;
  box-shadow:0 8px 32px rgba(0,0,0,.5);
}
.ctn-send-panel .ctn-title { font-size:14px; font-weight:600; text-align:center; }
.ctn-send-item {
  padding:8px 10px; border:1px solid var(--border-color, #444); border-radius:6px;
  cursor:pointer; font-size:13px; background:#2c2c2c; color:var(--input-text, #ddd);
  text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.ctn-send-item:hover { background:#3a3a3a; border-color:#b8770e; }
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
.ctn-keyrow { display:flex; gap:6px; }
.ctn-keyrow input { flex:1; }
.ctn-keyrow #ctn-eye {
  flex:0 0 38px; border:1px solid var(--border-color,#444); border-radius:6px;
  background:#2c2c2c; color:var(--input-text,#ddd); cursor:pointer; font-size:14px;
}
.ctn-keyrow #ctn-eye:hover { background:#3a3a3a; }
.ctn-getapi { font-size:12px; color:#999; }
.ctn-getapi a { color:#7ab8ff; text-decoration:none; }
.ctn-getapi a:hover { text-decoration:underline; }
.ctn-localbox { display:flex; flex-direction:column; gap:8px; }
.ctn-note {
  font-size:12px; line-height:1.55; color:#d8a84e;
  background:rgba(216,168,78,.08); border:1px solid rgba(216,168,78,.35);
  border-radius:6px; padding:8px 10px;
}
.ctn-note b { color:#e8bc63; }
.ctn-localbox select {
  background:var(--comfy-input-bg,#232323); color:var(--input-text,#ddd);
  border:1px solid var(--border-color,#444); border-radius:6px; padding:5px 8px; font-size:12px;
}
.ctn-lstatus { color:#7ab8ff; font-size:12px; }
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
        <button data-m="local" class="${selected === "local" ? "ctn-active" : ""}">本地 Qwen</button>
      </div>
      <div class="ctn-line ctn-line-row" style="display:flex; align-items:center; justify-content:space-between;">
        <span>接收上游文本（text 输入）</span>
        <button id="ctn-accept" class="${node.properties.ctn_accept_input === false ? "" : "ctn-active"}" style="flex:0 0 60px;">${node.properties.ctn_accept_input === false ? "关闭" : "开启"}</button>
      </div>
      <div id="ctn-keybox">
        <div class="ctn-line">API 密钥（<span id="ctn-key-label">${MODEL_INFO[selected].label}</span>）：</div>
        <div class="ctn-keyrow">
          <input id="ctn-key" type="password" placeholder="粘贴 API 密钥…" autocomplete="off">
          <button id="ctn-eye" type="button" title="显示/隐藏密钥">👁</button>
        </div>
        <div id="ctn-getapi" class="ctn-getapi" style="display:none"></div>
      </div>
      <div id="ctn-localbox" class="ctn-localbox" style="display:none">
        <div class="ctn-note">
          ⚠️ 本地模型<b>全 GPU 加载，约占 5.6GB 显存</b>。请在<b>跑图前或跑图后</b>使用翻译；
          若需与出图并行，请先点下方「立即释放显存」。
        </div>
        <div class="ctn-line" style="display:flex; align-items:center; justify-content:space-between;">
          <span>翻译完成后</span>
          <select id="ctn-idle">
            <option value="0">立即释放显存</option>
            <option value="60">空闲 1 分钟释放</option>
            <option value="180">空闲 3 分钟释放</option>
            <option value="600">空闲 10 分钟释放</option>
            <option value="-1">不自动释放</option>
          </select>
        </div>
        <div class="ctn-line" style="display:flex; align-items:center; justify-content:space-between;">
          <span>运行工作流前自动释放</span>
          <button id="ctn-autoqueue" style="flex:0 0 60px;">开启</button>
        </div>
        <div class="ctn-line">状态：<span class="ctn-lstatus" id="ctn-lstatus">查询中…</span></div>
        <div class="ctn-row">
          <button id="ctn-release">立即释放显存</button>
          <button id="ctn-lrefresh">刷新状态</button>
        </div>
      </div>
      <div class="ctn-row">
        <button id="ctn-ok" class="ctn-ok">确认</button>
        <button id="ctn-cancel">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const keyInput = overlay.querySelector("#ctn-key");
  const curLabel = overlay.querySelector("#ctn-cur");
  const keyLabel = overlay.querySelector("#ctn-key-label");
  const keyBox = overlay.querySelector("#ctn-keybox");
  const localBox = overlay.querySelector("#ctn-localbox");

  // 密钥为空时显示"前往获取"链接（随模型切换）
  const getApi = overlay.querySelector("#ctn-getapi");
  const renderGetApi = () => {
    if (MODEL_INFO[selected].local) return;
    const has = !!keyInput.value.trim();
    getApi.style.display = has ? "none" : "block";
    getApi.innerHTML = "还没有 API？<a href='" + MODEL_INFO[selected].regUrl + "' target='_blank' rel='noopener'>点此前往获取 →</a>";
    keyInput.placeholder = selected === "glm" ? "粘贴智谱 API 密钥…" : "粘贴 sk-... 密钥…";
  };
  keyInput.addEventListener("input", renderGetApi);
  overlay.querySelector("#ctn-eye").addEventListener("click", () => {
    keyInput.type = keyInput.type === "password" ? "text" : "password";
  });

  // ---- 本地模型设置区 ----
  const lStatus = overlay.querySelector("#ctn-lstatus");
  const idleSel = overlay.querySelector("#ctn-idle");
  idleSel.value = String(localIdleSeconds());
  idleSel.addEventListener("change", () => localStorage.setItem("ctn_local_idle", idleSel.value));
  const autoBtn = overlay.querySelector("#ctn-autoqueue");
  const renderAuto = () => {
    const on = localStorage.getItem("ctn_auto_release_queue") !== "0";
    autoBtn.textContent = on ? "开启" : "关闭";
    autoBtn.classList.toggle("ctn-active", on);
  };
  autoBtn.addEventListener("click", () => {
    const on = localStorage.getItem("ctn_auto_release_queue") !== "0";
    localStorage.setItem("ctn_auto_release_queue", on ? "0" : "1");
    renderAuto();
  });
  renderAuto();

  let localTimer = null;
  const stopLocalPoll = () => { if (localTimer) { clearInterval(localTimer); localTimer = null; } };
  const refreshLocalStatus = async () => {
    if (selected !== "local") return;
    try {
      const r = await api.fetchApi("/ctn/local/status");
      const st = await r.json();
      if (st.error) { lStatus.textContent = "查询失败：" + st.error; return; }
      if (!st.model_exists) { lStatus.textContent = "未找到模型文件"; return; }
      if (st.loading) { lStatus.textContent = "加载中…"; return; }
      if (st.loaded) {
        let tail;
        if (st.idle_seconds === 0) tail = "，每次翻译后自动释放";
        else if (st.idle_seconds < 0) tail = "，不自动释放";
        else {
          const s = st.idle_remaining ?? 0;
          tail = "，空闲 " + (s >= 60 ? Math.ceil(s / 60) + " 分钟" : s + " 秒") + "后自动释放";
        }
        lStatus.textContent = "已加载（约 5.6GB 显存" + tail + "）";
      } else {
        lStatus.textContent = "未加载（下次翻译自动加载，约 4 秒）";
      }
    } catch (e) { lStatus.textContent = "查询失败"; }
  };
  const startLocalPoll = () => { refreshLocalStatus(); if (!localTimer) localTimer = setInterval(refreshLocalStatus, 2000); };
  overlay.querySelector("#ctn-lrefresh").addEventListener("click", refreshLocalStatus);
  overlay.querySelector("#ctn-release").addEventListener("click", async () => {
    lStatus.textContent = "释放中…";
    try { await api.fetchApi("/ctn/local/unload", { method: "POST" }); } catch (e) {}
    refreshLocalStatus();
  });

  // 接收上游文本开关（关闭 = 相当于断开 text 输入接口，queue 时不会拉起上游）
  let acceptInput = node.properties.ctn_accept_input !== false;
  const acceptBtn = overlay.querySelector("#ctn-accept");
  const renderAccept = () => {
    acceptBtn.textContent = acceptInput ? "开启" : "关闭";
    acceptBtn.classList.toggle("ctn-active", acceptInput);
  };
  acceptBtn.addEventListener("click", () => { acceptInput = !acceptInput; renderAccept(); });
  renderAccept();

  // 模型区渲染：本地模型时隐藏密钥区、显示本地设置区
  const renderModelUI = () => {
    const isLocal = !!MODEL_INFO[selected].local;
    curLabel.textContent = MODEL_INFO[selected].label;
    keyBox.style.display = isLocal ? "none" : "block";
    localBox.style.display = isLocal ? "flex" : "none";
    if (isLocal) {
      startLocalPoll();
    } else {
      stopLocalPoll();
      keyLabel.textContent = MODEL_INFO[selected].label;
      keyInput.value = keyLoad(selected);
      renderGetApi();
    }
  };

  // 切换模型：高亮 + 同步显示对应模型的已存密钥
  overlay.querySelectorAll("button[data-m]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selected = btn.dataset.m;
      overlay.querySelectorAll("button[data-m]").forEach((b) =>
        b.classList.toggle("ctn-active", b === btn)
      );
      renderModelUI();
    });
  });
  renderModelUI();

  const onEsc = (e) => { if (e.key === "Escape") close(); };
  const close = () => { overlay.remove(); stopLocalPoll(); document.removeEventListener("keydown", onEsc); };
  overlay.querySelector("#ctn-cancel").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onEsc);

  // 确认：保存密钥 + 切换模型
  overlay.querySelector("#ctn-ok").addEventListener("click", () => {
    if (!MODEL_INFO[selected].local) keySave(selected, keyInput.value.trim());
    node.properties.translate_model = selected;
    node.properties.ctn_accept_input = acceptInput;
    close();
  });
}

// ---------------- 节点 UI 构建 ----------------
function buildUI(node) {
  const el = document.createElement("div");
  el.className = "ctn-ui";
  el.innerHTML = `
    <div class="ctn-boxes">
      <div class="ctn-input-wrap">
        <textarea class="ctn-input" placeholder="输入原文（自动识别语言：非中文→译为中文，中文→译为英文）"></textarea>
        <button class="ctn-clear ctn-hide" title="清空左侧文本">✕</button>
      </div>
      <div class="ctn-mid">
        <button class="ctn-btn ctn-go">翻译</button>
        <div class="ctn-mid-row">
          <button class="ctn-gear" title="设置：切换模型 / 填写 API 密钥">⚙️</button>
          <button class="ctn-btn-copy ctn-copy" title="复制译文">复制</button>
        </div>
        <button class="ctn-swap ctn-swapbtn" title="把右侧译文换到左侧输入框（两边内容互换）" disabled>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 20V6"/><path d="M3 10l4-4 4 4"/><path d="M17 4v14"/><path d="M13 14l4 4 4-4"/></svg>互换
        </button>
        <button class="ctn-sendbtn" title="把右侧译文发送到「文本（透传）」节点（保留其提示词段）" disabled>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h14"/><path d="M12 6l6 6-6 6"/></svg>发送
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
  const sendBtn = el.querySelector(".ctn-sendbtn");
  const clearBtn = el.querySelector(".ctn-clear");

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
    // 清空按钮：左框有内容才显示（所有内容变动都会经过 sync，一处联动全覆盖）
    clearBtn.classList.toggle("ctn-hide", !inputEl.value);
  };
  node.ctn.sync = sync;

  // 一键清空左侧文本
  clearBtn.addEventListener("click", () => {
    inputEl.value = "";
    node.properties.ctn_input = "";
    sync();
  });

  // 互换/发送按钮状态：右侧（译文）为空时灰禁
  const updateSwapState = () => {
    const has = !!outputEl.value.trim();
    swapBtn.disabled = !has;
    sendBtn.disabled = !has;
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
  const ro = new ResizeObserver(() => sync());
  ro.observe(el);
  node.ctn.ro = ro; // 节点删除时 disconnect，防监听泄漏

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
    const isLocal = provider === "local";
    let apiKey = "";
    if (!isLocal) {
      apiKey = keyLoad(provider);
      if (!apiKey) {
        const info = MODEL_INFO[provider];
        statusEl.innerHTML = "未填 " + info.label + " 的 API 密钥，<a href='" + info.regUrl +
          "' target='_blank' rel='noopener'>点此前往获取</a>，或点 ⚙️ 设置填写";
        statusEl.className = "ctn-status err";
        return;
      }
    }

    goBtn.disabled = true;
    goBtn.textContent = "翻译中…";
    if (isLocal) {
      statusEl.textContent = "本地模型加载/推理中…";
      statusEl.className = "ctn-status";
    }
    const t0 = performance.now();
    try {
      const body = { provider, text };
      if (isLocal) body.idle_seconds = localIdleSeconds();
      else body.api_key = apiKey;
      const resp = await api.fetchApi("/ctn/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (data.error) {
        statusEl.textContent = data.error;
        statusEl.className = "ctn-status err";
      } else {
        outputEl.value = data.translated;
        node.properties.ctn_output = data.translated;
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        statusEl.textContent = `✓ ${MODEL_INFO[provider].label}` + (isLocal ? `（${secs}s）` : "");
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

  // ── 发送：译文 → 「文本（透传）」节点（保留其提示词段）──
  function sendToTarget(ptNode, translation) {
    // 模式检查：Use Input 模式下写入的 prompt_text 不会被下游使用
    const uw = ptNode.widgets?.find((w) => w.name === "use_input_text");
    if (uw && uw.value) {
      statusEl.textContent = "透传节点处于 📥 输入 模式，请先在其工具栏点 📝 内容 再发送";
      statusEl.className = "ctn-status err";
      return;
    }
    // 找到插件标签编辑器的 textarea（数据源），排除中文转 tag 的 chipInput
    const uiw = ptNode.widgets?.find((w) => w.name === "db_pt_ui");
    const tas = (uiw?.element || ptNode.widgets?.find((w) => w.element?.querySelector?.("textarea"))?.element || {}).querySelectorAll?.("textarea") || [];
    let ta = null;
    tas.forEach((t) => { if (!ta && !(t.placeholder || "").includes("英文tag")) ta = t; });
    if (!ta) {
      statusEl.textContent = "未找到透传节点的编辑器，插件版本可能不兼容";
      statusEl.className = "ctn-status err";
      return;
    }
    // 契约（单换行制）：第 1 行 = 提示词行，保留；第 2 行起 = 内容行，整体替换为译文。
    // 与上游（反推工作流）回传的天然形态一致："提示词 + 单换行 + 句子"。
    // 目标只有 1 行（无内容行）→ 追加；目标为空 → 直接写入译文。
    const lines = ta.value.replace(/^\s+|\s+$/g, "").split("\n");
    const first = lines[0] || "";
    let next, note;
    if (!first.trim()) { next = translation; note = "目标为空，已写入译文"; }
    else if (lines.length === 1) { next = first + "\n" + translation; note = "未检测到内容行，已追加"; }
    else { next = first + "\n" + translation; note = "已发送，提示词行已保留"; }
    // 只改编辑器数据源，派发 input 让插件自己的 syncWidget 完成全部回写
    ta.value = next;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    statusEl.textContent = "✓ " + note;
    statusEl.className = "ctn-status ok";
  }

  // 多目标时弹窗选择
  function openSendPicker(targets, translation) {
    const ov = document.createElement("div");
    ov.id = "ctn-send-overlay";
    const panel = document.createElement("div");
    panel.className = "ctn-send-panel";
    panel.innerHTML = `<div class="ctn-title">选择要发送到的透传节点</div>`;
    targets.forEach((t) => {
      const b = document.createElement("button");
      b.className = "ctn-send-item";
      b.textContent = (t.title || "文本（透传）") + "  #" + t.id;
      b.addEventListener("click", () => { ov.remove(); sendToTarget(t, translation); });
      panel.appendChild(b);
    });
    const cancel = document.createElement("button");
    cancel.className = "ctn-send-item";
    cancel.textContent = "取消";
    cancel.style.textAlign = "center";
    cancel.addEventListener("click", () => ov.remove());
    panel.appendChild(cancel);
    ov.appendChild(panel);
    document.body.appendChild(ov);
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.remove(); });
  }

  sendBtn.addEventListener("click", () => {
    if (sendBtn.disabled) return;
    const translation = outputEl.value.trim();
    if (!translation) return;
    const graph = app.graph;
    const all = graph?._nodes || graph?.nodes || [];
    const targets = all.filter((n) => n.type === "DanbooruTextPassthrough");
    if (!targets.length) {
      statusEl.textContent = "画布上没有「文本（透传）」节点";
      statusEl.className = "ctn-status err";
      return;
    }
    if (targets.length === 1) sendToTarget(targets[0], translation);
    else openSendPicker(targets, translation);
  });

  // 初始尺寸：宽度固定起步，高度 = 头部 + 初始框高 + 状态栏
  if (node.size[0] < NODE_W) node.size[0] = NODE_W;
  const minTotal = HEADER_H + BOX_MIN_H + 30;
  if (node.size[1] < minTotal) node.size[1] = minTotal;
}

// ---------------- queue 前输入断开（方案 A + 手动开关）----------------
function ctnDetachInputLinksIfNeeded() {
  try {
    const nodes = app.graph?._nodes || app.graph?.nodes || [];
    const tnNodes = nodes.filter((n) => n.type === "ComfyTranslateNode");
    if (!tnNodes.length) return () => {};
    const ptNodes = nodes.filter((n) => n.type === "DanbooruTextPassthrough");
    const anyContent = ptNodes.some((p) => {
      const uw = p.widgets?.find((w) => w.name === "use_input_text");
      return uw ? uw.value === false : false;
    });
    const needDetach =
      tnNodes.some((n) => n.properties.ctn_accept_input === false) || anyContent;
    if (!needDetach) return () => {};
    const saved = [];
    tnNodes.forEach((n) => {
      (n.inputs || []).forEach((inp, i) => {
        if (inp.name === "text" && inp.link != null) {
          saved.push({ node: n, slot: i, link: inp.link });
          inp.link = null; // 临时断开：提交的执行图里不再依赖上游
        }
      });
    });
    if (!saved.length) return () => {};
    return () => {
      saved.forEach((s2) => {
        try { s2.node.inputs[s2.slot].link = s2.link; } catch (e) {}
      });
      app.canvas?.setDirty?.(true, true);
    };
  } catch (e) {
    console.error("[TranslateNode] detach failed:", e);
    return () => {};
  }
}

// ---------------- queue 前释放本地模型显存 ----------------
// 本地模型全 GPU 加载约占 5.6GB 显存；提交工作流前主动释放，避免与出图争抢显存。
// 可在设置面板关闭该行为（ctn_auto_release_queue = "0"）。未加载时该请求为空操作。
async function ctnReleaseLocalModelIfNeeded() {
  try {
    if (localStorage.getItem("ctn_auto_release_queue") === "0") return;
    await api.fetchApi("/ctn/local/unload", { method: "POST" });
  } catch (e) { /* 释放失败不阻断队列提交 */ }
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
        if (this.properties.ctn_accept_input === undefined) this.properties.ctn_accept_input = true;
        buildUI(this);
      } catch (e) {
        console.error("[TranslateNode] UI 构建失败:", e);
        this.title += " ⚠️UI错误";
      }
      return r;
    };

    // 节点移除：断开 ResizeObserver，防 DOM 引用泄漏
    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      const r = onRemoved?.apply(this, arguments);
      this.ctn?.ro?.disconnect();
      this.ctn = null;
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

  // ── queue 前动态断开 text 输入（方案 A + 手动开关）──
  // 断开条件（任一满足）：
  //   a. 节点开关关闭（设置面板"接收上游文本"= 关闭）
  //   b. 画布上任一「文本(透传)」节点处于 📝 内容 模式
  // 断开仅在提交序列化瞬间生效，提交后立即原样恢复，画布连线视觉不变。
  async setup() {
    if (!app.queuePrompt) return;
    const origQueuePrompt = app.queuePrompt.bind(app);
    app.queuePrompt = async function (...args) {
      const restore = ctnDetachInputLinksIfNeeded();
      try {
        // 本地模型已加载时先释放显存，再提交工作流（可在设置中关闭）
        await ctnReleaseLocalModelIfNeeded();
        return await origQueuePrompt(...args);
      } finally {
        restore();
      }
    };
  },
});
