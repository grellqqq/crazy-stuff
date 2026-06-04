"""
Slice character strip-sheets back into individual base frames.

The transfer-outfit pipeline needs per-frame PNGs (e.g. walk_south_f1.png) as
its base, but rendered characters live on disk as horizontal strips
(walk_south.png = N frames laid left-to-right). This reverses that: it cuts each
strip into FRAME-wide tiles named to match what transfer-outfit-batch.py expects.

Frame count is derived from strip width (width // FRAME) so it works for any
animation without a hardcoded frame table:
  idle.png        736x92 -> idle_f1..f8     (8-direction rotation strip)
  walk_south.png  552x92 -> walk_south_f1..f6
  jump_east.png   828x92 -> jump_east_f1..f9

Usage:
  python tools/slice-base-frames.py female          # characters/female -> base-female-frames
  python tools/slice-base-frames.py <src_dir> <out_dir>   # explicit paths
"""

import sys
from pathlib import Path
from PIL import Image

FRAME = 92  # base character frame size in px (square)


def slice_sheets(src_dir: Path, out_dir: Path) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    count = 0
    for sheet in sorted(src_dir.glob("*.png")):
        img = Image.open(sheet).convert("RGBA")
        w, h = img.size
        if h != FRAME or w % FRAME != 0:
            print(f"  SKIP {sheet.name}: {w}x{h} is not a {FRAME}px-tall strip")
            continue
        n = w // FRAME
        stem = sheet.stem  # e.g. "walk_south-east" or "idle"
        for i in range(n):
            frame = img.crop((i * FRAME, 0, (i + 1) * FRAME, FRAME))
            frame.save(out_dir / f"{stem}_f{i + 1}.png")
            count += 1
        print(f"  {sheet.name}: {n} frames -> {stem}_f1..f{n}")
    return count


def main():
    args = sys.argv[1:]
    if not args:
        print("Usage: python tools/slice-base-frames.py <body|src_dir> [out_dir]")
        sys.exit(1)

    if len(args) == 1:
        # Shorthand: a body/character name. Resolve standard project paths.
        name = args[0]
        src_dir = Path(f"src/client/public/sprites/characters/{name}")
        out_dir = Path(f"tools/pixellab-downloads/v2/base-{name}-frames")
    else:
        src_dir = Path(args[0])
        out_dir = Path(args[1])

    if not src_dir.is_dir():
        print(f"ERROR: source dir not found: {src_dir}")
        sys.exit(1)

    print(f"Slicing {src_dir} -> {out_dir}")
    total = slice_sheets(src_dir, out_dir)
    print(f"\nSliced {total} frames into {out_dir}")


if __name__ == "__main__":
    main()
