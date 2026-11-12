# 设计条件与采样记录

调研日期：2026-11-12。外部项目只作为架构与验证思路的参考，没有复制外部项目源码。

## 本地与远端不是简单的版本先后关系

- 本轮代码基线为本地 Git 的 1.4.1（`a94f4a8`），并分别比较远端与实际安装目录。实际安装目录名称仍为 `neko-video-downloader-1.2.0`，但更新前 manifest 版本为 1.4.1、界面为“羊魔视频下载助手”；它包含本地 Git 基线之外的64路并发和清单截断等修改。目录名、版本号都不能代替内容比对。
- 同日读取的远端 `origin/main` 为 `3b3b071`，虽标为 1.2.0，已有本地 1.4.1 没有的增强：媒体判据可修正、源文件和分片的证据区分、播放器/文档/原图身份，以及若干 HLS 处理增强。版本号不能代替代码能力比较。
- 本轮媒体发现保留本地的选中线路过滤、播放代次、页面/子框架生命周期、有限采样、事件串行队列；吸收本仓库远端的强弱证据及顺序无关重判原则，抽出 `domain/media.js` 纯模块。
- 本轮补上响应 MIME 修正初始猜测、真实 video 来源提升 `.ts` 候选、`srcObject` 不沿用旧 src、跨 worker 的网络文档墓碑与 frame 父子关系。远端完整的多播放器选择及原图读回协议未在本轮发现模块中移植，不能声称两份分支的所有能力已经统一。

## 当前目标站条件

主验证页面为一条实际 ikanbot 播放页面，公开记录已省略具体地址、影片及剧集名称，不以示例地址替代实测地址。实际 DOM 观察：215 个 `lineData` 元素，只有 1 个 active，`udata` 为真实 HLS 清单；video 使用 blob，时长约 3201.50 秒，当时没有 iframe。

这组观察支持“保留选中线路 + 网络响应补充证据”的策略，不能推导该站所有影片、线路或未来页面都相同。DOM 中的 blob 证明播放器存在，不是可直接跨环境下载的原始文件；下载成功仍需清单解析、实际传输、保存和浏览器完成状态验证。

## 官方技术条件及本项目策略

| 条件 | 实施策略 / 验证目标 |
| --- | --- |
| MV3 worker 会终止，全局变量不持久 | 事件监听同步注册，状态变更等待 hydration；跨 worker 状态存储，依事件对账。关闭 popup 和 worker 重启均不能重复提交任务。 |
| session 存储会在扩展重载、更新、禁用或浏览器重启时清空 | 页面候选使用 session；需要跨浏览器会话的任务使用 local。不能用 session 声称浏览器重启恢复。 |
| `downloads.download` 返回 ID 不是完成；onChanged 不报告字节进度 | 以浏览器真实状态为准；可见 UI 按需查询字节数，未知总长不伪造百分比。 |
| activeTab 只临时授权主框架源，不覆盖所有 CDN | 当前自动发现保留既有广域 host 权限以兼容站点；后续若改为按站点授权，须单独验证 CDN 和 iframe，不能直接删权限后声称行为不变。 |
| webRequest 的请求阶段与响应阶段证据不同 | URL 只提供初始提示；响应 MIME、DOM 来源分别保存，统一纯函数重判。交换事件顺序后类型、后缀和入口必须一致。 |
| 网络事件和 DOM 消息可以跨页面切换迟到 | 绑定 tab/frame/document，导航时保留已退役 documentId；当前新文档尚未上报时不误丢首个新请求。文档墓碑与父子 frame 关系随 session 恢复。 |
| Blob URL 与 MediaSource 不是永久公网文件 URL | 不把 blob 当直链；从已选线路及网络观察寻找清单。未知不等于 DRM。 |
| HLS 是有格式约束的清单与分片协议 | 初始化段、范围、密钥、轨道和最终响应 URL 分别处理；不能以保存 m3u8 或改文件后缀冒充完整视频。 |
| offscreen 是单独执行环境，通常每个扩展仅一个实例 | 创建过程去重；媒体执行与 worker 协调分离。它只能直接使用扩展 runtime API，下载 API 留在 worker。 |

依据：

