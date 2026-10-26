# 开机动画 · Startup Animation

> 给 **DeepSeek Harness** 加一个全屏开机动画：启动 Harness 时盖在加载页前面播放，
> 点画面任意处即可跳过。开箱自带视频 / 壁纸 / 音频素材库，也能用你自己的文件。

[English](README.md) | 中文

---

## 它做什么

Harness 启动时，这个插件在加载页前面盖一层全屏动画，并**监听应用真正就绪的时刻**——
界面一接管就淡出，你等的永远是应用本身，不是动画。

- **装上就有**：不需要任何配置，内置动画立刻生效。
- **两种玩法**：从内置素材库挑一个（3 个视频、7 张壁纸、9 段语音），
  或者上传播放你自己的 MP4 / WebM / GIF / PNG / JPG / MP3。
- **声音是三个彼此独立的选择**，各由你自己决定：带音轨的视频、没音轨的视频、以及单独的开机音频文件。
  开一个、开两个、或者都不开都可以——插件不会为了让某一路响起来去静音另一路。
- **开机音频**：动画期间播放选定的音频，音量和视频独立，退场时一起淡出。
- **绝不扣住你**：点一下、按 `Esc` / `Enter` / `空格`、或者干脆等——每条路都能出去。
  动画自身任何一步失败，都会安静地退回 Harness 原生启动页。
- **真实进度条**：内核暴露启动进度弧时用真实进度，否则走流光。

### 截图

> 把截图放进 `docs/screenshot-*.png` 后在这里引用。

## 安装

### 从插件市场（推荐）

DSH 0.2.1+ 自带插件管理器。打开 **设置 → 插件**，搜索 **开机动画 / Startup Animation**，
安装后刷新页面。

### 从本仓库安装

```sh
dsh plugin --profile <你的 profile> add github:WWFZS/dsh-plugin-startup-animation
```

然后重启 `dsh`。如果你用的是官方 DSH 桌面版，请从应用内的 **设置 → 插件** 安装——
那个 profile 归应用的插件管理器管。

### 手动安装

```sh
git clone https://github.com/WWFZS/dsh-plugin-startup-animation.git
dsh plugin --profile <你的 profile> add /该仓库的绝对路径
```

## 怎么用

打开 **设置 → 开机动画**（入口在侧栏的设置列表里）。

| 控件 | 作用 |
|---|---|
| 显示开机动画 | 总开关。关掉 = Harness 原生启动页。 |
| 视频带声播放 | 让**视频**播它自己的音轨（前提是文件里真的有音轨）。 |
| 开机音频 | 动画期间另播一段音频文件。 |
| 展示时长 | 3–15 秒，视频与壁纸共用。**跳过不受它限制**。 |
| 启动画面素材 | 当前素材预览，以及「恢复默认」。 |
| MP4 / 壁纸 / 音频 三个页签 | 点卡片即选用；上传即入库。 |

页面右上角的 **立即刷新** 会重载页面让新配置生效。**任何设置都不需要重启 `dsh`。**

### 版本与更新

设置页标题旁有一枚很小的版本号——显示你**实际装上的**版本，直接读包自己的清单。

- **已是最新**：只显示 `版本 1.2.3`（你装的那一版），不打扰你。
- **有新版**：变成 `版本 1.2.3 · 有新版本 1.2.4`，点一下打开 GitHub Release 页，
  先看改了什么再决定。
- **检查不到**：离线、防火墙拦了、或者 GitHub 不可达时，就只是一枚安静的版本号。
  它**不会变成报错状态**——更新检查是锦上添花，不是插件的依赖。

插件**不会自动更新自己**：代码里没有任何"下载并覆盖自身文件"的路径。更新就是你自己
跑下面这条命令（或用插件管理器），所以一个有问题的版本不可能在你不知情时落到机器上。

```sh
# 覆盖安装，设置与已上传素材都会保留
dsh plugin --profile <你的 profile> add github:WWFZS/dsh-plugin-startup-animation
```

你的配置（`$DSH_HOME/startup-animation.json`）和上传素材
（`$DSH_HOME/startup-animation-media/`）都在包**外面**，升级不会动它们。

### 配置文件

配置存在 `$DSH_HOME/startup-animation.json`（一般是 `~/.dsh/startup-animation.json`），
可以直接手改：

