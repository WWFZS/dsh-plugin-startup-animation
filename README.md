# Startup Animation · 开机动画

> A full-screen animated startup screen for **DeepSeek Harness** — shown while Harness boots,
> click anywhere to skip. Ships a built-in video / wallpaper / audio library out of the box,
> and accepts your own media.

[中文说明](README.zh.md) | English

---

## What it does

While DeepSeek Harness starts up, this plugin puts a full-screen animation in front of the
loading screen. It **listens for the app being ready** and fades out exactly when the real UI
takes over — you never wait on the animation itself.

- **Works with zero configuration.** Install it and you get the built-in animated startup
  screen immediately; nothing to set up.
- **Two ways to start**: pick a frame from the built-in library (3 videos, 7 wallpapers,
  9 voice clips), or upload your own MP4 / WebM / GIF / PNG / JPG / MP3.
- **Startup audio** can play during the animation, independently of the video, with its own
  volume and a fade-out synced to the animation's exit.
- **Never traps you**: click, press `Esc` / `Enter` / `Space`, or just wait — every path exits.
  If the animation itself fails in any way, the stock boot screen shows and nothing else
  changes.
- **Real progress bar** when the kernel exposes its boot progress arc; a shimmer otherwise.

### Screenshots

> Add your own screenshots to `docs/screenshot-*.png` and reference them here.

## Install

### From the Plugin Market (recommended)

DSH 0.2.1+ ships a plugin manager. Open **Settings → Plugins**, search for
**Startup Animation**, install, then refresh the page.

### From this repository

```sh
dsh plugin --profile <your-profile> add github:<your-account>/dsh-plugin-startup-animation
```

Then restart `dsh`. On the official DSH Desktop app, install from the app's own
**Settings → Plugins** instead — that profile belongs to the app's plugin manager.

### Manual

```sh
git clone https://github.com/<your-account>/dsh-plugin-startup-animation.git
dsh plugin --profile <your-profile> add /absolute/path/to/dsh-plugin-startup-animation
```

## Using it

Open **Settings → Startup Animation** (the entry sits in the sidebar settings list).

| Control | What it does |
|---|---|
| Show startup animation | Master switch. Off = the stock Harness boot screen. |
| Play video with sound | Let the *video* play its own audio track (separate from startup audio). |
| Startup audio | Play a voice clip during the animation. The video is muted while this is on. |
| Display duration | 3–15 seconds, shared by videos and wallpapers. Skipping is never delayed by it. |
| Startup visual | Current media preview, plus **Restore default**. |
| MP4 / Wallpaper / Audio tabs | Click any card to use it. Upload adds to the library. |

**Refresh now** (top right of the page) reloads the page so the new settings take effect.
No restart of `dsh` is needed for any setting.

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
| Video | `mp4` `m4v` `webm` `ogv` `ogg` | Looped while waiting. Built-ins ship as 1080p/8s faststart files. |
| Image | `gif` `apng` `webp` `png` `jpg` `jpeg` | `gif`/`apng`/`webp` animate; stills get a slow "breathing" zoom. |
| Audio | `mp3` `wav` `m4a` `aac` `flac` `opus` | Startup audio only. |

Upload path: `$DSH_HOME/startup-animation-media/`. Uploads are capped at **128 MiB** each.

## Built-in library

Everything below ships inside the package and appears in the picker:

- **MP4** — 3 clips, transcoded from 4K masters to 1080p H.264 faststart (1.6–6.6 MB each)
- **壁纸 / Wallpaper** — 7 stills, with pre-generated 480 px thumbnails for the picker
- **音频 / Audio** — 9 voice clips

## How it stays out of your way

- The overlay lives on `document.body`, **not** in `#root` — it cannot disturb the app's
  hydration.
- Every failure path (missing file, broken codec, blocked autoplay, slow kernel) has a time
  bound and falls back to the stock boot screen.
- The media route does `Range`/`ETag` correctly, so seeking works and partial responses are
  never cached as if they were the whole file.
- Uploaded files are deleted for real; built-in files are only hidden from the list, so the
  package stays intact.

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
node ../selftest.mjs        # pure-function + HTTP semantics suite
node ../tools/host-smoke.mjs  # drives the real route handlers over HTTP
node ../tools/make-thumbs.mjs # regenerate picker thumbnails (needs ffmpeg)
node ../tools/optimize-builtin.mjs # regenerate 1080p faststart variants (needs ffmpeg)
```

## License

MIT — see [LICENSE](LICENSE).

Built-in media is distributed for demonstration purposes; check the repository's
`ASSETS.md` for per-file provenance before redistributing it commercially.
