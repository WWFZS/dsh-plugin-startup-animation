# dsh-plugin-startup-animation

给 **DeepSeek Harness** 加一个全屏开机动画：启动时盖在加载页前播放，点画面任意处跳过。
内置 3 段视频、7 张壁纸、9 段语音，也能用自己的素材。

[English](startup-animation/README.md) · [中文](startup-animation/README.zh.md)

---

## 安装

```sh
# 从 GitHub 直接装
dsh plugin --profile <你的 profile> add github:<你的账号>/dsh-plugin-startup-animation

# 或本地路径
dsh plugin --profile <你的 profile> add /到本仓库的绝对路径
```

装有 DSH 0.2.1+ 的话，也可以直接在 **设置 → 插件** 里搜索安装。

安装后重启一次 `dsh`，然后到 **设置 → 开机动画** 里挑素材。之后改任何设置只要点
「立即刷新」，都不用再重启。

## 这个仓库里有什么

| 路径 | 说明 |
|---|---|
| `startup-animation/` | **插件本体**（发布目录就是它，无 npm 依赖、无构建步骤） |
| `startup-animation/builtin/` | 内置视频 / 壁纸 / 音频 |
| `selftest.mjs` | 纯函数 + HTTP 语义测试 |
| `tools/host-smoke.mjs` | 用真实路由处理器跑一遍完整 HTTP 流程 |
| `tools/preflight.mjs` | 发布前一键检查（语法 → 测试 → 构建 → 打包） |
| `tools/make-release.mjs` | 生成可直接发布的 `dist/`（去掉 4K 母版） |
| `tools/optimize-builtin.mjs` | 把 4K 母版转成 1080p faststart（开发用，需要 ffmpeg） |
| `tools/make-thumbs.mjs` | 生成素材列表缩略图（开发用，需要 ffmpeg） |

## 开发

```sh
node tools/preflight.mjs      # 全套检查 + 出发布目录
node tools/preflight.mjs --skip-build   # 跳过 ffmpeg 构建步骤
```

## 技术要点

- **零依赖**：宿主半边只用 `node:` 内建，客户端只 `require('react')`。
- **不阻塞启动**：动画任何一步失败都安静回落到 Harness 原生启动页。
- **注入策略**：桌面壳在宿主启动时只收集一次注入表，所以注入行无条件注册，
  「显示什么 / 显示多久」由运行时每次页面加载实时读取——改配置刷新即生效。
- **素材分发**：1080p faststart 变体（`*.web.mp4`）+ 预生成缩略图，
  4K 母版只留在开发仓库，不进包。

## 许可证

代码 MIT。内置素材仅用于演示，见 [ASSETS.md](ASSETS.md)。
