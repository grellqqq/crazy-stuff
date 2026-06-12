"""Download animation frames listed in a urls.json manifest.

Manifest format (written by the agent from get_character output):
{
  "out_dir": "tools/pixellab-downloads/v4/<name>",
  "frames": { "<anim>_<direction>_f<i>.png": "https://...", ... }
}

Usage: python tools/fetch-frames.py <manifest.json>
Skips files that already exist. Retries each URL 3x.
"""
import json
import os
import sys
import time
import urllib.request

manifest = json.load(open(sys.argv[1], encoding="utf-8"))
out_dir = manifest["out_dir"]
os.makedirs(out_dir, exist_ok=True)
frames = manifest["frames"]
done = skipped = failed = 0
for name, url in frames.items():
    dst = os.path.join(out_dir, name)
    if os.path.exists(dst) and os.path.getsize(dst) > 0:
        skipped += 1
        continue
    ok = False
    for attempt in range(3):
        try:
            urllib.request.urlretrieve(url, dst)
            ok = True
            break
        except Exception as e:
            time.sleep(1.5 * (attempt + 1))
            err = e
    if ok:
        done += 1
    else:
        failed += 1
        print(f"FAILED {name}: {err}")
print(f"downloaded={done} skipped={skipped} failed={failed} -> {out_dir}")
