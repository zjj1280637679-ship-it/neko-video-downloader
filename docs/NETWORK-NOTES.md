# 手动并发与网络测量边界

当前产品使用下载任务页的手动并发滑块：1–375，默认64，左稳右急。2.2.0保存后实时应用于所有活动与排队HLS任务，关闭弹窗后继续生效；调大立即补位，调小等待已有分片任务完成再按新上限补位。下面固定数值基准仍用于检验单个固定值，实时变化由流式与消息集成测试另行覆盖。网络观测只解释进度、速度和资源使用，不自动调整用户选择的并发。历史自动探测实验已退出当前方案，历史JSON留在工作目录，不作为交付版本的性能宣传。

## 浏览器和 HTTP 条件

| 观测 | 合理用途 | 边界 |
| --- | --- | --- |
| 调用 fetch 到响应头可用的耗时 | 解释响应头等待 | 包含浏览器队列、连接、握手和服务器处理，不是纯 RTT |
| 流读取的字节与时间 | 响应正文读取速率、正文停滞 | 可能经过解码或来自 HTTP 缓存，不是物理线路带宽 |
| 在途请求数 | 说明应用正在处理多少请求 | 不是 TCP 连接数；浏览器可能排队，HTTP/2 可复用连接 |
| 已读未写字节、写入耗时 | 检查有序写入和内存背压 | 不包含浏览器网络层、TLS、文件系统等全部缓存 |
| Resource Timing | 条件允许时辅助解释连接时序 | 跨域无 Timing-Allow-Origin 时许多字段为零，不是实际耗时为零 |
| navigator.connection | 可作为解释网络环境的粗略信息 | 不是当前 CDN 的测速，不据此改动用户并发 |
| 429 / 503 与 Retry-After | 暂停同来源新请求、有限重试 | 不自动降低固定并发；超过重试预算则明确报错 |
| storage.estimate() | 解释 origin 使用量与大致配额 | 不是磁盘剩余空间，不保证后续写入成功 |

