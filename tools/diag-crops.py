"""Dump base | transfer | composite panels for given frames.

Usage: python tools/diag-crops.py <body> <item> <anim> <dir> [zoom] [sheet_override] [tag]
Writes tools/preview-output/diag<tag>_<anim>_<dir>_f<i>.png per frame.
"""
import importlib.util
import sys

import numpy as np
from PIL import Image

spec = importlib.util.spec_from_file_location("x3", "tools/extract-overlays-v3.py")
x3 = importlib.util.module_from_spec(spec)
sys.modules["x3"] = x3
spec.loader.exec_module(x3)

body, item, anim, dr = sys.argv[1:5]
zoom = int(sys.argv[5]) if len(sys.argv) > 5 else 4
slot = x3.ITEMS[item]["slot"]
FS = x3.FS

sheet_path = sys.argv[6] if len(sys.argv) > 6 else \
    f"src/client/public/sprites/equipment/{slot}/{item}/{body}/{anim}_{dr}.png"
tag = sys.argv[7] if len(sys.argv) > 7 else ""
sheet = np.asarray(Image.open(sheet_path).convert("RGBA"))

for fi in range(1, x3.FRAME_COUNTS[anim] + 1):
    base = x3.base_frame(body, anim, dr, fi).astype(np.uint8)
    xfer = x3.xfer_frame(body, item, anim, dr, fi)
    xfer = xfer.astype(np.uint8) if xfer is not None else np.zeros_like(base)
    fr = sheet[:, (fi - 1) * FS:fi * FS]

    comp = Image.alpha_composite(
        Image.fromarray(base, "RGBA"), Image.fromarray(fr, "RGBA"))

    panel = Image.new("RGBA", (FS * 3 + 8, FS), (40, 40, 40, 255))
    panel.paste(Image.fromarray(base, "RGBA"), (0, 0))
    panel.paste(Image.fromarray(xfer, "RGBA"), (FS + 4, 0))
    panel.paste(comp, (FS * 2 + 8, 0))
    panel = panel.resize((panel.width * zoom, panel.height * zoom), Image.NEAREST)
    out = f"tools/preview-output/diag{tag}_{anim}_{dr}_f{fi}.png"
    panel.save(out)
    print(out)
