<div align="center">

<img src="docs/startup.jpg" width="700" alt="Startup animation preview">

# Startup Animation

English | [简体中文](README.zh.md)

A full-screen startup animation, for your DeepSeek Harness.

Plays on boot · Click to skip · Zero dependencies · Built-in library

<a href="https://github.com/WWFZS/dsh-plugin-startup-animation/releases"><img src="https://img.shields.io/github/v/release/WWFZS/dsh-plugin-startup-animation?style=flat-square&label=VERSION&color=4d6bfe" alt="Version"></a>
<img src="https://img.shields.io/badge/DSH-0.2.0%2B-4d6bfe?style=flat-square" alt="DSH">
<img src="https://img.shields.io/badge/dependencies-0-2ea44f?style=flat-square" alt="No deps">
<img src="https://img.shields.io/badge/size-26%20MB-6e7681?style=flat-square" alt="Size">
<img src="https://img.shields.io/badge/License-MIT-2ea44f?style=flat-square" alt="License">
<img src="https://img.shields.io/badge/Author-WWFZS-8957e5?style=flat-square" alt="Author">

[Install](#install) · [Screenshots](#screenshots) · [Usage](#usage) · [Compatibility](#compatibility-with-future-dsh-releases) · [Releases](https://github.com/WWFZS/dsh-plugin-startup-animation/releases) · [Build](#development)

</div>

---

## Overview

**Startup Animation** is a full-screen boot screen plugin for DeepSeek Harness. While Harness
starts up it covers the loading page, and it **listens for the app actually being ready** —
the overlay fades out the moment the real UI takes over, so you are always waiting on the
application, never on the animation.

The plugin attaches through two kernel extension points: `webserver/index-inject` for the
overlay and styles, and `webServer.register` for the media and management routes. It has
**zero npm dependencies**, and its browser half only `require`s `react` from the host's module
table — install and use, no build step.

Out of the box it ships **4 videos / 7 wallpapers / 9 voice clips**, and accepts your own
MP4 / WebM / GIF / PNG / JPG / MP3. Audio is split into three independent switches that you
decide yourself.

## Highlights

- **Works with zero configuration** — install it and the built-in animation plays immediately
- **Two ways to start** — pick from the built-in library, or upload your own files
- **Three independent audio switches** — video with a sound track, silent video, standalone clip
- **Never traps you** — click, `Esc` / `Enter` / `Space`, or just wait; every path exits
- **Fails silently** — any failure falls back to the stock boot screen, never blocking startup
- **Real progress bar** when the kernel exposes its boot progress arc, a shimmer otherwise
- **No self-update** — it only reports a newer release and links to it; you decide

## Screenshots

**Media library** — three category tabs, click a card to apply it, built-in vs uploaded labelled:

<img src="docs/library.jpg" width="700" alt="Media library">

## Install

### 1. Add it in the DSH plugin manager (recommended)

DSH 0.2.1+ ships a plugin manager — no command line needed.

1. Open **Settings → Plugins** and click **Add plugin**
2. Enter the package name `dsh-plugin-startup-animation`
3. Set **Install source** to *Custom address* and enter `https://github.com/`
4. Click **Install**, then refresh the page

<img src="docs/install.jpg" width="520" alt="Add plugin dialog">

> Expand the dialog's guide panel and confirm the install source really reads
> *Custom address* before installing.
>
> If GitHub is slow from your network, you can switch the source to the mainland-China
> npm mirror, but this plugin is published on GitHub only — the mirror may not have it.

### 2. Command line

```sh
dsh plugin --profile <your-profile> add github:WWFZS/dsh-plugin-startup-animation
```

Then restart `dsh`.

### 3. Local directory

```sh
git clone https://github.com/WWFZS/dsh-plugin-startup-animation.git
dsh plugin --profile <your-profile> add /absolute/path/to/dsh-plugin-startup-animation
```

> **Official DSH Desktop app**: install through the app's own **Settings → Plugins**
> (method 1). That profile belongs to the app's plugin manager; CLI changes are ignored.

## Usage

Open **Settings → Startup Animation** (the entry sits in the sidebar settings list).

| Control | What it does |
|---|---|
| Show startup animation | Master switch. Off = the stock Harness boot screen. |
| Play video with sound | Let the *video* play its own audio track, if the file has one. |
| Startup audio | Play a separate audio clip during the animation. |
| Display duration | 3–15 seconds, shared by videos and wallpapers. Skipping is never delayed by it. |
| Startup visual | Current media preview, plus **Restore default**. |
| MP4 / Wallpaper / Audio tabs | Click any card to use it. Upload adds to the library. |

**Refresh now** (top right of the page) reloads the page so the new settings take effect.
No restart of `dsh` is needed for any setting.

### Version and updates

The settings title bar carries a small version label — the version you actually
installed, read from the package's own manifest.

- **Up to date**: just `v1.2.3` (your installed version), nothing else. No nagging.
- **Newer release exists**: it turns into `v1.2.3 · Version 1.2.4 available`,
  and clicking it opens the GitHub release page so you can read the changes.
- **Check unavailable**: offline, behind a firewall, or GitHub being unreachable
  leaves the label as a plain version number. It never turns into an error state —
  the update check is a convenience, not a dependency.

The plugin **never updates itself**. There is no code path that downloads or
overwrites its own files: updating means you run the command below (or use the
plugin manager), so a bad release can never land on your machine unasked.

```sh
# replace, keeping your settings and uploaded media
dsh plugin --profile <your-profile> add github:WWFZS/dsh-plugin-startup-animation
```

Your configuration (`$DSH_HOME/startup-animation.json`) and uploaded media
(`$DSH_HOME/startup-animation-media/`) live outside the package and survive updates.

### Configuration file

Settings are stored in `$DSH_HOME/startup-animation.json` (usually
`~/.dsh/startup-animation.json`). You can edit it directly:

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

`file` accepts a `builtin/...` relative path or an absolute path to your own media.
Everything else has a sane default; see [`index.js`](index.js) `DEFAULT_CONFIG`.

## Supported media

| Kind | Formats | Notes |
|---|---|---|
| Video | `mp4` `m4v` `webm` `ogv` `ogg` | Looped while waiting. Built-ins ship as 1080p / 8s / faststart files. |
| Image | `gif` `apng` `webp` `png` `jpg` `jpeg` | `gif`/`apng`/`webp` animate; stills get a slow "breathing" zoom. |
| Audio | `mp3` `wav` `m4a` `aac` `flac` `opus` | Startup audio only. |

Upload path: `$DSH_HOME/startup-animation-media/`. Uploads are capped at **128 MiB** each.

## Built-in library

Everything below ships inside the package and appears in the picker:

- **MP4** — 4 clips, all H.264 faststart so they start streaming immediately (1.6–6.6 MB each).
  `dsh-大肥鱼` has a spoken sound track (turn on **Play video with sound** to hear it);
  the other three are silent by design
- **Wallpaper** — 7 stills, with pre-generated 480 px thumbnails for the picker
- **Audio** — 9 voice clips

## How it stays out of your way

- The overlay lives on `document.body`, **not** in `#root` — it cannot disturb the app's
  hydration.
- Every failure path (missing file, broken codec, blocked autoplay, slow kernel) has a time
  bound and falls back to the stock boot screen.
- The media route does `Range`/`ETag` correctly, so seeking works and partial responses are
  never cached as if they were the whole file.
- Uploaded files are deleted for real; built-in files are only hidden from the list, so the
  package stays intact.

## Compatibility with future DSH releases

DeepSeek Harness moves fast, and this plugin touches two kernel extension points
(`webserver/index-inject` for the boot overlay, `webServer.register` for routes and
the media server). Both are handled so that a future kernel change degrades the
plugin instead of breaking your Harness:

| If a future DSH changes... | What happens |
|---|---|
| the `webserver/index-inject` event name or signature | the plugin logs one warning and boots **without** the animation; the stock boot screen shows |
| the `webServer` service (routes, media serving) | no settings entry is offered; the rest of Harness is untouched |
| the settings slot API (`settings.section`) | the settings entry disappears; nothing throws |
| anything else at runtime | every failure path falls back to the native boot screen — the overlay is never allowed to block startup |

Declared compatibility (`engines.dsh`, mirrored into `dsh.engines` so both the
plugin manager and the market can read it) is `>=0.2.0`. The plugin also has **zero
npm dependencies**, and its browser half only `require`s `react` from the host's
module table — so there is no bundled copy of anything that could fall out of sync
with a newer kernel.

The startup log names both the plugin version and, when readable, the host kernel
version. If an upgrade ever breaks the animation, that line is the first thing to
look at.

## Requirements

- DeepSeek Harness **0.2.0+** (Web UI)
- Node.js ≥ 22.12.0 (whatever the bundled Harness runs on)

The plugin has no npm dependencies and no build step at install time — it is plain ESM
plus static assets.

## Uninstall

```sh
dsh plugin --profile <your-profile> remove dsh-plugin-startup-animation
```

Uploaded media in `$DSH_HOME/startup-animation-media/` is yours; the plugin never deletes it
for you.

## Development

```sh
node tools/preflight.mjs            # full check + release directory
node selftest.mjs                   # pure-function + HTTP semantics suite
node tools/host-smoke.mjs           # drives the real route handlers over HTTP
node tools/make-thumbs.mjs          # regenerate picker thumbnails (needs ffmpeg)
node tools/optimize-builtin.mjs     # regenerate faststart variants (needs ffmpeg)
```

## License

MIT — see [LICENSE](LICENSE).

Built-in media is distributed for demonstration purposes; check [ASSETS.md](ASSETS.md) for
per-file provenance before redistributing it commercially.
