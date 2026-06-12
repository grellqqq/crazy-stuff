"""Fill the female RUN gap in v4: transfer-outfit-v2 with the garment
STATE's own animation frame as reference (same character, clothed — a far
stronger anchor than the old flat-lay refs), redrawn onto the BASE run
frames (pose-preserving), output into the v4 state dirs.

Why: template-mode animation of the female garment states systematically
renders the figure WITHOUT the garment for running-6-frames (4 attempts,
2 states, fresh names — male states and female walk/jump/idle are fine).

Usage: python tools/transfer-run-from-state.py <item> <body> [dirs...]
e.g.   python tools/transfer-run-from-state.py blue_jeans female
"""
import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("tob", "tools/transfer-outfit-batch.py")
tob = importlib.util.module_from_spec(spec)
sys.modules["tob"] = tob
spec.loader.exec_module(tob)

item, body = sys.argv[1], sys.argv[2]
dirs = sys.argv[3:] or ["south", "east", "north", "south-east", "north-east"]

BASE = Path(f"tools/pixellab-downloads/v2/base-{body}-frames")
STATE = Path(f"tools/pixellab-downloads/v4/{item}-{body}")

jobs = []
for d in dirs:
    # reference: the state's own WALK f1 in this direction (clothed,
    # correct angle); falls back to idle f1
    ref = STATE / f"walk_{d}_f1.png"
    if not ref.exists():
        ref = STATE / f"idle_{d}_f1.png"
    frames = [BASE / f"run_{d}_f{fi}.png" for fi in range(1, 7)]
    outs = [STATE / f"run_{d}_f{fi}.png" for fi in range(1, 7)]
    # API caps at 3 frames per request
    for i in range(0, 6, 3):
        jobs.append((ref, frames[i:i+3], outs[i:i+3], d, i))

print(f"{len(jobs)} transfer jobs for {item}-{body} run ({', '.join(dirs)})")
import concurrent.futures as cf

def run_one(job):
    ref, frames, outs, d, i = job
    jid = tob.submit_job(ref, frames)
    data = tob.poll_job(jid)
    tob.save_result_images(data, [str(p) for p in outs])
    return f"  done run_{d} f{i+1}-f{i+len(outs)}"

with cf.ThreadPoolExecutor(max_workers=2) as ex:
    for r in ex.map(run_one, jobs):
        print(r)
print("DONE")
