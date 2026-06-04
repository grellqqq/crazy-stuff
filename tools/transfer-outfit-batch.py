"""
Batch Transfer Outfit Pro via PixelLab API.
Generates equipped character frames for all directions/animations,
then diffs against base to extract equipment overlays.
"""

import base64, io, json, os, sys, time, requests
from PIL import Image
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

# Config
API_URL = "https://api.pixellab.ai/v2/transfer-outfit-v2"
JOB_URL = "https://api.pixellab.ai/v2/background-jobs"
TOKEN = os.environ["PIXELLAB_API_KEY"]
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

# Body shape: selects which base frames to transfer onto and which overlay
# subfolder to export into. Overridden by --body in main(). Clothing references
# (REF_DIR) are body-agnostic flat-lays, so they are shared across bodies.
BODY = "male"
BASE_DIR = Path("tools/pixellab-downloads/v2/base-male-frames")
REF_DIR = Path("tools/pixellab-downloads/v2/reference")
OUT_DIR = Path("tools/pixellab-downloads/v2/transfer-results/male")
OVERLAY_DIR = Path("src/client/public/sprites/equipment")

DIRECTIONS = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"]
ANIMS = ["idle", "walk", "run", "jump"]
FRAME_COUNTS = {"idle": 4, "walk": 6, "run": 6, "jump": 9}
MAX_BATCH = 3  # hard API limit: transfer-with-reference caps at 3 frames (2x2 grid minus reference)
MAX_CONCURRENT = 2  # parallel API jobs
POLL_INTERVAL = 10  # seconds

ITEMS = {
    "worn_tshirt": {"slot": "upper_body", "ref_dir": "worn_tshirt_92"},
    "blue_jeans": {"slot": "lower_body", "ref_dir": "blue_jeans_92"},
    "beatup_sneakers": {"slot": "feet", "ref_dir": "beatup_sneakers_92"},
}


def img_to_payload(path):
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    img = Image.open(path)
    w, h = img.size
    return {
        "image": {"type": "base64", "base64": b64, "format": "png"},
        "size": {"width": w, "height": h},
    }