Fetch 先交付 `Response`，正文在之后消费；应用层测得的响应头等待不能称为 RTT。内容解码还可能使正文长度与 `Content-Length` 不同，读取上限必须同时检查实际字节。[WHATWG Fetch](https://fetch.spec.whatwg.org/#fetch-method)、[HTTP 网络获取与内容编码](https://fetch.spec.whatwg.org/#http-network-fetch)

Resource Timing 对跨域不透明响应限制详细字段。服务器通过 `Timing-Allow-Origin` 在满足检查时开放相应信息；Service Worker 的时序也可能描述与 worker 的交互。[W3C Resource Timing](https://www.w3.org/TR/resource-timing/#sec-cross-origin-resources)

Network Information 的 `rtt` 是近期连接的有效应用层估计，按 25ms 取整；`downlink` 也是量化估计，没有近期样本时可以依据连接技术推测。API 还可能缺失，因此它不承担当前产品的并发决策。[Network Information 规范](https://wicg.github.io/netinfo/)

HTTP/2 可在一条连接复用多个流；对端的并行流设置会限制实际流数量。Node 本机 HTTP/1.1 测试中出现 375 个在途请求，不证明 Chrome 对某个网站建立 375 条连接，也不证明目标站具有相同比例提速。[RFC 9113 §5.1.2](https://www.rfc-editor.org/rfc/rfc9113.html#section-5.1.2)

`Retry-After` 可以是非负整数秒或 HTTP 日期。有效等待不能被任意截短；等待需要支持取消。429 的限额范围可能是资源、服务或用户，503 也可能来自临时维护。固定并发下先尊重来源等待，再按有限重试预算处理，不能无限重试或宣称任何并发都能成功。[RFC 9110 §10.2.3、§15.6.4](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3)、[RFC 6585 §4](https://www.rfc-editor.org/rfc/rfc6585.html#section-4)

Storage 的 usage 是粗略估计，quota 是实现决定的 origin 容量。估算不是磁盘空间预留，实际写入仍可能失败。[WHATWG Storage](https://storage.spec.whatwg.org/#dom-storagemanager-estimate)

## 固定并发的验证

`node scripts/benchmark-manual.cjs` 只传入数值并发，默认分别测试 1、64、375；没有自动模式入口。默认 384 个合成小分片覆盖多轮请求，检查每一片的字节与顺序以及最终 SHA-256，并记录整段耗时、实际在途峰值、已读未写字节、会计预算与进程内存。服务器只绑定 `127.0.0.1`，不会读取目标站或保存视频文件。

- `--baseline=64,375 --scenario=retry-after --segments=64`：首次指定请求返回 429 或 503，覆盖整数秒与 HTTP 日期；验证同片及同来源请求没有提前重试。固定目标不得变化。
- `--memory-stress`：12 个约 0.73MiB 分片、4MiB payload 会计预算、1MiB 单资源上限；使用慢头片和慢 sink 检查预算与进展。
- `--memory-stress --chunked`：省略 Content-Length，验证未知长度的增量读取与头片推进。
- `--baseline=375 --scenario=ordered --header-delay=1000`：给服务器足够时间同时观察全部在途请求，检查 375 上限。
- `--baseline=375 --scenario=ordered --header-delay=2000 --cancel-after=900`：在服务器实际接受高并发请求后取消，检查客户端与服务器都释放请求。只验证取消前的输出前缀，不能称为整段完整性通过。
- `--baseline=375 --scenario=ordered --segments=64 --persistent-limit --retry-attempts=2`：头片持续返回 429，显式配置 2 次尝试以快速验证有限失败。此负向用例应失败并返回非零退出码，不能称为完整下载通过。
- `--output=路径` 保存 JSON；`--segments=N`、`--repeat=N` 可以明确改变工作量；`--quick` 仅缩短夹具等待，不能作为性能结论。

固定值是任务槽上限，重试保留在原任务槽中，不临时增加槽位。实时调低时，已在途任务数暂时可以高于新目标，直到自然完成；不会为使计数立即对齐而取消或重下。内存预算可能暂时阻塞正文读取，但不会修改保存的并发设置。

脚本检查客户端收到的实际响应头、成功响应流交付的字节和 sink 已写字节。`peakUnwrittenBytes` 是应用可观测的已读未写量；RSS 与 ArrayBuffers 采样包含本机服务器和垃圾回收，只作环境记录，不等于 Chrome 总内存保证。报告记录核心、engine 与脚本文件 SHA-256；失败会保留错误与部分输出诊断，退出码非零。

这些是受控传输与资源验证，不证明文件可被播放器解码，也不证明真实网站速度。Chrome 安装、实际来源访问、最终文件下载与播放需要单独验收。

## 2026-11-12 的受控结果

测试核心 SHA-256 为 `7384b7aaa998f03e343b182ec658d8bd3b969e3c102528c5b755015ea3bc7ef2`。以下 24 组完整传输全部逐片顺序和最终 SHA-256 一致，所有固定目标保持不变：

| 组别 | 数量 | 观察 |
| --- | --- | --- |
| 384 片的正常、慢头片、慢 sink × 1/64/375 | 9 | 客户端在途峰值分别达到 1、64、375，未越过选择值 |
| 已知长度、4MiB 会计预算，两个压力场景 × 1/64/375 | 6 | 无死锁，预算有效 |
| 未知长度 chunked，同上 | 6 | 最大会计预留 3,766,954 字节，小于 4MiB；实际已读未写峰值约 2.04MB |
| 延后响应头、固定 375 | 1 | 服务器与客户端均观察到 375 个同时在途请求 |
| 429/503 首试失败，固定 64/375 | 2 | 整数秒与 HTTP 日期均未提前重试，固定目标不变 |

另外 3 组主动取消覆盖服务器已接受 375 个请求、正文预算背压、Retry-After 等待；客户端及服务器请求均退出，观察到取消后的清理延迟约 111ms、18ms、35ms。这些验证输出前缀与取消，不计入 24 组整段完整性。

持续 429 的负向用例显式配置 2 次尝试，按预期在第 2 次返回失败；并发设置仍为 375，等待未被截短。对应报告的 `passed` 是 `false`，不是完整下载通过。

原始 JSON 位于工作目录：`manual-final-normal.json`、`manual-final-memory-known.json`、`manual-final-memory-chunked.json`、`manual-final-peak375.json`、`manual-final-retry.json`、`manual-final-cancel375-active900.json`、`manual-final-cancel-buffer.json`、`manual-final-cancel-retry.json`、`manual-final-limited-failure.json`。这些结果只对应各报告记载的代码哈希与夹具，不包含任何目标站提速结论。
