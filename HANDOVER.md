# ComfyUI AI 翻译节点 — 开发交接摘要

> 更新日期：2026-09-08 ｜ 仓库：https://github.com/BigTanDog/ComfyUI-Translate-Node（main @ `a572703`…`4feea9d` 已同步）
> 源码目录：`D:\WorkBuddy_text\ComfyUI-Translate-Node` ｜ 部署目录：`D:\ComfyUI-aki-v3.2\ComfyUI\custom_nodes\ComfyUI-Translate-Node`（与源码逐字节一致）

---

## 一、项目是什么

ComfyUI 自定义节点：双栏 AI 翻译节点（左=待翻译、右=译文），自动识别语言方向（非中文→中文，中文→英文）。支持 **DeepSeek-V4-Flash** 与 **GLM-5.3-Flash** 双模型，密钥用户自填。可与 Danbooru-Anima-Prompt 插件的「文本（透传）」节点联动（发送译文/接收反推文本）。

## 二、已完成功能（全部经无头浏览器/真实队列验证）

| 模块 | 说明 |
|---|---|
| 双栏 UI | 左右对称文本框（宽 480 起步、高度 150→600 自适应、双框等高），中列竖排按钮 |
| 翻译 | 后端路由 `/ctn/translate` 转发调用 AI API；状态栏显示进度/错误 |
| 互换 ⇅ | 左右内容互换（译文回到输入框继续迭代），右框空时灰禁 |
| 清空 ✕ | 红色悬浮按钮在输入框右下角，有内容才显示 |
| 复制 | 一键复制译文 |
| ⚙️ 设置 | 模型切换、API 密钥（👁 显隐、混淆存储、未填时显示平台注册链接）、接收开关 |
| 发送 ➤ | 译文写入「文本（透传）」节点：**第 1 行提示词保留，第 2 行起替换为译文**（单换行契约）；多目标弹窗选择 |
| text 输入接口 | STRING socket，接任意 STRING 上游；队列执行后经 `onExecuted` 回填左框（空文本不覆盖） |
| 模式联动 | 透传为「📝 内容」或开关关闭时，queue 提交前**动态断开** text 连线（提交后自动恢复），反推整条不执行、左框不被覆盖 |

## 三、当前状态

**无进行中任务**。v11（新手引导 + 密钥安全加固 + 安全走查）已验证并推送（`4feea9d`），用户实测确认无问题。

## 四、技术栈与关键约定（⚠️ 重要，改动前必读）

**运行环境**：aki 整合包（`D:\ComfyUI-aki-v3.2`），ComfyUI 前端为 **comfyui_frontend_package 1.49.6（Vue 渲染器）**，主实例端口 8188。

1. **架构**：前端 JS（`web/js/translate_ui.js`，addDOMWidget）+ Python 节点与路由（`translator_node.py`）。翻译走实时 HTTP，不经过队列。
2. **回传机制**：节点为 `OUTPUT_NODE`，`run()` 经 `ui.text` 回传 → 前端 `onExecuted` 填左框（空文本不覆盖）。
3. **queue 前动态断开**：包装 `app.queuePrompt`，提交瞬间临时置空 `input.link`（finally 恢复）。触发条件：任一透传为内容模式 **或** 节点开关关闭。
4. **格式契约**：透传文本 = `提示词行 + 单换行 + 内容行`；发送时保留第 1 行、其余替换为译文；目标无内容行则追加。
5. **密钥安全**：localStorage 混淆存储（`obf1:` 前缀，XOR+Base64），旧明文读取时自动迁移；**混淆≠加密**（前端应用本质限制），README 已如实标注。
6. **新版前端两大坑**（踩过实证）：`addDOMWidget` 的 type **必须非空字符串**（否则 widget 静默不渲染）；DOM widget 需显式 `computeSize`。
7. **已放弃的方案**：lazy 求值（OUTPUT_NODE + lazy 组合下执行器 PENDING 后不重新调度，日志实证）；前端序列化中 widget 值在 `widgets_values` 数组而非 `inputs[].value`（模式探测需两者兼容）。
8. **Danbooru 插件代码保持原版**：曾打过 `_ctnNormalize` 结构守护补丁，因与上游真实数据形态不符已**完整还原**（备份在 `D:\ComfyUI-aki-v3.2\plugin-backups-20260906\`，含 zip 与 patched.bak）。

**调试基建**：CDP 无头调试（`ws` + 本机 Chrome `--headless=new`），可复用脚本在 `C:\Users\Administrator\.workbuddy\binaries\node\workspace\`（`cdp_exp.mjs` 样板 / `e2e_final.mjs` 完整端到端 / `case2_precise.mjs` 精确 history 验证）。注意：localhost 请求需绕过 Clash 代理（`ProxyHandler({})`）；重复 queue 会命中执行缓存（输入需随机化）。

## 五、已知限制

- 翻译按钮为实时 HTTP 请求，不参与队列；内容模式下反推节点仍会随队列执行一次（数据不受影响，机制限制；需完全跳过可 Ctrl+B bypass 反推）
- 右侧 `text` 输出接口为直通占位，无独立功能
- 前端序列化兼容：模式探测已兼容 `inputs.value` 与 `widgets_values` 两种形状

## 六、下一步计划（候选，未排期）

1. 右侧 `text` 输出接口的实际功能（如译文直连出图链路）
2. 「执行工作流时自动翻译」模式（可选开关）
3. 多语言 UI / 更多模型接入（PROVIDERS 表加一行即可，前端同步）
4. 发布到 ComfyUI Registry / 打包发布流程
5. 若 Danbooru-Anima-Prompt 插件升级，需确认其 JS 结构变化是否影响「发送」的编辑器定位逻辑（`db_pt_ui` widget 内 textarea 选择器）

## 七、日常操作速查

- **改代码后生效**：前端 JS → 浏览器 Ctrl+F5；Python → 重启 ComfyUI
- **推送**：`git -C D:/WorkBuddy_text/ComfyUI-Translate-Node add -A && git commit && git push`（SSH 已配好）
- **部署同步**：改完 `cp` 源码文件到 custom_nodes 对应路径（保持工作区=部署版）
- **临时测试产物**：用完彻底删除（含回收站），用户明确要求