def save_result_images(job_data, out_paths):
    images = job_data["last_response"]["images"]
    for i, img_data in enumerate(images):
        if i >= len(out_paths):
            break
        raw = base64.b64decode(img_data["base64"])
        if raw[:8] == b"\x89PNG\r\n\x1a\n":
            # Current API format: base64 is a PNG-encoded image.
            img = Image.open(io.BytesIO(raw)).convert("RGBA")
        else:
            # Legacy format: raw RGBA buffer. Prefer the reported height if
            # present, else infer it from the byte length.
            w = img_data["width"]
            h = img_data.get("height") or (len(raw) // (w * 4))
            img = Image.frombytes("RGBA", (w, h), raw)
        os.makedirs(os.path.dirname(out_paths[i]), exist_ok=True)
        img.save(out_paths[i])


def submit_job(ref_path, frame_paths):
    ref = img_to_payload(ref_path)
    frames = [img_to_payload(p) for p in frame_paths]
    payload = {
        "reference_image": ref,
        "frames": frames,
        "image_size": {"width": 92, "height": 92},
        "no_background": True,
    }
    resp = requests.post(API_URL, headers=HEADERS, json=payload)
    if resp.status_code != 202:
        raise Exception(f"API error {resp.status_code}: {resp.text[:200]}")
    return resp.json()["background_job_id"]


def poll_job(job_id, timeout=300):
    start = time.time()
    while time.time() - start < timeout:
        resp = requests.get(f"{JOB_URL}/{job_id}", headers=HEADERS)
        data = resp.json()
        status = data.get("status", "unknown")
        if status == "completed":
            return data
        elif status == "failed":
            raise Exception(f"Job {job_id} failed: {data}")
        time.sleep(POLL_INTERVAL)
    raise Exception(f"Job {job_id} timed out after {timeout}s")


def build_batches(item_id, item_cfg):
    """Build list of (ref_path, frame_paths, out_paths) tuples."""
    ref_subdir = item_cfg["ref_dir"]
    batches = []

    for direction in DIRECTIONS:
        # Pick reference: use idle_{direction}_f1 from the reference dir
        ref_path = REF_DIR / ref_subdir / f"idle_{direction}_f1.png"
        if not ref_path.exists():
            # Fallback to walk
            ref_path = REF_DIR / ref_subdir / f"walk_{direction}_f1.png"
        if not ref_path.exists():
            print(f"  WARNING: No reference for {item_id} {direction}, skipping")
            continue

        for anim in ANIMS:
            n_frames = FRAME_COUNTS[anim]
            # Collect frame paths
            frame_paths = []
            for fi in range(1, n_frames + 1):
                fp = BASE_DIR / f"{anim}_{direction}_f{fi}.png"
                if fp.exists():
                    frame_paths.append(fp)

            if len(frame_paths) < 2:
                print(f"  WARNING: <2 frames for {anim}_{direction}, skipping")
                continue

            # Split into batches of MAX_BATCH (min 2 per batch)
            chunks = []
            for i in range(0, len(frame_paths), MAX_BATCH):
                chunk = frame_paths[i : i + MAX_BATCH]
                if len(chunk) < 2 and chunks:
                    # Merge single leftover with previous batch's last frame
                    # Actually just add a duplicate to meet minimum
                    chunk.append(chunk[0])
                chunks.append(chunk)

            for ci, chunk in enumerate(chunks):
                out_paths = []
                for fp in chunk:
                    out_name = fp.name
                    out_path = OUT_DIR / item_id / out_name
                    out_paths.append(str(out_path))
                batches.append((str(ref_path), [str(p) for p in chunk], out_paths))

    return batches


def flood_fill(mask, x, y, w, h, visited):
    stack = [(x, y)]
    cluster = []
    while stack:
        cx, cy = stack.pop()
        if cx < 0 or cx >= w or cy < 0 or cy >= h:
            continue
        if visited[cy][cx] or not mask[cy][cx]:
            continue
        visited[cy][cx] = True
        cluster.append((cx, cy))
        for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1)]:
            stack.append((cx + dx, cy + dy))
    return cluster


# Per-slot Y ranges for overlay extraction
SLOT_Y_RANGES = {
    "upper_body": (30, 54),
    "lower_body": (48, 78),
    "feet": (70, 92),         # shoes + lower shin
    "head_accessory": (0, 30),
}

# Per-(slot, anim) Y-range overrides. Jump translates the whole body vertically
# within the 92px frame (crouch down, then extend up), so on some frames the
# torso/legs leave the standing band entirely — the clothing gets clipped to
# nothing and the overlay frame comes out empty, which reads in-game as the
# avatar "flashing" back to bare body mid-jump. Jump therefore uses a much wider
# band; the diff-threshold + cluster filter still reject body/skin noise.
SLOT_ANIM_Y_RANGES = {
    ("upper_body", "jump"): (20, 84),
    ("lower_body", "jump"): (40, 92),
    ("feet", "jump"): (45, 92),   # feet tuck up off the ground mid-jump
}
DIFF_THRESHOLD = 60    # stricter color-change requirement (was 45) — kills faint body-drift pixels
MIN_CLUSTER_SIZE = 25  # larger clusters only (was 10) — kills ghost limbs and stray white pixels
PALETTE_REJECT_DIST = 18  # unused after palette-reject was reverted

# Per-slot overrides — feet is small region, base char already has shoes, so we need sensitive thresholds
SLOT_THRESHOLDS = {
    "feet": {"diff": 25, "min_cluster": 6},
}


