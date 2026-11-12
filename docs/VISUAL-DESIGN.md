# 羊魔角色与动画规范 · 2.1.4

## 用户要求与实现

用户以新附件指定品牌角色：黑白长发、黑色羊角、尖耳、闭眼笑和腮红、抬起的黑手套、黑蕾丝及红宝石配饰。顶部、空状态、下载进度条和Chrome图标共用 `icons/yangmo-mascot.png`。保留浅粉淡紫背景、深紫文字、粉紫操作按钮；角色本身使用参考图的黑白红配色。

装饰全部设置 `pointer-events:none` 和 `aria-hidden=true`，不进入键盘焦点。保持420×600弹窗、1–375并发滑条、默认64、保存、ETA和下载调度。

进度角色在专用空间中随真实百分比移动，不遮挡标题、状态、指标或操作。只有解析、下载、保存活动态使用轻量浮动与星光；排队、完成、失败、取消及取消处理中静止。隐藏弹窗或切到来源页暂停任务动画。未知总量不显示伪百分比，角色固定起点。系统“减少动态效果”同时关闭循环与位置过渡。100%数据收齐不等于已经保存，完成状态仍由Chrome确认。

## 资产来源

2.1.3布局修订：移除当前网页信息栏、网页标题、画面区域/预览弹窗和搜索行。右上角为加大的文字刷新按钮“重新读取视频来源”，与小羊、标题分别占位；来源列表获得更大空间。来源页和任务页均可从顶部重新读取来源，焦点环与减少动画支持保留。

2.1.2布局修订：保留本页粉紫色彩和小羊资产，把并发和静态保存位置收进下载任务页；来源列表使用释放出来的空间。任务卡片提供取消/删除按钮，按钮区允许换行，长任务列表独立滚动。取消后焦点可转到删除按钮，删除后转到相邻任务或页签。

2.1.4使用内置imagegen编辑用户提供的手机截图，移除手机界面、文字、白底与留白；1254×1254、32bpp RGBA、1,586,847字节，四角alpha=0。保留角色造型与姿态；生成式编辑会重绘细小线条，不是逐像素原图抠取。未使用CLI或脚本抠图，透明alpha原样保存。图片随扩展本地分发，同一PNG复用；原小羊不再打包。Chrome按显示尺寸缩放图标。

资产SHA-256：`52f83f4c240b1db7887bcf0ab798711aa15e7f3b1a6f944a23ce4bc99bbad05d`。

最终提示词：

> Use case: background-extraction.
> Asset type: transparent PNG character mascot for a browser extension icon and progress animation.
> Input image 1 is the edit target, not an inspiration reference. Extract ONLY the existing illustrated half-body character from the provided phone screenshot. Remove the phone status bar, WeChat/navigation UI, all text/icons, the plain white background, and excessive empty space.
> Preserve the exact existing character, pose, facial expression, drawing style, colors, proportions and details: black hair with broad white front locks and white hair tips, two curved black ram horns, pointed ears, closed smiling eyes and pink blush, small smiling mouth, raised black-gloved hand near the mouth, black lace choker and bodice, red gemstone accessories. Keep the original half-body bottom edge. Do not redesign, embellish, change clothing, change expression, add objects, add text, add a border, or invent extra body parts.
> Output a square transparent PNG with genuine alpha. Center the complete character and scale uniformly so its longest silhouette dimension occupies about 90% of the square. Leave a small transparent margin on every edge. Keep both complete horn tips, all hair outlines, glove, ears and shoulders inside the canvas. Clean transparent cutout edges without a white rectangle, white halo, checkerboard baked into pixels, shadows or background.

## 色彩

- 主要文字 #382845；辅助文字 #735d79；强调色 #8050af。
- 纸面 #fffafd；画布 #fbf4fd；浅紫分组 #f1e5fa。
- 焦点环 #9361af：在常用浅色控件背景上至少3.77:1。
- 主按钮白色文字在渐变两端的对比度5.40:1 / 5.01:1；辅助文字在标签底色上约4.83:1。

## 验收范围

真实浏览器在420×600下检查角色加载、进度边界、活动/终态动画、任务页切换、减少动画和点击命中。滑条及按键继续通过已有功能回归。视觉预览使用模拟数据，不执行真实站点视频下载；安装版检查标题/任务/图标使用同一角色。
