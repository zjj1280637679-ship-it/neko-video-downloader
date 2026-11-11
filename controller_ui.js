/* Visual client for browser_controller.py. Tokens travel only in the auth frame. */
"use strict";
const canvas = document.getElementById("screenCanvas");
const ctx = canvas.getContext("2d");
const urlInput = document.getElementById("urlInput");
const tabSelect = document.getElementById("tabSelect");
const connStatus = document.getElementById("connStatus");
const detailStatus = document.getElementById("detailStatus");
const loadingTip = document.getElementById("loadingTip");
const tokenDialog = document.getElementById("tokenDialog");
const tokenInput = document.getElementById("tokenInput");
let ws, reconnectTimer, attempts = 0, nextId = 1, targetId = null;
let requestedTargetId = null, selectionRequestId = null, confirmedSelectionId = 0, candidateFrame = null;
let ready = false, authFailed = false, closing = false, frameSequence = 0;
let naturalWidth = 1280, naturalHeight = 800;
const pending = new Map();
let token = "";
try { token = sessionStorage.getItem("nekoControllerToken") || ""; } catch (_) {}

function status(message) { connStatus.textContent = message; }
function showError(error) { detailStatus.textContent = error.message || String(error); }
function send(data) {
  if (!ready || !ws || ws.readyState !== WebSocket.OPEN) throw new Error("控制台尚未连接");
  ws.send(JSON.stringify(data));
}
function cdp(method, params = {}, commandTargetId = targetId) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    try {
      send({ action: "cdp", id, targetId: commandTargetId, method, params, timeout: 15 });
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("命令超时，请检查浏览器状态后再重试"));
      }, 17000);
      pending.set(id, { resolve, reject, timer });
    } catch (error) { reject(error); }
  });
}
function input(method, params) { if (targetId && ready) cdp(method, params).catch(showError); }
function selectTarget(id) {
  if (!id) return;
  requestedTargetId = id;
  selectionRequestId = nextId++;
  candidateFrame = null;
  status(targetId ? "正在切换标签页 · 当前画面仍可操作" : "正在连接标签页画面…");
  if (!targetId) {
    loadingTip.style.display = "block";
    loadingTip.textContent = "正在连接标签页画面…";
  }
  send({ action: "select", id: selectionRequestId, targetId: id });
}
function updateSelectedTab() {
  tabSelect.value = targetId || "";
  const option = [...tabSelect.options].find(item => item.value === targetId);
  if (document.activeElement !== urlInput) urlInput.value = option?.dataset.url || "";
}
function renderFrame(msg) {
  const sequence = ++frameSequence;
  const img = new Image();
  img.onload = () => {
    if (sequence !== frameSequence) return;
    canvas.width = img.width;
    canvas.height = img.height;
    naturalWidth = msg.metadata?.deviceWidth || img.width;
    naturalHeight = msg.metadata?.deviceHeight || img.height;
    ctx.drawImage(img, 0, 0);
    loadingTip.style.display = "none";
  };
  img.src = "data:image/jpeg;base64," + msg.data;
}
function renderTabs(tabs) {
  const previous = targetId;
  const desired = requestedTargetId;
  tabSelect.replaceChildren();
  for (const tab of tabs) {
    const option = document.createElement("option");
    option.value = tab.id;
    option.textContent = tab.title || tab.url || tab.id;
    option.dataset.url = tab.url || "";
    tabSelect.append(option);
  }
  if (!tabs.some(tab => tab.id === previous)) {
    targetId = null;
    ++frameSequence;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  const nextTarget = tabs.find(tab => tab.id === desired) || tabs.find(tab => tab.id === previous) || tabs[0];
  if (nextTarget) {
    updateSelectedTab();
    selectTarget(nextTarget.id);
  } else {
    requestedTargetId = selectionRequestId = candidateFrame = null;
    status("浏览器已连接 · 没有可用标签页");
    loadingTip.style.display = "block";
    loadingTip.textContent = "在浏览器中打开一个标签页，然后点击“标签页 ↻”。";
  }
}
function connect() {
  clearTimeout(reconnectTimer);
  if (ws) { ws.onclose = null; ws.close(); }
  ready = false;
  status("正在连接…");
  ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ action: "auth", token }));
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.type === "ready") {
      ready = true;
      attempts = 0;
      authFailed = false;
      status("浏览器已连接");
      renderTabs(msg.tabs);
    } else if (msg.type === "tabs") {
      renderTabs(msg.tabs);
    } else if (msg.type === "selected") {
      if (msg.id < confirmedSelectionId) return;
      confirmedSelectionId = msg.id;
      if (targetId !== msg.targetId) {
        ++frameSequence;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        loadingTip.style.display = "block";
      }
      targetId = msg.targetId;
      if (msg.id === selectionRequestId) requestedTargetId = selectionRequestId = null;
      updateSelectedTab();
      if (candidateFrame?.targetId === targetId) {
        renderFrame(candidateFrame);
        candidateFrame = null;
      }
      status(requestedTargetId ? "正在切换标签页 · 当前画面仍可操作" : "已连接 · 实时画面传输中");
      detailStatus.textContent = "当前标签页已就绪";
    } else if (msg.type === "frame") {
      if (msg.targetId === targetId) renderFrame(msg);
      else if (msg.targetId === requestedTargetId) candidateFrame = msg;
    } else if (msg.type === "urlUpdate") {
      if (msg.targetId !== targetId) return;
      if (document.activeElement !== urlInput) urlInput.value = msg.url;
    } else if (msg.type === "response") {
      if (msg.action === "select") {
        if (msg.id !== selectionRequestId) return;
        requestedTargetId = selectionRequestId = candidateFrame = null;
        updateSelectedTab();
        showError(msg.error || { message: "标签页选择失败" });
        status(targetId ? "切换失败 · 当前标签页仍可操作" : "标签页选择失败");
        if (!targetId) loadingTip.textContent = "无法连接所选标签页，请刷新列表后重试。";
        // A confirmed selection may have reached the server just before a newer
        // request. Restore that stream if this client missed its confirmation.
        if (msg.selectedTargetId && msg.selectedTargetId !== targetId) selectTarget(msg.selectedTargetId);
        return;
      }
      const item = pending.get(msg.id);
      if (item) {
        clearTimeout(item.timer);
        pending.delete(msg.id);
        msg.ok ? item.resolve(msg.result) : item.reject(new Error(msg.error?.message || "命令失败"));
      } else if (!msg.ok) showError(msg.error || { message: "命令失败" });
    } else if (msg.type === "error") {
      if (msg.targetId && msg.targetId !== targetId) return;
      showError(msg.error);
      if (msg.error?.code === "unauthorized") {
        authFailed = true;
        status("请输入调用令牌");
        if (!tokenDialog.open) tokenDialog.showModal();
      } else if (msg.error?.code === "disconnected") {
        status("标签页已断开 · 请刷新标签页");
      }
    }
  };
  ws.onclose = () => {
    ready = false;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("连接已断开，命令可能已经执行"));
    }
    pending.clear();
    if (!closing && !authFailed) {
      status("连接已断开 · 正在重连…");
      reconnectTimer = setTimeout(connect, Math.min(5000, 500 * 2 ** attempts++));
    }
  };
  ws.onerror = () => showError(new Error("控制台连接失败，请检查启动窗口"));
}

