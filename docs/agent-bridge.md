# 浏览器控制台与 Agent 调用

控制台和 Chrome 扩展可分别使用。扩展负责媒体发现、视频帧和下载；控制台把已开启调试的浏览器提供为 HTTP JSON / WebSocket 接口。`agent_cli.py` 使能执行命令行的 Agent 直接调用这些接口。

## 1. 在电脑的项目文件夹启动

需要 Python 3.10 或更新版本。在项目文件夹打开 PowerShell、命令提示符或终端：

```sh
python -m pip install -r requirements.txt
python browser_controller.py --open
```

Windows 也可以双击 `启动浏览器云控制台.bat`。如果系统只有 `py`，命令中的 `python` 可替换为 `py -3`。

默认控制台为 `http://127.0.0.1:8899`；默认浏览器数据放在独立的 `~/.neko-video-downloader/controller-profile` 目录。控制台会自动寻找浏览器，也可以用 `--chrome` 指定可执行文件、`--extension` 指定扩展目录、`--profile` 指定专用用户目录。`--url` 设置初始网页，`--cdp-port` 指定调试端口；不指定时自动分配。

普通 Google Chrome 从 137 开始不接受 `--load-extension` 自动加载。第一次打开控制器启动的 Chrome 后，在该窗口访问 `chrome://extensions/`，开启开发者模式，加载包含 `manifest.json` 的本项目文件夹。Chromium / Chrome for Testing 仍支持命令行加载扩展。**控制台连接成功并不代表扩展已经安装成功。**

如果已经有开启调试端口的浏览器：

```sh
python browser_controller.py --attach http://127.0.0.1:9222 --open
```

`--attach` 不启动或关闭这个浏览器。普通 Chrome 的调试端口需要专用用户数据目录；这里不会复制或接管日常浏览器 profile。

## 2. 在另一个终端或 Agent 命令行调用

```sh
python agent_cli.py health
python agent_cli.py tabs
```

`tabs` 返回的 `id` 就是后续请求的 `targetId`。例如，把下面内容保存到 `request.json`，将 `TAB_ID` 替换为刚返回的真实 id：

```json
{
  "targetId": "TAB_ID",
  "method": "Runtime.evaluate",
  "params": {
    "expression": "({title: document.title, url: location.href})",
    "returnByValue": true
  },
  "timeout": 15
}
```

在 macOS / Linux / Windows 命令提示符运行：

```sh
python agent_cli.py cdp < request.json
```

在 PowerShell 运行：

```powershell
Get-Content -Raw request.json | python agent_cli.py cdp
```

页面截图：

```sh
python agent_cli.py screenshot --target TAB_ID
```

截图返回 CDP 的 base64 数据，并非已经保存到磁盘。CDP 请求支持浏览器原生方法；如 `Page.navigate`、`Input.dispatchMouseEvent`、`Input.insertText`、`Runtime.evaluate`。`targetId` 为 `browser` 时可调用浏览器级方法，例如 `Target.getTargets`。接口不增加额外的方法白名单。

CLI 的 stdout 为一个 JSON 结果；成功退出码为 0，服务/连接错误为 1，输入错误为 2。详细用法见 `python agent_cli.py --help`。

CLI 只有在 HTTP 为 2xx 且 JSON 中 `ok` 为布尔值 `true` 时报告成功。字符串 `"false"`、数字 `1` 等均为无效响应；HTTP 错误状态也不能被正文中的 `ok: true` 覆盖。服务端已有的结构化错误及其附加数据会保留。

## 3. 接口与结果

| 接口 | 请求 | 结果 |
|---|---|---|
| `GET /health` | 无正文 | 浏览器 CDP HTTP 端点是否可达及浏览器名称 |
| `GET /api/tabs` | 无正文 | 页面目标的 `id / type / title / url` |
| `POST /api/cdp` | `targetId / method / params / timeout`，可选 `sessionId` | 对应 CDP 回包或明确错误 |
| `POST /api/screenshot` | `targetId / params / timeout` | `Page.captureScreenshot` 结果 |
| `GET /ws` | 首条消息 `{"action":"auth","token":"..."}` | 可视控制台画面、标签页与命令回包 |

成功示例：

```json
{"ok": true, "id": 12, "result": {"result": {"type": "string", "value": "页面标题"}}}
```

失败示例：

```json
{"ok": false, "error": {"code": "target_not_found", "message": "The requested CDP target no longer exists or is not inspectable."}}
```

`ok` 表示 CDP 调用是否取得正常协议回包。`Runtime.evaluate` 的脚本异常还应检查 `result.exceptionDetails`；导航、点击和下载是否达成目标，仍应随后读取页面/任务状态核验。超时或断连时命令可能已经执行，控制器不会自动重放这些命令。

### WebSocket 目标选择

`{"action":"select","id":1,"targetId":"TAB_ID"}` 会准备目标的画面传输，成功后返回 `selected`，并将它提交为该连接的已确认目标。失败时返回包含 `action: "select"`、请求 id 和已确认目标的结构化错误，原目标继续可用。连续选择时，以最新的有效选择为准；格式无效的选择不会取消正在准备的有效请求。

WebSocket 的 `cdp` 请求只有在**省略** `targetId` 字段时才使用该连接的已确认目标。显式传入 `null`、空字符串或非字符串值会报输入错误，不会改发到其他标签页。HTTP CDP 请求仍需明确指定目标。

可视控制台在新目标确认前保留原画面与操作目标，确认后再显示新画面；提前到达的新目标首帧会暂存。前进、后退从读取历史到导航都绑定动作开始时的目标，等待期间切换标签不会把历史操作发送到另一页。通用 CDP 调用继续保留原生方法、参数、`sessionId` 与协议结果，不依赖画面选择是否成功。

通用接口已经可以执行浏览器操作；扩展的“列出媒体、创建合并任务、查询任务进度”专用 Agent 接口仍是后续工作，不应把这套 CDP 接口描述成已经封装好的全自动视频下载服务。

## 远程调用与本次对话

默认服务只监听本机。跨电脑调用时，需要把控制器部署到调用方可达的机器，并配置 `NEKO_CONTROLLER_TOKEN`，再显式选择监听地址。使用 HTTPS 反向代理或已有受信任网络连接；不要公开 Chrome 自身的调试端口。

HTTP 使用 `Authorization: Bearer ...`。CLI 从 `NEKO_CONTROLLER_TOKEN` 读取令牌，从 `NEKO_CONTROLLER_URL` 或 `--base-url` 读取服务地址。不要把令牌放在 URL 参数里。浏览器页面可输入同一令牌，仅保存在当前标签页会话的 `sessionStorage`。

设置远程监听时，控制器要求存在令牌；HTTP 和 WebSocket 都验证 Origin。若代理后的页面 origin 不同，可使用 `--allow-origin` 添加准确的 origin。远程 HTTP(S) 调用保留系统代理和 CA 配置，已确认的 loopback 端点本地直连。

**把代码推到 GitHub 不会自动建立 ChatGPT 到你电脑的连接。** 本版本交付运行程序和可调用协议；当前对话尚未获得你电脑上运行服务的可达地址或连接器。可运行 CLI 的本机 Codex / Agent 可按上面的命令使用它。

## 官方参考

- [Chrome 调试端口与专用用户数据目录](https://developer.chrome.com/blog/remote-debugging-port)
- [Chrome 137 的扩展命令行加载变化](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [Chrome 消息传递](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