```json
{
  "boot": {
    "enabled": true,
    "file": "builtin/MP4/多重影像.mp4",
    "durationSec": 8,
    "audioEnabled": true,
    "audioFile": "builtin/音频/宝宝安慰.mp3",
    "audioVolume": 0.4
  }
}
```

`file` 可以写 `builtin/...` 包内相对路径，也可以写你自己素材的绝对路径。
其余键都有合理默认值，见 [`index.js`](index.js) 的 `DEFAULT_CONFIG`。

## 支持的素材

| 类型 | 格式 | 说明 |
|---|---|---|
| 视频 | `mp4` `m4v` `webm` `ogv` `ogg` | 等待期间循环播放。内置视频是 1080p / 8s / faststart。 |
| 图片 | `gif` `apng` `webp` `png` `jpg` `jpeg` | `gif`/`apng`/`webp` 会动；静图带缓慢呼吸缩放。 |
| 音频 | `mp3` `wav` `m4a` `aac` `flac` `opus` | 仅用于开机音频。 |

上传落盘目录：`$DSH_HOME/startup-animation-media/`，单文件上限 **128 MiB**。

## 内置素材库

以下全部随包分发，在列表里直接可选：

- **MP4** —— 4 段，全部为 H.264 faststart（可直接流式播放，每段 1.6–6.6 MB）。
  `大肥鱼-欢迎回来` 带语音音轨（打开「视频带声播放」即可听到），另外三段是无音轨的
- **壁纸** —— 7 张，附带预生成的 480px 缩略图供列表使用
- **音频** —— 9 段语音

## 它如何做到"不添乱"

- 覆盖层挂在 `document.body` 上、**不在 `#root` 里**，不会干扰应用的水合（hydration）。
- 每条失败路径（文件不在、编码不支持、自动播放被拦、内核启动慢）都有时间上界，
  统一退回原生启动页。
- 素材路由完整实现了 `Range`/`ETag`：拖动进度正常，切片响应不会被当成完整文件缓存。
- 上传素材是**真删**；内置素材只从列表隐藏，包体保持完整。

## 对未来 DSH 版本的兼容性

Harness 迭代很快，而这个插件用到两个内核扩展点（`webserver/index-inject` 做开机覆盖层，
`webServer.register` 做路由和素材服务）。两处都按"未来内核改了也只降级、不弄坏你的
Harness"来处理：

| 如果未来的 DSH 改了…… | 会发生什么 |
|---|---|
| `webserver/index-inject` 的事件名或签名 | 插件打一条警告，**不带动画**正常启动；显示原生启动页 |
| `webServer` 服务（路由、素材服务） | 不提供设置页入口；Harness 其余部分完全不受影响 |
| 设置页插槽 API（`settings.section`） | 设置入口消失，不抛异常 |
| 运行期其它任何意外 | 每条失败路径都回落到原生启动页——覆盖层永远不允许阻塞启动 |

声明的兼容范围（`engines.dsh`，并镜像一份到 `dsh.engines`，让插件管理器和市场从
任一位置都能读到）是 `>=0.2.0`。插件**没有任何 npm 依赖**，浏览器半边只从宿主的模块表
`require('react')`——不存在"随包打进了某个会和内核版本脱节的库"这种隐患。

启动日志会同时写明插件版本和（能读到时）宿主内核版本。万一哪次升级把动画弄没了，
第一眼就该看那一行。

## 环境要求

- DeepSeek Harness **0.2.0+**（Web 界面）
- Node.js ≥ 22.12.0（跟随 Harness 自带的运行时即可）

插件**没有任何 npm 依赖**，安装时也不需要构建——纯 ESM + 静态素材。

## 卸载

```sh
dsh plugin --profile <你的 profile> remove dsh-plugin-startup-animation
```

`$DSH_HOME/startup-animation-media/` 里上传的素材是你自己的数据，插件不会替你删。

## 开发

```sh
node ../selftest.mjs          # 纯函数 + HTTP 语义测试
node ../tools/host-smoke.mjs  # 用真实路由处理器跑一遍 HTTP
node ../tools/make-thumbs.mjs # 重新生成列表缩略图（需要 ffmpeg）
node ../tools/optimize-builtin.mjs # 重新生成 1080p faststart 变体（需要 ffmpeg）
```

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

内置素材仅用于演示；商业再分发前请先看仓库里的 `ASSETS.md` 确认每个文件的来源。
