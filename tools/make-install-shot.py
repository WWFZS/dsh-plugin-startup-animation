"""Dev helper: rebuild docs/install.jpg from a fresh plugin-manager capture.

- source: a raw screenshot of the real "添加插件" dialog
- output: 1040x800 JPEG (README displays it at 520x400 @2x)
- method: blurred-cover pad, so nothing is cropped and the modal stays whole
  (same treatment as docs/startup.jpg, so the three README images read as a set)

Usage: python tools/make-install-shot.py <raw.png>
"""
import sys
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter

W, H = 1040, 800


def pad_blur(src_path, dst_path, quality=86):
    img = Image.open(src_path).convert("RGB")
    # background: cover
    scale = max(W / img.width, H / img.height)
    bg = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    left = (bg.width - W) // 2
    top = (bg.height - H) // 2
    bg = bg.crop((left, top, left + W, top + H))
    bg = bg.filter(ImageFilter.GaussianBlur(28))
    bg = ImageEnhance.Brightness(bg).enhance(0.42)
    # foreground: contain
    fscale = min(W / img.width, H / img.height)
    fg = img.resize((round(img.width * fscale), round(img.height * fscale)), Image.LANCZOS)
    ox = (W - fg.width) // 2
    oy = (H - fg.height) // 2
    bg.paste(fg, (ox, oy))
    bg.save(dst_path, "JPEG", quality=quality, optimize=True)
    print(dst_path, bg.size)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python tools/make-install-shot.py <raw.png>")
        raise SystemExit(2)
    src = Path(sys.argv[1])
    if not src.exists():
        print(f"not found: {src}")
        raise SystemExit(2)
    pad_blur(str(src), "docs/install.jpg")
