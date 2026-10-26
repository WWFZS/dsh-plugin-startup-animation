# 素材来源 / Asset provenance

`startup-animation/builtin/` 里的素材用于演示插件能力。**再分发前请自行确认每个文件的授权**。
本文件记录的是它们当前的用途与处理方式，不构成任何授权声明。

## MP4（3 段）

| 文件 | 发布用文件 | 来源 | 处理 |
|---|---|---|---|
| `傍晚海风-海边.mp4` | `傍晚海风-海边.web.mp4` | 待补充 | 4K60 → 1080p H.264 faststart，去音轨，截到 8s |
| `光影-动漫美女-彩色.mp4` | `光影-动漫美女-彩色.web.mp4` | 待补充 | 4K60 → 1080p，同上（原始 moov 在文件尾，无法流式播放） |
| `多重影像.mp4` | `多重影像.web.mp4` | 待补充 | 1080p60 25.6s → 1080p 8s |

原始 4K 母版只留在开发仓库，**不随包分发**。

## 图片（7 张）

`中华人民共和国-五星.jpg`、`党徽-共产主义接班人.png`、`写真-壁纸-性感.jpg`、
`创意拼贴-彼得帕克.jpg`、`包臀裙-卧室-好看.jpg`、`卷发美女-哥特风.jpg`、`漫威-漫威宇宙.jpg`

均为演示用静态壁纸。`.thumbs/` 下是构建期生成的 480px 缩略图（由 `tools/make-thumbs.mjs` 产出）。

## 音频（9 段）

`主人-欢迎回家.mp3`、`四川话-魔法披风.mp3`、`宝宝安慰.mp3`、`广告-DeepSeek.mp3`、
`欢迎主人回来，记得给....mp3`、`欢迎龙王归来.mp3`、`河南-辣椒炒肉拌面.mp3`、
`甜美-按时吃饭.mp3`、`秘书.mp3`

均为演示用语音片段。

## 替换成你自己的素材

保留目录结构即可，插件按扩展名自动分类：

```
startup-animation/builtin/MP4/<任意名>.mp4
startup-animation/builtin/图片/<任意名>.jpg|png|webp|gif
startup-animation/builtin/音频/<任意名>.mp3|wav|m4a|flac|opus
```

然后重新生成缩略图 / 压缩版：

```sh
node tools/make-thumbs.mjs
node tools/optimize-builtin.mjs
node tools/make-release.mjs
```
