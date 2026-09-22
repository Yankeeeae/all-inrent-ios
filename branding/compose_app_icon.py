"""Compose the iOS app icon from the official AIR logo. Does not redraw the mark."""

from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

LOGO = Path(r"c:\Users\casse\Desktop\Govagov\GovaGov\public\logo-air.png")
OUT_DIR = Path(r"c:\Users\casse\Desktop\Govagov\all-inrent-ios\branding")
APPICON = Path(
    r"c:\Users\casse\Desktop\Govagov\all-inrent-ios\ios\ALLINRENT"
    r"\Assets.xcassets\AppIcon.appiconset\AppIcon.png"
)

MASTER = 4096
BLUE = np.array([0x1E, 0x63, 0xFF], dtype=np.float32)
WHITE = np.array([255.0, 255.0, 255.0], dtype=np.float32)


def extract_air_mark(src: Image.Image) -> Image.Image:
    img = src.convert("RGBA")
    arr = np.asarray(img)
    r, g, b, a = arr[..., 0], arr[..., 1], arr[..., 2], arr[..., 3]
    ink = (a > 12) & ~((r > 245) & (g > 245) & (b > 245))
    ys, xs = np.where(ink)
    if ys.size == 0:
        raise SystemExit("Official logo has no ink pixels")
    cropped = img.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))
    w, h = cropped.size
    # Wordmark sits under AIR — drop it so the mark stays readable at 60px.
    mark = cropped.crop((0, 0, w, int(h * 0.68)))
    m = np.asarray(mark)
    ink2 = m[..., 3] > 12
    ys2, xs2 = np.where(ink2)
    return mark.crop((int(xs2.min()), int(ys2.min()), int(xs2.max()) + 1, int(ys2.max()) + 1))


def liquid_glass(size: int) -> Image.Image:
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    n = size / 2.0
    nx = (xx - n) / n
    ny = (yy - n) / n
    r = np.sqrt(nx * nx + ny * ny)

    canvas = np.broadcast_to(WHITE, (size, size, 3)).astype(np.float32).copy()

    def mix(amount: np.ndarray, color: np.ndarray) -> None:
        nonlocal canvas
        a = np.clip(amount, 0.0, 1.0)[..., None]
        canvas = canvas * (1.0 - a) + color * a

    # Smooth edge vignette — no ring
    mix(np.clip(r * r, 0.0, 1.0) * 0.16, BLUE)

    # Bottom depth
    mix(np.clip((ny + 0.15) / 1.2, 0.0, 1.0) ** 2.2 * 0.08, BLUE)

    # Top-left liquid highlight
    hd = np.sqrt((nx + 0.42) ** 2 * 0.85 + ((ny + 0.55) * 1.35) ** 2)
    mix(np.exp(-(hd * hd) * 4.8) * 0.62, WHITE)

    # Soft corner bloom
    corners = ((np.abs(nx) ** 3 + np.abs(ny) ** 3) / 2.0)
    mix(corners * 0.14, BLUE)

    np.clip(canvas, 0, 255, out=canvas)
    layer = Image.fromarray(canvas.astype(np.uint8), "RGB")
    return layer.filter(ImageFilter.GaussianBlur(radius=max(1, size // 900)))


def compose(size: int, mark: Image.Image) -> Image.Image:
    bg = liquid_glass(size).convert("RGBA")
    target_w = int(size * 0.76)
    ratio = target_w / mark.size[0]
    target_h = max(1, int(mark.size[1] * ratio))
    logo = mark.resize((target_w, target_h), Image.Resampling.LANCZOS)
    x = (size - target_w) // 2
    y = (size - target_h) // 2
    bg.alpha_composite(logo, (x, y))
    return bg.convert("RGB")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    mark = extract_air_mark(Image.open(LOGO))
    master = compose(MASTER, mark)
    master.save(OUT_DIR / "app-icon-master-4096.png", "PNG", optimize=True)
    store = master.resize((1024, 1024), Image.Resampling.LANCZOS)
    store.save(OUT_DIR / "app-icon-ios-1024.png", "PNG", optimize=True)
    store.save(APPICON, "PNG", optimize=True)
    preview = store.resize((60, 60), Image.Resampling.LANCZOS)
    preview.save(OUT_DIR / "app-icon-preview-60.png", "PNG")
    print("mark", mark.size)
    print("master", master.size, master.mode)
    print("store", store.size, store.mode)


if __name__ == "__main__":
    main()
