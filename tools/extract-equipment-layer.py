"""
Extract equipment overlay spritesheets by diffing a base character against
a character wearing equipment.

Usage:
  python tools/extract-equipment-layer.py <base_dir> <equipped_dir> <output_dir> [--threshold 30] [--target-size 92]

  base_dir     - directory with base character spritesheets (e.g. walk_south.png)
  equipped_dir - directory with equipped character spritesheets (same filenames)
  output_dir   - where to write the overlay spritesheets

Each pixel in the output is:
  - Transparent (alpha=0) if the equipped pixel is close to the base pixel
  - The equipped pixel (with full alpha) if it differs beyond the threshold

The threshold is the Euclidean RGB distance (0-441). Default 30.

If base and equipped have different canvas sizes (e.g. base 92x92, equipped 132x132),
the smaller image is padded to match the larger, aligned at bottom-center (feet position).
The final overlay is then cropped to --target-size (default: 92) per frame.
"""
import os
import sys
import math
from PIL import Image

THRESHOLD = 30
TARGET_SIZE = 92


def color_distance(r1: int, g1: int, b1: int, r2: int, g2: int, b2: int) -> float:
    return math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2)


def pad_to_size(img: Image.Image, target_w: int, target_h: int) -> Image.Image:
    """Pad image to target size, aligned at bottom-center (feet stay fixed)."""
    w, h = img.size
    if w == target_w and h == target_h:
        return img.copy()

    padded = Image.new('RGBA', (target_w, target_h), (0, 0, 0, 0))
    # Bottom-center alignment: feet at bottom of frame
    x_offset = (target_w - w) // 2
    y_offset = target_h - h  # align bottom
    padded.paste(img, (x_offset, y_offset))
    return padded


def crop_to_size(img: Image.Image, frame_w: int, frame_h: int, target_w: int, target_h: int) -> Image.Image:
    """Crop spritesheet frames from frame_w to target_w, bottom-center aligned."""
    w, h = img.size
    num_frames = w // frame_w

    result = Image.new('RGBA', (num_frames * target_w, target_h), (0, 0, 0, 0))

    for i in range(num_frames):
        # Extract frame
        frame = img.crop((i * frame_w, 0, (i + 1) * frame_w, frame_h))
        # Crop to target size, bottom-center
        x_offset = (frame_w - target_w) // 2
        y_offset = frame_h - target_h  # keep bottom (feet)
        cropped = frame.crop((x_offset, y_offset, x_offset + target_w, y_offset + target_h))
        result.paste(cropped, (i * target_w, 0))

    return result


def extract_overlay_strip(base_path: str, equipped_path: str, threshold: float, target_size: int) -> Image.Image:
    """Extract overlay from spritesheet strips, handling size mismatches."""
    base = Image.open(base_path).convert('RGBA')
    equipped = Image.open(equipped_path).convert('RGBA')

    base_frame_h = base.size[1]
    equip_frame_h = equipped.size[1]

    # Determine frame width (= frame height for square frames)
    base_frame_w = base_frame_h
    equip_frame_w = equip_frame_h

    base_frames = base.size[0] // base_frame_w
    equip_frames = equipped.size[0] // equip_frame_w
    num_frames = min(base_frames, equip_frames)

    # Work at the larger canvas size for diffing
    work_size = max(base_frame_h, equip_frame_h)
    overlay_strip = Image.new('RGBA', (num_frames * work_size, work_size), (0, 0, 0, 0))

    for f in range(num_frames):
        # Extract individual frames
        base_frame = base.crop((f * base_frame_w, 0, (f + 1) * base_frame_w, base_frame_h))
        equip_frame = equipped.crop((f * equip_frame_w, 0, (f + 1) * equip_frame_w, equip_frame_h))

        # Pad both to work_size (bottom-center aligned)
        base_padded = pad_to_size(base_frame, work_size, work_size)
        equip_padded = pad_to_size(equip_frame, work_size, work_size)

        # Diff
        base_px = base_padded.load()
        equip_px = equip_padded.load()
        overlay_frame = Image.new('RGBA', (work_size, work_size), (0, 0, 0, 0))
        overlay_px = overlay_frame.load()

        for y in range(work_size):
            for x in range(work_size):
                br, bg, bb, ba = base_px[x, y]
                er, eg, eb, ea = equip_px[x, y]

                if ea == 0:
                    continue
                if ba == 0 and ea > 0:
                    overlay_px[x, y] = (er, eg, eb, ea)
                    continue
                dist = color_distance(br, bg, bb, er, eg, eb)
                if dist > threshold:
                    overlay_px[x, y] = (er, eg, eb, ea)

        overlay_strip.paste(overlay_frame, (f * work_size, 0))

    # Crop to target size if needed
    if work_size != target_size:
        overlay_strip = crop_to_size(overlay_strip, work_size, work_size, target_size, target_size)

    return overlay_strip


def process_directory(base_dir: str, equipped_dir: str, output_dir: str, threshold: float, target_size: int):
    os.makedirs(output_dir, exist_ok=True)

    processed = 0
    skipped = 0

    for filename in sorted(os.listdir(equipped_dir)):
        if not filename.endswith('.png'):
            continue

        base_path = os.path.join(base_dir, filename)
        equipped_path = os.path.join(equipped_dir, filename)

        if not os.path.exists(base_path):
            print(f"  SKIP {filename} (no base)")
            skipped += 1
            continue

        try:
            overlay = extract_overlay_strip(base_path, equipped_path, threshold, target_size)
            output_path = os.path.join(output_dir, filename)
            overlay.save(output_path)

            # Count non-transparent pixels
            overlay_px = overlay.load()
            w, h = overlay.size
            opaque = sum(1 for y in range(h) for x in range(w) if overlay_px[x, y][3] > 0)
            total = w * h
            print(f"  OK   {filename} -> {overlay.size} ({opaque} opaque / {total} total)")
            processed += 1
        except Exception as e:
            print(f"  ERR  {filename}: {e}")
            skipped += 1

    print(f"\nDone: {processed} processed, {skipped} skipped")


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)

    base_dir = sys.argv[1]
    equipped_dir = sys.argv[2]
    output_dir = sys.argv[3]

    threshold = THRESHOLD
    if '--threshold' in sys.argv:
        idx = sys.argv.index('--threshold')
        threshold = float(sys.argv[idx + 1])

    target_size = TARGET_SIZE
    if '--target-size' in sys.argv:
        idx = sys.argv.index('--target-size')
        target_size = int(sys.argv[idx + 1])

    print(f"Base:        {base_dir}")
    print(f"Equipped:    {equipped_dir}")
    print(f"Output:      {output_dir}")
    print(f"Threshold:   {threshold}")
    print(f"Target size: {target_size}x{target_size}")
    print()

    process_directory(base_dir, equipped_dir, output_dir, threshold, target_size)


if __name__ == '__main__':
    main()
