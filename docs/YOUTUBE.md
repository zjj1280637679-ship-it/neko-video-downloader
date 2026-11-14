# YouTube 本机下载内核

羊魔通过独立本机内核处理 YouTube 的格式解析、音视频下载与封装，原有直链和 HLS 仍由原下载路径处理。只安装一次辅助内核，日常继续在羊魔里点击“下载视频”，不需要另开设置页面或手动启动服务。

2.4.0 起同一个内核也支持 [B站普通投稿的当前分P](BILIBILI.md)。下述安装、更新与卸载步骤两站共用；访问条件和授权按各站点分别处理。

实现后的可用范围应以当前版本的实际验收记录为准；本说明不能代替真实下载验收。YouTube 的客户端协议和令牌要求会变化，解析成功或进程退出码为零不等于完整视频已经保存。

## 安装

要求 Windows、Chrome，以及包含 `native/` 和 `scripts/` 的羊魔源码包。安装器只注册当前 Windows 用户，无需管理员权限。

依赖为 Python 3.11 或以上、Node.js 22 或以上、FFmpeg 和同目录的 ffprobe。仅从项目或厂商官方来源取得这些依赖；安装器不会静默下载可执行文件。它在 `%LOCALAPPDATA%\YangmoNative\.venv` 创建独立 Python 环境，固定安装 `yt-dlp[default]==2026.10.26`，不会修改 ComfyUI、Qwen 或系统 Python 的包。

在 `chrome://extensions` 找到羊魔的扩展 ID，运行：

```powershell
.\scripts\install-native.ps1 `
  -ExtensionId '替换为32位扩展ID' `
  -PythonPath 'C:\Python311\python.exe' `
  -FFmpegPath 'C:\Tools\ffmpeg\bin\ffmpeg.exe' `
  -NodePath 'C:\Program Files\nodejs\node.exe'
```

路径只是示例，请使用本机实际路径；扩展 ID 必须是32个 a–p 小写字母。若依赖已经位于 PATH，可省略对应路径参数。`-FFprobePath` 可用于明确指定 ffprobe；默认与 FFmpeg 同目录。

开发或自动化验收可以复用已经准备好的独立环境：

```powershell
.\scripts\install-native.ps1 `
  -ExtensionId '替换为32位扩展ID' `
  -ExistingVenv "$env:LOCALAPPDATA\YangmoNative\.venv" `
  -SkipDependencyInstall `
  -FFmpegPath 'C:\Tools\ffmpeg\bin\ffmpeg.exe' `
  -NodePath 'C:\Program Files\nodejs\node.exe'
```

`SkipDependencyInstall` 仍会检查环境隔离和 yt-dlp 的固定版本，不能用它跳过缺失依赖。安装器不覆盖 `runtime`、已有虚拟环境或任务数据。每次代码部署放在独立版本目录，注册和启动器变更前保留备份；后续校验失败时恢复原有注册与启动器。

Chrome 使用 `org.yangmo.downloader` 本机通信主机。它只允许安装时指定的羊魔扩展 ID。若换目录重新加载插件导致扩展 ID 改变，重新运行安装器绑定新 ID；不要使用通配来源。主机由 Chrome 按需启动，使用标准输入输出通信，没有创建开机服务。

## 下载与保存边界

- 插件识别当前 YouTube 视频页面后创建任务，不依赖普通媒体请求嗅探。
- 原生内核下载至自己的临时任务目录，必要时将完整音轨、画面轨封装成一个文件，检查成品后交回 Chrome 保存。
- 最终路径仍由 Chrome 当前默认下载地址决定，无子文件夹、保存地址设置或另存弹窗。原生内核临时目录不是最终下载目录。
- 仅在 Chrome 确认保存完成后，羊魔显示“已保存”。下载、封装和保存是不同阶段。
- 用户点击取消后，要等待对应网络请求、子进程和保存工作真正停止，才进入已取消。删除任务只删除记录和临时数据，不能删除已保存视频。

## 分片并发

滑块仅控制实际分片下载的任务：1–375、默认64、保存偏好，运行中升高立即允许补位，降低只限制后续分片准入。音视频轨共享一次任务的额度，不能各自使用64路却显示64。

没有分片的任务正常下载，不响应滑块，也不会为了让滑块生效而强行切片。yt-dlp 的 `-N` 本身只是部分下载器的启动参数，因此不能仅传入 `-N` 就宣称实时控制已经实现；分片实时调节必须在适配执行器中验证。SABR 等协议内部有媒体段，不意味着可以任意并行重放，须遵循协议的会话顺序。

## 升级、卸载与恢复

yt-dlp、EJS、令牌提供器和播放器协议之间存在版本配合；更新内核后应重新检查真实样本、取消、实时并发和默认目录。不要直接覆盖运行中的下载程序，先取消或完成任务。

卸载 Chrome 的本机连接：

```powershell
.\scripts\uninstall-native.ps1
```

脚本只移除准确指向本安装目录的当前用户注册。它保留程序、依赖、备份和临时任务数据，不修改 Chrome 已保存的文件。若用了 `-InstallRoot`，卸载时传入相同路径。旧注册备份位于安装目录 `backups/<部署标识>/registration.json`，旧启动器和主机清单也保留在同目录；需要回退时先确认当前注册仍由本安装拥有。

## 验收要求

至少验证实际故障页、普通公开视频、Shorts、1080p分离音视频；成品有声音和画面、时长合理，可拖动检查开头、中段、末尾。分片任务验证运行时 `1→64→375→1`；无分片任务验证滑块变化不影响正常下载。还需验证弹窗关闭、链接过期、网络失败、各阶段取消、Chrome自定义默认目录、重名保存，以及原有 HLS/直链回归。

默认匿名下载。只有任务确实因登录验证失败，界面才显示“使用 YouTube 登录状态重试”；用户点击并同意 Chrome 的可选 Cookie 权限后，仅为本次尝试读取 `youtube.com` / `.youtube.com` 的 Cookie，交给本机内核向 YouTube 请求这个视频。不读取 Google 或其他网站 Cookie，不写入任务记录、配置、请求文件或日志；内核退出后内存中的会话随之释放。普通新任务和普通重试仍匿名，不因曾经授予权限就自动使用登录状态。

可在 Chrome 扩展权限中撤销可选授权。登录状态不能保证媒体请求一定成功；不支持的访问条件显示具体失败原因，不无限重试或把局部文件当成功。