- [Chrome Service Worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [Chrome Downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)
- [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest)
- [Chrome offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [MDN Blob URL](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/blob)
- [MDN Media Source API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API)
- [MDN Encrypted Media Extensions](https://developer.mozilla.org/en-US/docs/Web/API/Encrypted_Media_Extensions_API)
- [RFC 8216：HLS](https://www.rfc-editor.org/rfc/rfc8216.html)

## 外部项目采样

1. **[puemos/hls-downloader](https://github.com/puemos/hls-downloader)**：读取 core、background、popup 的分层说明，以及 [全局任务队列](https://github.com/puemos/hls-downloader/blob/master/src/core/src/controllers/download-queue-epic.ts)、[分片执行](https://github.com/puemos/hls-downloader/blob/master/src/core/src/controllers/download-job-epic.ts)、[请求加载器](https://github.com/puemos/hls-downloader/blob/master/src/background/src/services/fetch-loader.ts)。参考其业务核心与环境适配器分离、任务数和分片并发分开控制、取消信号贯穿请求、范围检查和有限重试；未引入它的 Redux/RxJS 依赖栈。
2. **[猫抓](https://github.com/xifangczy/cat-catch)**：读取 manifest 和 background 发现逻辑。参考 MIME、URL、标签页上下文的联合发现；没有照搬其全套权限、持续保活或请求头采集方案。
3. **[Chrome 官方 offscreen 示例](https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/cookbook.offscreen-dom)**：参考消息 target、执行环境分工与按需创建。正式行为以当前 Chrome 官方 API 文档为准，而不是旧示例的所有实现细节。

## 证据契约与并行/串行边界

`domain/media.js` 不引用 Chrome、DOM、存储或网络。它提供 URL/MIME 归一化、判据合并、类型重判及文件名清理。查询参数保留，fragment 去除；签名 URL 不因“去重”被破坏。

每条候选的 `evidence` 是稳定顺序的说明标签数组：`network-url`、`network-mime`、`dom-video`、`dom-selection`、`dom-source`。`observations` 保存这些判断的原始来源，不能把请求阶段猜测伪装成响应 MIME。`kind` 为 `hls`、`direct` 或内部 `fragment`。这些都是发现阶段的判断，不等于服务器一定允许下载。

- 独立的 DOM 与网络观察可并行进入；后台统一排队变更候选状态。
- 同一候选的证据合并、文档退休、清理、存储写入保持顺序。
- 不同下载任务及单任务分片各自受有界调度控制；取消必须阻止迟到结果继续推进任务。
- 后台只传递业务状态，UI 用短标签解释；技术判据展开查看，不占据主要下载流程。

## 本轮回归证据

已运行 `node --test tests/capture.test.cjs`，28 个测试通过；`git diff --check` 无差异格式错误。新增覆盖：

- 无后缀地址 DOM 先到/响应先到均识别为 HLS，文件后缀一致。
- 真正 video/mp4 响应不会被弱线路/`.m3u8` 猜测覆盖。
- `.ts` 分片能由真实 video 来源纠正；part/chunk/hls 目录不能单独抹掉完整 MP4。
- 导航后旧网络请求及响应不能重新填充新页面；未知新 document 首个请求保留。
- worker 恢复后墓碑依然有效，父 frame 导航能清理旧子孙 frame。
- srcObject 不报告遗留 src，实际 `.ts` video 不在内容脚本阶段误丢。
- 相同 URL 在多个 frame 出现时保留各自上下文；一个 frame 导航不能删除另一个仍有效的观察。

这些是模拟 Chrome 事件的回归测试，不替代真实站点下载、媒体完整性或浏览器 worker 生命周期验证。页面抓拍已在2.1.3按用户要求移除；此前的缩略图采样不再属于当前功能。

## 2.0.1 真实文件后缀反馈

实验文件实际是TS数据却保存为.txt。代码发现OPFS File缺失MIME，已统一为video/mp2t或video/mp4；不能直接将这份代码证据当作真实浏览器修复验收。

- [Chromium BlobURLLoader](https://raw.githubusercontent.com/chromium/chromium/main/storage/browser/blob/blob_url_loader.cc)：DidCalculateSize在Blob MIME为空时回退为text/plain，支持缺失MIME与本次文本后缀相关。
- [Chromium Blob实现](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/fileapi/blob.cc)：slice通过AppendBlob引用已有handle、起点和长度；采用切片声明媒体类型，不调用arrayBuffer读取整片。

以上为2026-11-12读取的main分支源码，未来可能变化。修复后短片Chrome保存与完整播放仍列为未验证。
