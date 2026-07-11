"""Compose a design-proposal sheet from a PixelLab character GROUP zip:
each requested state's rotations (south, SE, east, north) at 4x, labeled.

Usage:
  python tools/preview-designs.py <any_group_character_id> <label>=<folder_substring> [...]
Writes tools/preview-output/design_proposals.png
"""
import io
import os
import re
import sys
import urllib.request
import zipfile

from PIL import Image, ImageDraw

DIRS = ["south", "south-east", "east", "north"]
FS = 92
Z = 4


def api_key():
    k = os.environ.get("PIXELLAB_API_KEY")
    if k:
        return k
    for line in open(".env", encoding="utf-8"):
        m = re.match(r"\s*PIXELLAB_API_KEY\s*=\s*\"?([^\"\n]+)\"?", line)
        if m:
            return m.group(1)
    raise SystemExit("PIXELLAB_API_KEY not found")


def main():
    char_id = sys.argv[1]
    wants = [a.split("=", 1) for a in sys.argv[2:]]
    req = urllib.request.Request(
        f"https://api.pixellab.ai/mcp/characters/{char_id}/download",
        headers={"Authorization": f"Bearer {api_key()}"})
    data = urllib.request.urlopen(req, timeout=600).read()
    zf = zipfile.ZipFile(io.BytesIO(data))
    tops = sorted(set(n.split("/")[0] for n in zf.namelist()))
    print("group folders:", tops)

    W = FS * len(DIRS) * Z + 20
    H = (FS * Z + 26) * len(wants) + 10
    sheet = Image.new("RGBA", (W, H), (34, 34, 40, 255))
    dr = ImageDraw.Draw(sheet)
    y = 6
    for label, sub in wants:
        folder = next((t for t in tops if sub.lower() in t.lower()), None)
        dr.text((10, y), f"{label}  [{folder or 'NOT FOUND: ' + sub}]",
                fill=(255, 255, 120, 255))
        if folder:
            x = 10
            for d in DIRS:
                name = f"{folder}/rotations/{d}.png"
                try:
                    img = Image.open(io.BytesIO(zf.read(name))).convert("RGBA")
                    img = img.resize((FS * Z, FS * Z), Image.NEAREST)
                    sheet.paste(img, (x, y + 18), img)
                except KeyError:
                    pass
                x += FS * Z
        y += FS * Z + 26
    out = "tools/preview-output/design_proposals.png"
    sheet.save(out)
    print("saved", out)


if __name__ == "__main__":
    main()
