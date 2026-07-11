"""Download a PixelLab character-GROUP zip (authenticated) and extract each
state's animation frames as per-frame PNGs for extract-overlays-v4.

The /download endpoint for any character in a group returns the whole group:
  <State_Folder>/animations/<anim>/<direction>/frame_NNN.png

Anim folder -> game anim: walking*->walk, running*->run, jumping*->jump,
breathing*->idle.

Usage:
  python tools/fetch-character-frames.py <character_id> --map "<StateFolderPrefix>=<out_dir>" [...]

Example:
  python tools/fetch-character-frames.py 58df2a42-... \
    --map "wearing_a_worn_grey=tools/pixellab-downloads/v4/worn_tshirt-female" \
    --map "wearing_blue_denim=tools/pixellab-downloads/v4/blue_jeans-female"
"""
import io
import os
import re
import sys
import urllib.request
import zipfile


def api_key():
    k = os.environ.get("PIXELLAB_API_KEY")
    if k:
        return k
    for line in open(".env", encoding="utf-8"):
        m = re.match(r"\s*PIXELLAB_API_KEY\s*=\s*\"?([^\"\n]+)\"?", line)
        if m:
            return m.group(1)
    raise SystemExit("PIXELLAB_API_KEY not found in env or .env")


def game_anim(folder, frame_count=None):
    # Folders are named after the ACTION DESCRIPTION slug when a custom
    # description is used (e.g. "standing_still_breathing_calmly_wearing"),
    # so match on the leading verb, not exact template names.
    for pre, g in [("walking", "walk"), ("running", "run"),
                   ("jumping", "jump"), ("breathing", "idle"),
                   ("standing", "idle")]:
        if folder.startswith(pre):
            return g
    # template animations come back as generic "animating[-hash]" folders;
    # identify by frame count (jumping-1=9f, breathing-idle=4f)
    if folder.startswith("animating") and frame_count in (9, 4):
        return "jump" if frame_count == 9 else "idle"
    return None


char_id = sys.argv[1]
maps = []
args = sys.argv[2:]
i = 0
while i < len(args):
    if args[i] == "--map":
        pre, out = args[i + 1].split("=", 1)
        maps.append((pre, out))
        i += 2
    else:
        i += 1

req = urllib.request.Request(
    f"https://api.pixellab.ai/mcp/characters/{char_id}/download",
    headers={"Authorization": f"Bearer {api_key()}"})
data = urllib.request.urlopen(req, timeout=600).read()
zf = zipfile.ZipFile(io.BytesIO(data))

# first pass: frame counts per (top, anim_folder, direction)
fcounts = {}
for name in zf.namelist():
    parts = name.split("/")
    if len(parts) == 5 and parts[1] == "animations" and parts[4].startswith("frame_"):
        key = (parts[0], parts[2], parts[3])
        fcounts[key] = fcounts.get(key, 0) + 1

counts = {}
for name in zf.namelist():
    parts = name.split("/")
    if len(parts) != 5 or parts[1] != "animations":
        continue
    top, _, anim_folder, direction, fname = parts
    g = game_anim(anim_folder, fcounts.get((top, anim_folder, direction)))
    if g is None:
        continue
    fm = re.match(r"frame_(\d+)\.png", fname)
    if not fm:
        continue
    fi = int(fm.group(1)) + 1
    for pre, out in maps:
        if top.startswith(pre):
            os.makedirs(out, exist_ok=True)
            with open(os.path.join(out, f"{g}_{direction}_f{fi}.png"), "wb") as f:
                f.write(zf.read(name))
            counts[out] = counts.get(out, 0) + 1
            break

for out, n in counts.items():
    print(f"{n:4} frames -> {out}")
if not counts:
    tops = sorted(set(n.split("/")[0] for n in zf.namelist()))
    print("no frames matched; top-level folders:", tops)
