"""Generalized transfer-outfit-v2 filler: redraw a garment onto BASE pose
frames for ANY animation (run, jump, ...), using the garment STATE's own
clean walk_{d}_f1 frame as the reference (clothed, correct angle).

Why: template-mode animation systematically drops the garment on dynamic
poses (running-6-frames, jumping). transfer-outfit-v2 is pose-preserving and
redraws the garment from a clean reference, so it never loses sleeves/torso.

Frame count is auto-detected from the base dir. API caps at 3 frames/request.

Usage: python tools/transfer-anim-from-state.py <item> <body> <anim> [dirs...]
e.g.   python tools/transfer-anim-from-state.py worn_hoodie male jump
"""
import importlib.util
import sys
from pathlib import Path
import concurrent.futures as cf

spec = importlib.util.spec_from_file_location("tob", "tools/transfer-outfit-batch.py")
tob = importlib.util.module_from_spec(spec)
sys.modules["tob"] = tob
spec.loader.exec_module(tob)

FORCE = "--force" in sys.argv
if FORCE:
    sys.argv.remove("--force")

item, body, anim = sys.argv[1], sys.argv[2], sys.argv[3]
dirs = sys.argv[4:] or ["south", "east", "north", "south-east", "north-east"]

BASE = Path(f"tools/pixellab-downloads/v2/base-{body}-frames")
STATE = Path(f"tools/pixellab-downloads/v4/{item}-{body}")

def frame_count(d):
    n = 0
    while (BASE / f"{anim}_{d}_f{n+1}.png").exists():
        n += 1
    return n

# West-side dirs have no generated states (they were mirrored at extraction).
# The reference only supplies the garment's APPEARANCE (pose comes from the
# target frames), so a mirrored east-side walk frame is a valid west reference.
MIRROR_REF = {"west": "east", "north-west": "north-east", "south-west": "south-east"}

jobs = []
for d in dirs:
    ref = STATE / f"walk_{d}_f1.png"
    if not ref.exists():
        ref = STATE / f"idle_{d}_f1.png"
    if not ref.exists() and d in MIRROR_REF:
        for src_anim in ("walk", "idle"):
            src = STATE / f"{src_anim}_{MIRROR_REF[d]}_f1.png"
            if src.exists():
                from PIL import Image, ImageOps
                ref = STATE / f"_ref_{d}.png"
                ImageOps.mirror(Image.open(src)).save(ref)
                print(f"  ref for {d}: mirrored {src_anim}_{MIRROR_REF[d]}_f1")
                break
    if not ref.exists():
        print(f"  SKIP {d}: no walk/idle reference in {STATE}")
        continue
    n = frame_count(d)
    if n == 0:
        print(f"  SKIP {d}: no base {anim} frames")
        continue
    frames = [BASE / f"{anim}_{d}_f{fi}.png" for fi in range(1, n + 1)]
    outs = [STATE / f"{anim}_{d}_f{fi}.png" for fi in range(1, n + 1)]
    for i in range(0, n, 3):
        batch_outs = outs[i:i+3]
        # Skip batches already produced (resume after a partial/failed run),
        # unless --force. This avoids re-spending credit on completed frames.
        if not FORCE and all(p.exists() for p in batch_outs):
            print(f"  skip (exists) {anim}_{d} f{i+1}-f{i+len(batch_outs)}")
            continue
        jobs.append((ref, frames[i:i+3], batch_outs, d, i))

print(f"{len(jobs)} transfer jobs for {item}-{body} {anim} ({', '.join(dirs)})")

results = {"done": 0, "failed": []}

def run_one(job):
    ref, frames, outs, d, i = job
    tag = f"{anim}_{d} f{i+1}-f{i+len(outs)}"
    # Retry on timeout — PixelLab stalls under load; a fresh submit usually
    # clears it. Up to 3 attempts with a generous 600s poll each.
    last = None
    for attempt in range(1, 4):
        try:
            jid = tob.submit_job(ref, frames)
            data = tob.poll_job(jid, timeout=600)
            tob.save_result_images(data, [str(p) for p in outs])
            results["done"] += 1
            return f"  done {tag}" + (f" (attempt {attempt})" if attempt > 1 else "")
        except Exception as e:
            last = e
            print(f"  retry {tag}: attempt {attempt} failed ({str(e)[:80]})")
    results["failed"].append(tag)
    return f"  FAILED {tag}: {str(last)[:120]}"

with cf.ThreadPoolExecutor(max_workers=2) as ex:
    futs = [ex.submit(run_one, j) for j in jobs]
    for f in cf.as_completed(futs):
        print(f.result())

print(f"DONE — {results['done']} ok, {len(results['failed'])} failed")
if results["failed"]:
    print("  failed:", ", ".join(results["failed"]))
    sys.exit(1)
