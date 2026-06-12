"""Repair garment-dropout state frames via transfer-outfit-v2, using the
state's own clothed frame as reference (same character) and the BASE frames
as pose input. Re-transfers the WHOLE anim-direction whenever any of its
frames failed the garment-presence check, so the cycle stays stylistically
consistent.

Reads the bad list from check-state-frames.py output piped in, or runs the
check itself.

Usage: python tools/check-state-frames.py | python tools/transfer-fill-from-state.py
"""
import importlib.util
import re
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("tob", "tools/transfer-outfit-batch.py")
tob = importlib.util.module_from_spec(spec)
sys.modules["tob"] = tob
spec.loader.exec_module(tob)

FRAME_COUNTS = {"idle": 4, "walk": 6, "run": 6, "jump": 9}

targets = set()
for line in sys.stdin:
    m = re.match(r"(\w+) ((?:female|male)(?:-medium|-dark)?) (\w+) ([a-z-]+) f\d+", line.strip())
    if m:
        targets.add((m.group(1), m.group(2), m.group(3), m.group(4)))

print(f"{len(targets)} anim-direction sets to re-transfer")

jobs = []
for item, body, anim, d in sorted(targets):
    BASE = Path(f"tools/pixellab-downloads/v2/base-{body}-frames")
    STATE = Path(f"tools/pixellab-downloads/v4/{item}-{body}")
    # reference: the BEST-scoring state frame of the same direction (the
    # nominal walk f1 might itself be a naked dropout) — score candidates
    # with the same garment test as the checker
    cspec = importlib.util.spec_from_file_location("csf", "tools/check-state-frames.py")
    # (loaded lazily once)
    if "csf" not in sys.modules:
        import types
        csf = types.ModuleType("csf")
        import numpy as _np
        from PIL import Image as _Image
        exec(open("tools/check-state-frames.py", encoding="utf-8").read()
             .split('FLOORS =')[0], csf.__dict__)
        sys.modules["csf"] = csf
    csf = sys.modules["csf"]
    import numpy as np
    from PIL import Image
    best, ref = -1, None
    for a2, n2 in [("walk", 6), ("idle", 4), ("run", 6)]:
        for fi2 in (1, 3):
            cand = STATE / f"{a2}_{d}_f{fi2}.png"
            if cand.exists():
                arr = np.asarray(Image.open(cand).convert("RGBA")).astype(np.int32)
                sc = csf.garment_px(item, arr)
                if sc > best:
                    best, ref = sc, cand
    nf = FRAME_COUNTS[anim]
    frames = [BASE / f"{anim}_{d}_f{fi}.png" for fi in range(1, nf + 1)]
    outs = [STATE / f"{anim}_{d}_f{fi}.png" for fi in range(1, nf + 1)]
    for i in range(0, nf, 3):
        chunk_f = frames[i:i+3]
        chunk_o = outs[i:i+3]
        if len(chunk_f) == 1:  # API needs >=2 frames; pad with previous
            chunk_f = frames[i-1:i+1]
            chunk_o = outs[i-1:i+1]
        jobs.append((ref, chunk_f, chunk_o, item, body, anim, d, i))

print(f"{len(jobs)} transfer jobs")
import concurrent.futures as cf

def run_one(job):
    ref, frames, outs, item, body, anim, d, i = job
    try:
        jid = tob.submit_job(ref, frames)
        data = tob.poll_job(jid, timeout=600)
        tob.save_result_images(data, [str(p) for p in outs])
        return f"  ok {item}-{body} {anim}_{d} f{i+1}+"
    except Exception as e:
        return f"  FAIL {item}-{body} {anim}_{d} f{i+1}+: {e}"

with cf.ThreadPoolExecutor(max_workers=2) as ex:
    for r in ex.map(run_one, jobs):
        print(r, flush=True)
print("DONE")