def build_base_palette():
    """Collect every unique opaque RGB color from base frames — these are body/hair/eye colors
    we never want to copy into an overlay."""
    palette = set()
    for p in BASE_DIR.glob("*.png"):
        img = Image.open(p).convert("RGBA")
        px = img.load()
        w, h = img.size
        for y in range(h):
            for x in range(w):
                r, g, b, a = px[x, y]
                if a > 0:
                    palette.add((r, g, b))
    return palette


def pixel_matches_palette(rgb, palette, max_dist):
    """True if rgb is within max_dist of any color in palette (euclidean in RGB)."""
    import math
    r1, g1, b1 = rgb
    thresh_sq = max_dist * max_dist
    for (r2, g2, b2) in palette:
        dr, dg, db = r1 - r2, g1 - g2, b1 - b2
        if dr * dr + dg * dg + db * db <= thresh_sq:
            return True
    return False


def diff_and_export(item_id, item_cfg, base_palette=None):
    """Smart diff: extract only clothing pixels using threshold + cluster filter + palette reject + dilation."""
    import math

    slot = item_cfg["slot"]
    result_dir = OUT_DIR / item_id
    export_dir = OVERLAY_DIR / slot / item_id / BODY
    os.makedirs(export_dir, exist_ok=True)

    if base_palette is None:
        print(f"  Building base palette...")
        base_palette = build_base_palette()
        print(f"  Base palette has {len(base_palette)} unique colors")

    default_y_range = SLOT_Y_RANGES.get(slot, (0, 92))
    overrides = SLOT_THRESHOLDS.get(slot, {})
    diff_thresh = overrides.get("diff", DIFF_THRESHOLD)
    min_cluster = overrides.get("min_cluster", MIN_CLUSTER_SIZE)

    for direction in DIRECTIONS:
        for anim in ANIMS:
            n_frames = FRAME_COUNTS[anim]
            overlay_frames = []

            # Resolve the Y-band per anim — jump needs a wider band (see
            # SLOT_ANIM_Y_RANGES) because the body translates vertically.
            y_min, y_max = SLOT_ANIM_Y_RANGES.get((slot, anim), default_y_range)

            for fi in range(1, n_frames + 1):
                result_path = result_dir / f"{anim}_{direction}_f{fi}.png"
                base_path = BASE_DIR / f"{anim}_{direction}_f{fi}.png"

                if not result_path.exists() or not base_path.exists():
                    print(f"  Missing: {result_path.name} or base, skipping")
                    continue

                result_img = Image.open(result_path).convert("RGBA")
                base_img = Image.open(base_path).convert("RGBA")
                rpx = result_img.load()
                bpx = base_img.load()
                w, h = result_img.size

                # Build diff mask (only significant changes in Y range)
                # For feet slot: also reject pixels that look like skin tone (shin drift).
                # Skin tones on this base char cluster around (r>130, g>90, b>70, r>g>b approximately).
                def is_skinlike(rgb):
                    r, g, b = rgb
                    # Typical pinkish/tan skin: red > green > blue, and reasonably bright
                    return (r > 110 and g > 70 and b > 50
                            and r >= g - 5 and g >= b - 5
                            and (r - b) > 15 and (r - b) < 120)

                mask = [[False] * w for _ in range(h)]
                reject_skin = (slot == "feet")
                for y in range(y_min, min(y_max, h)):
                    for x in range(w):
                        r = rpx[x, y]
                        b = bpx[x, y]
                        if r[3] == 0:
                            continue
                        if reject_skin and is_skinlike(r[:3]):
                            continue
                        if b[3] == 0:
                            mask[y][x] = True
                        else:
                            d = math.sqrt(sum((a - c) ** 2 for a, c in zip(r[:3], b[:3])))
                            if d >= diff_thresh:
                                mask[y][x] = True

                # Erode 1px to kill thin body-drift outlines.
                # Feet slot uses a milder erosion (n>=3) to preserve small shoe clusters.
                erode_threshold = 3 if slot == "feet" else 4
                eroded = [[False] * w for _ in range(h)]
                for y in range(h):
                    for x in range(w):
                        if not mask[y][x]:
                            continue
                        n = 0
                        for dy in (-1, 0, 1):
                            for dx in (-1, 0, 1):
                                if dx == 0 and dy == 0:
                                    continue
                                nx, ny = x + dx, y + dy
                                if 0 <= nx < w and 0 <= ny < h and mask[ny][nx]:
                                    n += 1
                        if n >= erode_threshold:
                            eroded[y][x] = True
                mask = eroded

                # Cluster filter — remove isolated noise
                visited = [[False] * w for _ in range(h)]
                keep = set()
                for y in range(h):
                    for x in range(w):
                        if mask[y][x] and not visited[y][x]:
                            cluster = flood_fill(mask, x, y, w, h, visited)
                            if len(cluster) >= min_cluster:
                                keep.update(cluster)

                # Dilate by 1px to cover edge gaps
                dilated = set()
                for (px, py) in keep:
                    for dx in range(-1, 2):
                        for dy in range(-1, 2):
                            nx, ny = px + dx, py + dy
                            if 0 <= nx < w and y_min <= ny < min(y_max, h):
                                if rpx[nx, ny][3] > 0:
                                    dilated.add((nx, ny))
                keep = dilated

                overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
                opx = overlay.load()
                for (px, py) in keep:
                    opx[px, py] = rpx[px, py]

                overlay_frames.append(overlay)

            if not overlay_frames:
                continue

            # Frame-fill safety net: any frame that came out (near-)empty borrows
            # its nearest non-empty neighbour. Without this the overlay vanishes on
            # that frame and the avatar appears to "flash" back to bare body. This
            # catches the residual feet cases — the base char already wears shoes,
            # so on some idle/run frames the base-vs-sneaker diff is genuinely ~0 —
            # plus any pose that still escapes the per-anim Y-band.
            def _opaque(img):
                p = img.load()
                return sum(1 for yy in range(img.height) for xx in range(img.width) if p[xx, yy][3] > 0)
            opaques = [_opaque(f) for f in overlay_frames]
            nonempty = [i for i, o in enumerate(opaques) if o >= 20]
            if nonempty and len(nonempty) < len(overlay_frames):
                for i, o in enumerate(opaques):
                    if o < 20:
                        j = min(nonempty, key=lambda k: abs(k - i))
                        overlay_frames[i] = overlay_frames[j].copy()
                        print(f"  Frame-fill: {anim}_{direction} frame {i} <- frame {j}")

            fw = overlay_frames[0].width
            fh = overlay_frames[0].height
            sheet = Image.new("RGBA", (fw * len(overlay_frames), fh), (0, 0, 0, 0))
            for i, frame in enumerate(overlay_frames):
                sheet.paste(frame, (i * fw, 0))

            sheet_path = export_dir / f"{anim}_{direction}.png"
            sheet.save(sheet_path)
            print(f"  Exported: {sheet_path.name} ({len(overlay_frames)} frames)")

    # Force-mirror east/south-east/north-east → west/south-west/north-west for every anim.
    # The PixelLab outputs are inconsistent for west-facing directions (extra limbs, drift),
    # but the east-facing outputs are clean — so we just overwrite the west ones.
    from PIL import ImageOps
    MIRROR_PAIRS = [("east", "west"), ("south-east", "south-west"), ("north-east", "north-west")]
    for anim in ANIMS:
        for (src, dst) in MIRROR_PAIRS:
            src_path = export_dir / f"{anim}_{src}.png"
            dst_path = export_dir / f"{anim}_{dst}.png"
            if src_path.exists():
                ImageOps.mirror(Image.open(src_path)).save(dst_path)
                print(f"  Mirrored: {anim}_{src} -> {anim}_{dst}")


