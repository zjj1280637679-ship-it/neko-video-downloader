import asyncio
import aiohttp
from aiohttp import web
import json
import subprocess
import os
import sys

CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
EXT_PATH = r"C:\Users\asus\.gemini\antigravity\scratch\cute-anime-video-downloader"
USER_DATA_DIR = r"C:\Users\asus\.gemini\antigravity\scratch\chrome-debug-profile"
CDP_PORT = 9222
WEB_PORT = 8899

chrome_process = None
cdp_ws = None
connected_clients = set()
current_page_id = None

HTML_PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🌸 网页浏览器云控制台 (Remote Browser Control)</title>
  <style>
    :root {
      --primary: #FF6B8B;
      --bg: #FFF8FA;
      --border: #FFD1DC;
      --text: #4A3E3D;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: #1E1E2E;
      color: #EEE;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      user-select: none;
    }
    /* 顶部导航条 */
    .toolbar {
      background: #252538;
      border-bottom: 1.5px solid #33334D;
      padding: 8px 14px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .logo {
      font-size: 15px;
      font-weight: 700;
      color: var(--primary);
      display: flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
    }
    .nav-btn {
      background: #36364F;
      border: 1px solid #484869;
      color: #FFF;
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 13px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.2s;
    }
    .nav-btn:hover { background: var(--primary); border-color: var(--primary); }
    .url-input {
      flex: 1;
      background: #181824;
      border: 1.5px solid #3E3E5E;
      border-radius: 8px;
      padding: 7px 12px;
      font-size: 13.5px;
      color: #FFF;
      outline: none;
      transition: border-color 0.2s;
    }
    .url-input:focus { border-color: var(--primary); }
    .status-tag {
      font-size: 11.5px;
      background: #2D3748;
      color: #A0AEC0;
      padding: 4px 10px;
      border-radius: 20px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #48BB78;
      box-shadow: 0 0 6px #48BB78;
    }
    /* 浏览器主视窗 */
    .main-view {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #12121C;
      overflow: hidden;
      position: relative;
    }
    #screenCanvas {
      max-width: 100%;
      max-height: 100%;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
      cursor: crosshair;
      border-radius: 4px;
      display: block;
    }
    .loading-tip {
      position: absolute;
      font-size: 14px;
      color: #A0AEC0;
      pointer-events: none;
    }
    /* 底部信息栏 */
    .footer {
      background: #181824;
      padding: 4px 14px;
      font-size: 11px;
      color: #718096;
      display: flex;
      justify-content: space-between;
      border-top: 1px solid #2D3748;
    }
    .footer a { color: var(--primary); text-decoration: none; }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="logo"><span>🌸</span> 喵喵云控制台</div>
    <button class="nav-btn" id="btnBack" title="后退">◀</button>
    <button class="nav-btn" id="btnForward" title="前进">▶</button>
    <button class="nav-btn" id="btnReload" title="刷新">🔄</button>
    <input type="text" class="url-input" id="urlInput" placeholder="输入网址并按回车..." value="https://www1.ikanbot.com/play/1027358">
    <button class="nav-btn" id="btnGo">前往 🚀</button>
    <div class="status-tag">
      <span class="status-dot"></span>
      <span id="connStatus">已连接浏览器</span>
    </div>
  </div>

  <div class="main-view" id="mainContainer">
    <div class="loading-tip" id="loadingTip">正在建立实时高清视频流通道喵... (◕ᴗ◕✿)</div>
    <canvas id="screenCanvas"></canvas>
  </div>

  <div class="footer">
    <span>💡 直接在上方画面中点击鼠标、输入文字、滚动滚轮即可直接操控真实 Chrome 浏览器！</span>
    <span>高级调试面板：<a href="http://127.0.0.1:9222" target="_blank">http://127.0.0.1:9222</a></span>
  </div>

  <script>
    const canvas = document.getElementById("screenCanvas");
    const ctx = canvas.getContext("2d");
    const urlInput = document.getElementById("urlInput");
    const btnGo = document.getElementById("btnGo");
    const btnBack = document.getElementById("btnBack");
    const btnForward = document.getElementById("btnForward");
    const btnReload = document.getElementById("btnReload");
    const connStatus = document.getElementById("connStatus");
    const loadingTip = document.getElementById("loadingTip");

    let naturalWidth = 1280;
    let naturalHeight = 720;

    // 连接 WebSocket
    const wsUrl = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
    let ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      connStatus.textContent = "已连接 · 实时画面传输中";
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "frame") {
        loadingTip.style.display = "none";
        const img = new Image();
        img.onload = () => {
          if (canvas.width !== img.width || canvas.height !== img.height) {
            canvas.width = img.width;
            canvas.height = img.height;
            naturalWidth = img.width;
            naturalHeight = img.height;
          }
          ctx.drawImage(img, 0, 0);
        };
        img.src = "data:image/jpeg;base64," + msg.data;
      } else if (msg.type === "urlUpdate") {
        urlInput.value = msg.url;
      }
    };

    ws.onclose = () => {
      connStatus.textContent = "连接已断开 (请刷新页面重试)";
    };

    // 坐标换算：Canvas 坐标 -> 真实浏览器窗口坐标
    function getCanvasCoords(e) {
      const rect = canvas.getBoundingClientRect();
      const scaleX = naturalWidth / rect.width;
      const scaleY = naturalHeight / rect.height;
      return {
        x: Math.round((e.clientX - rect.left) * scaleX),
        y: Math.round((e.clientY - rect.top) * scaleY)
      };
    }

    // 鼠标点击事件转发
    canvas.addEventListener("mousedown", (e) => {
      const { x, y } = getCanvasCoords(e);
      const button = e.button === 2 ? "right" : (e.button === 1 ? "middle" : "left");
      sendCDP("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 });
    });

    canvas.addEventListener("mouseup", (e) => {
      const { x, y } = getCanvasCoords(e);
      const button = e.button === 2 ? "right" : (e.button === 1 ? "middle" : "left");
      sendCDP("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
    });

    canvas.addEventListener("mousemove", (e) => {
      const { x, y } = getCanvasCoords(e);
      sendCDP("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    });

    // 鼠标滚轮事件转发
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const { x, y } = getCanvasCoords(e);
      sendCDP("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x, y,
        deltaX: e.deltaX,
        deltaY: e.deltaY
      });
    }, { passive: false });

    // 键盘事件转发
    window.addEventListener("keydown", (e) => {
      if (document.activeElement === urlInput) return;
      sendCDP("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: e.key,
        code: e.code,
        windowsVirtualKeyCode: e.keyCode
      });
      if (e.key.length === 1) {
        sendCDP("Input.dispatchKeyEvent", {
          type: "char",
          text: e.key
        });
      }
    });

    window.addEventListener("keyup", (e) => {
      if (document.activeElement === urlInput) return;
      sendCDP("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: e.key,
        code: e.code,
        windowsVirtualKeyCode: e.keyCode
      });
    });

    // 导航控制
    function navigateTo(url) {
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = "https://" + url;
      }
      sendCDP("Page.navigate", { url });
    }

    btnGo.addEventListener("click", () => navigateTo(urlInput.value));
    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") navigateTo(urlInput.value);
    });

    btnReload.addEventListener("click", () => sendCDP("Page.reload", {}));
    btnBack.addEventListener("click", () => {
      sendCDP("Runtime.evaluate", { expression: "window.history.back()" });
    });
    btnForward.addEventListener("click", () => {
      sendCDP("Runtime.evaluate", { expression: "window.history.forward()" });
    });

    function sendCDP(method, params) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: "cdp", method, params }));
      }
    }
  </script>