document.getElementById("connectButton").addEventListener("click", () => {
  tokenInput.value = token;
  tokenDialog.showModal();
});
document.getElementById("tokenForm").addEventListener("submit", event => {
  event.preventDefault();
  token = tokenInput.value;
  try { sessionStorage.setItem("nekoControllerToken", token); } catch (_) {}
  tokenInput.value = "";
  tokenDialog.close();
  authFailed = false;
  connect();
});
document.getElementById("refreshTabs").addEventListener("click", () => {
  try { send({ action: "tabs" }); } catch (error) { showError(error); }
});
tabSelect.addEventListener("change", () => {
  try { selectTarget(tabSelect.value); } catch (error) { showError(error); }
});

function coords(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: Math.round((event.clientX - rect.left) * naturalWidth / rect.width),
           y: Math.round((event.clientY - rect.top) * naturalHeight / rect.height) };
}
function modifiers(event) {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}
canvas.addEventListener("contextmenu", event => event.preventDefault());
for (const [name, type] of [["mousedown", "mousePressed"], ["mouseup", "mouseReleased"]]) {
  canvas.addEventListener(name, event => {
    event.preventDefault();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    input("Input.dispatchMouseEvent", { type, ...coords(event), button: ["left", "middle", "right"][event.button] || "none", clickCount: event.detail || 1, modifiers: modifiers(event) });
  });
}
let lastMove = 0;
canvas.addEventListener("mousemove", event => {
  if (performance.now() - lastMove < 35) return;
  lastMove = performance.now();
  input("Input.dispatchMouseEvent", { type: "mouseMoved", ...coords(event), buttons: event.buttons, modifiers: modifiers(event) });
});
canvas.addEventListener("wheel", event => {
  event.preventDefault();
  input("Input.dispatchMouseEvent", { type: "mouseWheel", ...coords(event), deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiers(event) });
}, { passive: false });
function isEditing() {
  return tokenDialog.open || document.activeElement?.matches("input, textarea, select, button, [contenteditable]");
}
window.addEventListener("keydown", event => {
  if (isEditing() || !ready || !targetId) return;
  event.preventDefault();
  const text = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey ? event.key : undefined;
  input("Input.dispatchKeyEvent", { type: "keyDown", key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, modifiers: modifiers(event), text });
});
window.addEventListener("keyup", event => {
  if (isEditing() || !ready || !targetId) return;
  event.preventDefault();
  input("Input.dispatchKeyEvent", { type: "keyUp", key: event.key, code: event.code, windowsVirtualKeyCode: event.keyCode, modifiers: modifiers(event) });
});
function navigate() {
  let url = urlInput.value.trim();
  if (!url) return;
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url)) url = "https://" + url;
  cdp("Page.navigate", { url }).then(result => { if (result.errorText) throw new Error(result.errorText); }).catch(showError);
}
document.getElementById("btnGo").addEventListener("click", navigate);
urlInput.addEventListener("keydown", event => { if (event.key === "Enter") navigate(); });
document.getElementById("btnReload").addEventListener("click", () => cdp("Page.reload").catch(showError));
for (const [id, delta] of [["btnBack", -1], ["btnForward", 1]]) {
  document.getElementById(id).addEventListener("click", async () => {
    try {
      const historyTargetId = targetId;
      const history = await cdp("Page.getNavigationHistory", {}, historyTargetId);
      const entry = history.entries[history.currentIndex + delta];
      if (entry) await cdp("Page.navigateToHistoryEntry", { entryId: entry.id }, historyTargetId);
    } catch (error) { showError(error); }
  });
}
window.addEventListener("beforeunload", () => { closing = true; clearTimeout(reconnectTimer); ws?.close(); });
connect();