def main():
    # Parse flags: --export-only, --body <male|female>, --anims <a,b,...>
    # plus an optional positional item id filter.
    raw = sys.argv[1:]
    export_only = "--export-only" in raw
    body = "male"
    anims_filter = None
    positionals = []
    i = 0
    while i < len(raw):
        a = raw[i]
        if a == "--body":
            body = raw[i + 1]; i += 2
        elif a.startswith("--body="):
            body = a.split("=", 1)[1]; i += 1
        elif a == "--anims":
            anims_filter = raw[i + 1]; i += 2
        elif a.startswith("--anims="):
            anims_filter = a.split("=", 1)[1]; i += 1
        elif a.startswith("--"):
            i += 1  # ignore other flags (e.g. --export-only)
        else:
            positionals.append(a); i += 1
    item_filter = positionals[0] if positionals else None

    # Point the path/anim globals at the chosen body before any work runs.
    global BODY, BASE_DIR, OUT_DIR, ANIMS
    BODY = body
    BASE_DIR = Path(f"tools/pixellab-downloads/v2/base-{BODY}-frames")
    OUT_DIR = Path(f"tools/pixellab-downloads/v2/transfer-results/{BODY}")
    if anims_filter:
        ANIMS = [x.strip() for x in anims_filter.split(",") if x.strip()]
    if not BASE_DIR.is_dir():
        print(f"ERROR: base frames not found for body '{BODY}': {BASE_DIR}")
        print(f"  (run: python tools/slice-base-frames.py {BODY})")
        sys.exit(1)
    print(f"Body: {BODY} | Anims: {ANIMS} | Base: {BASE_DIR}")

    items = {k: v for k, v in ITEMS.items() if not item_filter or k == item_filter}

    if export_only:
        print("Export-only mode: skipping API calls, re-running local diff")
        print("Building base palette once...")
        palette = build_base_palette()
        print(f"Palette size: {len(palette)}")
        for item_id, item_cfg in items.items():
            print(f"\n{'='*60}\nExtracting overlays for {item_id}...\n{'='*60}")
            diff_and_export(item_id, item_cfg, base_palette=palette)
        print("\n" + "=" * 60)
        print("ALL DONE!")
        print("=" * 60)
        return

    for item_id, item_cfg in items.items():
        print(f"\n{'='*60}")
        print(f"Processing: {item_id}")
        print(f"{'='*60}")

        batches = build_batches(item_id, item_cfg)
        print(f"Total batches: {len(batches)}")

        # Check which batches already have results
        pending = []
        for ref_path, frame_paths, out_paths in batches:
            if all(os.path.exists(p) for p in out_paths):
                print(f"  Skipping (exists): {os.path.basename(out_paths[0])}")
                continue
            pending.append((ref_path, frame_paths, out_paths))

        print(f"Pending batches: {len(pending)}")

        # Process batches with limited concurrency
        completed = 0
        failed = 0

        def process_batch(batch_info):
            ref_path, frame_paths, out_paths = batch_info
            names = [os.path.basename(p) for p in frame_paths]
            try:
                job_id = submit_job(ref_path, frame_paths)
                result = poll_job(job_id)
                save_result_images(result, out_paths)
                return True, names
            except Exception as e:
                return False, (names, str(e))

        with ThreadPoolExecutor(max_workers=MAX_CONCURRENT) as executor:
            futures = {executor.submit(process_batch, b): b for b in pending}
            for future in as_completed(futures):
                success, info = future.result()
                if success:
                    completed += 1
                    print(f"  [{completed}/{len(pending)}] Done: {info}")
                else:
                    failed += 1
                    names, err = info
                    print(f"  [{completed}/{len(pending)}] FAILED: {names} - {err}")

        print(f"\nCompleted: {completed}, Failed: {failed}")

        # Diff and export overlays
        print(f"\nExtracting overlays for {item_id}...")
        diff_and_export(item_id, item_cfg)

    print("\n" + "=" * 60)
    print("ALL DONE!")
    print("=" * 60)


if __name__ == "__main__":
    main()
