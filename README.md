<div align="center">

<img src="docs/avatar.png" width="200" height="200" alt="开机动画">

# 开机动画 · Startup Animation

把全屏开机动画，装进你的 DeepSeek Harness。

<a href="https://github.com/WWFZS/dsh-plugin-startup-animation/releases"><img src="https://img.shields.io/github/v/release/WWFZS/dsh-plugin-startup-animation?style=flat-square&label=VERSION&color=4d6bfe" alt="Version"></a>
<img src="https://img.shields.io/badge/DSH-0.2.0%2B-4d6bfe?style=flat-square" alt="DSH">
<img src="https://img.shields.io/badge/依赖-0%20npm%20包-2ea44f?style=flat-square" alt="No deps">
<img src="https://img.shields.io/badge/体积-25%20MB-6e7681?style=flat-square" alt="Size">
<img src="https://img.shields.io/badge/License-MIT-2ea44f?style=flat-square" alt="License">
<img src="https://img.shields.io/badge/Author-WWFZS-8957e5?style=flat-square" alt="Author">

[安装](#安装) · [界面预览](#界面预览) · [使用指南](#怎么用) · [兼容性](#对未来-dsh-版本的兼容性) · [更新记录](https://github.com/WWFZS/dsh-plugin-startup-animation/releases) · [源码构建](#开发)

</div>

---

## 项目简介

**开机动画（Startup Animation）** 是面向 DeepSeek Harness 的全屏启动画面插件。Harness
启动时，它在加载页前面盖一层动画，并**监听应用真正就绪的时刻**——界面一接管就淡出，
你等的永远是应用本身，不是动画。

插件通过内核的两个扩展点接入：`webserver/index-inject` 注入覆盖层与样式，
`webServer.register` 提供素材与管理路由。**没有任何 npm 依赖**，浏览器半边只从宿主的
模块表 `require('react')`，装好即用、无需构建。

开箱自带 **4 段视频 / 7 张壁纸 / 9 段语音**，也支持上传你自己的 MP4 / WebM / GIF /
PNG / JPG / MP3。声音有两个彼此独立的开关：视频自己的音轨，以及单独的开机音频。

## 核心特性

- **装上就有** —— 零配置，内置动画立刻播放
- **两种玩法** —— 内置素材库任选，或上传自己的文件
- **声音两个独立开关** —— 视频音轨与独立音频各管各的，可任意组合
- **绝不扣住你** —— 点击、`Esc` / `Enter` / `空格`、或者干等，每条路都能出去
- **失败即降级** —— 任何一步出错都退回 Harness 原生启动页，不阻塞启动
- **真实进度条** —— 内核给出启动进度弧就用真实进度，否则走流光
- **卸载与升级都由你** —— 有新版只提示、你点一下才装；不需要了就卸载

## 界面预览

**素材库** —— 三个分类页签、卡片点选即用、内置/上传来源标记：

<img src="docs/library.jpg" width="520" height="400" alt="素材库">

## 安装

### 方式一：插件管理器 + 直链（推荐）

DSH 0.2.1+ 自带插件管理器。这条路**不需要 npm，也不需要 git**。

1. 打开 **设置 → 插件**，点 **添加插件**
2. **插件名**填下面这条地址
3. **安装源**保持默认 —— 直链不经过安装源，选哪个都不影响
4. 点 **安装**，完成后刷新页面

```
https://github.com/WWFZS/dsh-plugin-startup-animation/releases/latest/download/dsh-plugin-startup-animation.tgz
```

链接永远指向最新版，收藏一次就够。GitHub 慢的话，用浏览器把同一链接另存为文件，再把
**文件的绝对路径**填进「插件名」（例如 `C:\Users\你\Downloads\dsh-plugin-startup-animation.tgz`），
效果一样。

### 方式二：命令行

```sh
dsh plugin --profile <你的 profile> add https://github.com/WWFZS/dsh-plugin-startup-animation/releases/latest/download/dsh-plugin-startup-animation.tgz
```

本地 `.tgz` 文件或本地目录路径同样可以，把最后一个参数换掉即可。然后重启 `dsh`。

### 方式三：从源码

```sh
git clone https://github.com/WWFZS/dsh-plugin-startup-animation.git
dsh plugin --profile <你的 profile> add /该仓库的绝对路径
```

> **官方 DSH 桌面版**：请从应用内的 **设置 → 插件** 安装（即方式一）。那个 profile
> 归应用的插件管理器管，命令行改动无效。

## 怎么用

打开 **设置 → 开机动画**（入口在侧栏的设置列表里）。

| 控件 | 作用 |
|---|---|
| 显示开机动画 | 总开关。关掉 = Harness 原生启动页。 |
| 视频带声播放 | 让**视频**播它自己的音轨（前提是文件里真的有音轨）。 |
| 开机音频 | 动画期间另播一段音频文件。 |
| 展示时长 | 3–15 秒，视频与壁纸共用。**跳过不受它限制**。 |
| 启动画面素材 | 当前素材预览，以及「恢复默认」（回到内置动画）。 |
| MP4 / 壁纸 / 音频 三个页签 | 点卡片即选用；上传即入库。 |
| 卸载 / 更新 | 装在当前 profile 里时显示。**卸载插件**会把它移除（设置与上传素材保留在磁盘）；有新版时出现**更新到 x.y.z**。两者都要重启 DSH 才生效。从源码目录 `link:` 进来的安装不给更新按钮——那条依赖不指向任何版本。 |

没选素材时，插件会播放**自己的内置动画**（配色随应用深浅色走的旋转徽标）。
选了素材就用素材；「恢复默认」把它换回内置动画。把总开关关掉，才是 Harness
原生的启动页。

页面右上角的 **立即刷新** 会重载页面让新配置生效。**任何设置都不需要重启 `dsh`。**

### 版本与更新

设置页标题旁有一枚很小的版本号——显示你**实际装上的**版本，直接读包自己的清单。

- **已是最新**：只显示 `v1.2.3`（你装的那一版），不打扰你。
- **有新版**：变成 `v1.2.3 · 更新到 1.2.4` 按钮，点一下**就地更新**（下载 Release 里的
  tgz、替换自己的文件），完成后重启 DSH 即可——不用去 GitHub 手动下包。
- **检查不到**：离线、防火墙拦了、或者 GitHub 不可达时，就只是一枚安静的版本号。
  它**不会变成报错状态**——更新检查是锦上添花，不是插件的依赖。

插件**不会在你不知情时更新自己**：没有定时、没有后台检查着就动手。只有你点那颗
按钮、或自己跑命令，更新才会发生：

```sh
# 覆盖安装，设置与已上传素材都会保留
dsh plugin --profile <你的 profile> add https://github.com/WWFZS/dsh-plugin-startup-animation/releases/latest/download/dsh-plugin-startup-animation.tgz
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
| 视频 | `mp4` `m4v` `webm` `ogv` `ogg` | 等待期间循环播放。内置为 1080p / 5–8s / faststart（`dsh-大肥鱼` 为 720p）。 |
| 图片 | `gif` `apng` `webp` `png` `jpg` `jpeg` | `gif`/`apng`/`webp` 会动；静图带缓慢呼吸缩放。 |
| 音频 | `mp3` `wav` `m4a` `aac` `flac` `opus` | 仅用于开机音频。 |

上传落盘目录：`$DSH_HOME/startup-animation-media/`，单文件上限 **128 MiB**。

## 内置素材库

以下全部随包分发，在列表里直接可选：

- **MP4** —— 4 段，全部为 H.264 faststart（可直接流式播放，每段 1.6–6.6 MB）。
  `dsh-大肥鱼` 带语音音轨（打开「视频带声播放」即可听到），另外三段无音轨
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
node tools/preflight.mjs             # 全套检查 + 出发布目录
node selftest.mjs                    # 纯函数 + HTTP 语义测试
node tools/boot-runtime.mjs          # boot.js 运行时行为测试（DOM 垫片 + 可控时钟）
node tools/client-test.mjs           # 设置页行为测试（React 垫片）
node tools/boot-css-test.mjs         # 开机动画样式测试（真浏览器）
node tools/host-smoke.mjs            # 用真实路由处理器跑一遍 HTTP
node tools/make-thumbs.mjs           # 重新生成列表缩略图（需要 ffmpeg）
node tools/optimize-builtin.mjs      # 重新生成 faststart 变体（需要 ffmpeg）
```

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

内置素材仅用于演示；商业再分发前请先看仓库里的 [ASSETS.md](ASSETS.md) 确认每个文件的来源。
