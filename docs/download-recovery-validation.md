# 1.2.1 候选版：下载恢复与范围校验

日期：2026-11-12。基线：`3b3b0715238fd78f8a52124e7fe06a2d9b17cc28`。

## 修复行为

- 在初始请求之前注册操作按钮。清单、密钥、初始化段加载时可以取消；复制链接、保存原始清单保持可用。
- 取消/失败后，“重新解析清单”重新请求并清空旧密钥缓存；解析成功后再次点击才开始下载。
- 请求响应头及读取响应体采用 30 秒无数据超时；每次收到数据重置，等待本地缓冲容量时暂停计时。分片网络失败仍按原流程重试。
- 取消高画质准备时立即退出，不继续尝试低画质。
- 请求范围要求有效非负偏移与正长度。206 必须具有匹配的 Content-Range 和字节数；200 必须覆盖请求区间，随后本地切片。错误响应不会提交给写盘端。
- 全部分片失败时说明首个失败原因，不提交视频文件。原有并发曲线计算未修改。

## 本次验证

| 层级 | 方法 | 结果 |
|---|---|---|
| JavaScript 回归 | 执行原始脚本；DOM/Chrome API 为测试替身 | 110 项通过，0 失败/跳过 |
| Python 回归 | 原控制桥 HTTP/WS 集成测试 | 29 项通过，0 失败/跳过 |
| 真实 HTTP 与文件 | Python 本地 HTTP 服务 + Node 原生 fetch + 原下载脚本 + 实际文件写入；DOM/保存框为替身 | 以下 5 场景通过 |
| 静态检查 | JS/Python 语法、git diff --check | 通过 |

真实 HTTP 场景：

1. 206 范围响应：下载含 MAP 和三个范围分片的 fMP4，输出 680,783 字节，与原始文件逐字节一致。
2. 200 忽略 Range：返回完整文件，本地切片后输出与上项逐字节一致。
3. 错误短响应：请求 bytes=4-7，只返回 3 字节；三次尝试后不提交文件。
4. 清单加载挂起：复制操作可用，取消后恢复重新解析入口。
5. 无数据超时：实际等待约 30.004 秒后退出，恢复重新解析入口。

两份成功文件均经 ffmpeg 完整解码，无解码错误。ffprobe：H.264 640×360、AAC、时长 3.020996 秒。测试源是本地合成测试图及正弦音，不代表真实视频网站兼容性。

## 浏览器验证边界

**本次没有通过完整扩展的真实浏览器验收。**

- 命令行 Chromium 启动所需 AF_UNIX socket 被当前执行环境拒绝；本次再次确认该 socket 能力不可用。
- 通过桌面工具成功启动 Chromium，并看到窗口。
- 浏览器工具拒绝访问 chrome://extensions/，明确不允许通过其他浏览器表面绕过该策略，因而停止扩展安装路径。
- 改尝试普通 HTTP 页面，但浏览器访问测试服务返回 ERR_CONNECTION_REFUSED；执行会话中的服务不能直接被该浏览器访问。
- 因此真实 HTTP/文件检查替代了部分验证，DOM、原生文件选择框、Chrome 扩展权限、截图与真实站点尚未验收。未把 Node 的 VM 执行称为浏览器测试。

## 复现命令

在仓库目录执行（需要 Node、Python 与 ffmpeg/ffprobe）：

```sh
node --test tests/*.test.js
python -m unittest discover -s tests -p 'test_controller*.py' -v
mkdir -p /tmp/neko-browser-fixtures
ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=640x360:rate=24 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 3 -c:v libx264 -preset ultrafast -g 24 -pix_fmt yuv420p -c:a aac -f hls -hls_time 1 -hls_list_size 0 -hls_segment_type fmp4 -hls_flags single_file /tmp/neko-browser-fixtures/valid.m3u8
node tests/http-download-smoke.cjs /tmp/neko-browser-fixtures
```

最后一项会自行启动/关闭本地测试服务，并打印生成文件目录。完整运行约 32 秒。

在能使用本地浏览器的机器上，可另行运行：

```sh
python tests/browser_fixture_server.py --fixtures /tmp/neko-browser-fixtures
```

打开 http://127.0.0.1:8765/，选择 valid、full、broken、hang。该页直接使用仓库中的下载页面及脚本，无网络替身；网页测试仍不等同于安装扩展测试。完整安装验收按 README 加载本仓库，检查真实站点下载、截图及保存框取消。