</body>
</html>
"""

async def index_handler(request):
    return web.Response(text=HTML_PAGE, content_type="text/html")

async def ws_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    connected_clients.add(ws)

    try:
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                data = json.loads(msg.data)
                if data.get("action") == "cdp" and cdp_ws and not cdp_ws.closed:
                    req_id = int(time.time() * 1000) % 1000000
                    payload = {
                        "id": req_id,
                        "method": data.get("method"),
                        "params": data.get("params", {})
                    }
                    await cdp_ws.send_str(json.dumps(payload))
    finally:
        connected_clients.discard(ws)

    return ws

def launch_chrome():
    os.makedirs(USER_DATA_DIR, exist_ok=True)
    cmd = [
        CHROME_PATH,
        f"--remote-debugging-port={CDP_PORT}",
        "--remote-allow-origins=*",
        f"--load-extension={EXT_PATH}",
        f"--user-data-dir={USER_DATA_DIR}",
        "--window-size=1280,800",
        "--new-window",
        "https://www1.ikanbot.com/play/1027358"
    ]
    print(f"🚀 正在拉起 Chrome（挂载喵喵视频插件与远程调试端口 {CDP_PORT}）...")
    return subprocess.Popen(cmd)

async def connect_cdp():
    global cdp_ws, current_page_id
    session = aiohttp.ClientSession()

    for _ in range(20):
        try:
            async with session.get(f"http://127.0.0.1:{CDP_PORT}/json") as resp:
                targets = await resp.json()
                # 寻找第一个正常的 page 页面
                page_target = next((t for t in targets if t.get("type") == "page" and "ikanbot" in t.get("url", "")), None)
                if not page_target:
                    page_target = next((t for t in targets if t.get("type") == "page"), None)
                
                if page_target and page_target.get("webSocketDebuggerUrl"):
                    ws_url = page_target["webSocketDebuggerUrl"]
                    current_page_id = page_target["id"]
                    print(f"🔗 成功对接目标网页 CDP: {page_target.get('title')}")
                    cdp_ws = await session.ws_connect(ws_url)
                    break
        except Exception:
            await asyncio.sleep(0.5)

    if not cdp_ws:
        print("❌ 未能连接到 Chrome CDP WebSocket，请检查 Chrome 是否启动")
        return

    # 启动 CDP Screencast 高清画面帧流
    await cdp_ws.send_str(json.dumps({
        "id": 1,
        "method": "Page.startScreencast",
        "params": {
            "format": "jpeg",
            "quality": 80,
            "maxWidth": 1280,
            "maxHeight": 800
        }
    }))

    # 监听 CDP 消息并广播给所有网页控制端
    async for msg in cdp_ws:
        if msg.type == aiohttp.WSMsgType.TEXT:
            data = json.loads(msg.data)
            method = data.get("method")
            if method == "Page.screencastFrame":
                session_id = data["params"]["sessionId"]
                frame_data = data["params"]["data"]
                
                # 确认收到帧，允许 Chrome 继续发下一帧
                ack = {"id": 2, "method": "Page.screencastFrameAck", "params": {"sessionId": session_id}}
                await cdp_ws.send_str(json.dumps(ack))

                # 广播给客户端
                for client in list(connected_clients):
                    if not client.closed:
                        await client.send_str(json.dumps({"type": "frame", "data": frame_data}))
            elif method == "Page.frameNavigated":
                url = data["params"]["frame"].get("url", "")
                for client in list(connected_clients):
                    if not client.closed:
                        await client.send_str(json.dumps({"type": "urlUpdate", "url": url}))

import time

async def main():
    launch_chrome()

    app = web.Application()
    app.router.add_get("/", index_handler)
    app.router.add_get("/ws", ws_handler)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", WEB_PORT)
    await site.start()

    print("\n" + "=" * 65)
    print("  🌸 浏览器远程可视化控制台已就绪！")
    print(f"  👉 专属控制链接: http://localhost:{WEB_PORT}")
    print(f"  👉 Chrome 原生 DevTools: http://localhost:{CDP_PORT}")
    print("  💡 打开上述链接即可在网页中直接看屏幕、点击、输入、操控浏览器！")
    print("=" * 65 + "\n")

    # 后台连接 CDP
    asyncio.create_task(connect_cdp())

    while True:
        await asyncio.sleep(3600)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n已退出控制器。")
