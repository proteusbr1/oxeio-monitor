"""
oXeio brand icon -> Windows `.ico`

The geometry is EXACTLY that of `web/public/favicon.svg`: a red tile (rx 112/512),
a white X, in a 512 box. That file is the single source for all icons, so the
numbers were not rewritten "nicely" here; they are just scaled.

Careful: the SVG is deliberately NOT parsed. cairosvg/Inkscape are not on this machine,
and a new dependency would break the build on anyone else's machine. The shape is only
three paths, so drawing it directly is safe.

Careful: every size is drawn SEPARATELY with 8x supersampling, not by shrinking one big
image. The difference is clear at 16px: when shrunk, the strokes of the X turn grey and
fade away.
"""

import io
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw

# ── numbers from favicon.svg, in the 512 box ────────────────────────────────
BOX = 512.0
CORNER = 112.0 / BOX          # corner radius of the tile
RED = (237, 28, 36, 255)      # #ed1c24
WHITE = (255, 255, 255, 255)

# The two strokes of the X: exactly the two SVG paths
STROKES = (
    ((102, 102), (196, 102), (410, 410), (316, 410)),
    ((316, 102), (410, 102), (196, 410), (102, 410)),
)

SS = 8  # supersampling factor

#: Careful: 256 must be there. The large-icon view of Windows 10/11 asks for it, and
#: without it the 48px one is stretched and looks blurry.
SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)


def render(px: int) -> Image.Image:
    """One icon size: drawn at its own size, then downscaled once."""
    n = px * SS
    k = n / BOX

    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # The tile: filled right to the corners, no transparency inside
    d.rounded_rectangle((0, 0, n - 1, n - 1), radius=CORNER * n, fill=RED)

    for stroke in STROKES:
        d.polygon([(x * k, y * k) for x, y in stroke], fill=WHITE)

    # Careful: LANCZOS. With BILINEAR the stroke edges go soft at small sizes
    return img.resize((px, px), Image.LANCZOS)


def write_ico(path: Path, images: list[Image.Image]) -> None:
    """
    Writes the ICO file by hand.

    Careful: Pillow's `save(format='ICO')` drops sizes above 256 AND resizes the small
    sizes itself, so it would not use our separately drawn 16px at all and all the
    effort would be wasted.
    """
    blobs = []
    for img in images:
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        blobs.append(buf.getvalue())

    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)

    entries = b""
    for img, blob in zip(images, blobs):
        w = 0 if img.width >= 256 else img.width
        h = 0 if img.height >= 256 else img.height
        entries += struct.pack(
            "<BBBBHHII", w, h, 0, 0, 1, 32, len(blob), offset
        )
        offset += len(blob)

    path.write_bytes(header + entries + b"".join(blobs))


def main() -> int:
    # Careful: the Windows console defaults to cp1252; printing Unicode made the script
    #    crash AFTER writing the file, and the build wrongly looked failed.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    out = Path(sys.argv[1] if len(sys.argv) > 1 else "oxeio.ico")
    images = [render(s) for s in SIZES]
    write_ico(out, images)

    print(f"✅ {out} · {', '.join(str(s) for s in SIZES)} · {out.stat().st_size:,} bytes")

    # Also a PNG to look at: whether it reads well at small sizes cannot be judged
    #    from the code, you have to look.
    preview = out.with_suffix(".preview.png")
    strip = Image.new("RGBA", (sum(SIZES) + 8 * len(SIZES), 256), (13, 17, 23, 255))
    x = 0
    for img, s in zip(images, SIZES):
        strip.paste(img, (x, (256 - s) // 2), img)
        x += s + 8
    strip.save(preview)
    print(f"   preview → {preview}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
