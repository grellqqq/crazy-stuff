"""Clear face-mask overlays on pure BACK-facing frames.

A full-face mask sits on the FACE. From directly behind, the face is away from the
camera, so no mask should be visible — just the back of the head. But the diff can
capture the mask in back frames (source drew it), which flashes the mask on the
back of the head (e.g. ghost mask, W direction).

Fix: for each frame, if the BASE body shows essentially no facial skin (a back
view), clear the mask overlay for that frame. Front/side frames keep their mask.
"""
import numpy as np
from PIL import Image

FS = 92
NDIR = ["south", "south-east", "east", "north-east", "north", "north-west", "west", "south-west"]
MASKS = ["hockey_mask", "gas_mask", "ghost_mask", "plague_doctor", "tiki_mask"]
ANIMS = {"walk": 6, "idle": 4, "run": 6, "jump": 9}
BODY = "src/client/public/sprites/characters/male"


def load(p):
    return np.asarray(Image.open(p).convert("RGBA")).copy()


def face_visible(body_frame):
    """Count facial-skin pixels in the head band — near zero on a back view."""
    op = body_frame[..., 3] > 16
    ys, _ = np.nonzero(op)
    if len(ys) == 0:
        return 0
    t = int(ys.min())
    R = body_frame[..., 0].astype(int)
    G = body_frame[..., 1].astype(int)
    B = body_frame[..., 2].astype(int)
    band = np.zeros(body_frame.shape[:2], bool)
    band[t + 5:t + 22, :] = True
    skin = (R > 150) & (R > G) & (G > B) & (R - B > 25) & op & band
    return int(skin.sum())


for item in MASKS:
    root = f"src/client/public/sprites/equipment/face_accessory/{item}/male"
    cleared = 0
    for anim, nf in ANIMS.items():
        for d in NDIR:
            op = f"{root}/{anim}_{d}.png"
            bp = f"{BODY}/{anim}_{d}.png"
            try:
                ov = load(op)
                body = load(bp)
            except FileNotFoundError:
                continue
            w = ov.shape[1] // nf
            for i in range(nf):
                if face_visible(body[:, i * w:(i + 1) * w]) < 14:   # back view → no mask
                    ov[:, i * w:(i + 1) * w] = 0
                    cleared += 1
            Image.fromarray(ov, "RGBA").save(op)
    print(f"  {item}: cleared {cleared} back-facing frames")
print("DONE — masks no longer show on the back of the head")
