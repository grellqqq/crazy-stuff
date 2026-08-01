"""Rebuild masks: ONE clean SOLID mask-on-face per direction, head-locked onto
every frame. Fixes (Gabriel 2026-07-29): run/jump blob (per-frame face detection
fails on crouch) + skin showing through (holes). Build once from the reliable
walk frame, fill holes solid, then position on each frame's head."""
import importlib.util
import numpy as np
from PIL import Image, ImageOps
from scipy import ndimage
spec=importlib.util.spec_from_file_location("xt","tools/extract-overlays-v4.py")
xt=importlib.util.module_from_spec(spec); spec.loader.exec_module(xt)
FS=92
EAST=["south","south-east","east","north-east","north"]
MIRROR={"west":"east","north-west":"north-east","south-west":"south-east"}
BACK34={"north-east"}
ANIMS={"walk":6,"idle":4,"run":6,"jump":9}
BODY="src/client/public/sprites/characters/{g}"
EQ="src/client/public/sprites/equipment/face_accessory/{item}/{g}"
def dil(m,k):
    d=m.copy()
    for _ in range(k):
        n=d.copy(); n[1:,:]|=d[:-1,:]; n[:-1,:]|=d[1:,:]; n[:,1:]|=d[:,:-1]; n[:,:-1]|=d[:,1:]; d=n
    return d
def anchor(f):
    hr=xt.head_region(f)
    if not hr.any(): return None
    ys,xs=np.nonzero(hr); return np.array([xs.mean(),ys.mean()])
def clip_fill(ov, base):
    op=ov[...,3]>8
    if not op.any(): return np.zeros_like(ov)
    face=xt.face_region(base)
    if not face.any(): return np.zeros_like(ov)
    head=xt.head_region(base); bop=base[...,3]>8; neck=xt.neck_row(bop)
    fys,fxs=np.nonzero(face); chin=int(fys.max()); cx=int(fxs.mean())
    R,G,B=ov[...,0],ov[...,1],ov[...,2]; lum=(R+G+B)/3.0; sat=ov[...,:3].max(2)-ov[...,:3].min(2)
    hairish=(R-B>26)&(lum>25)&(lum<150)&(sat<48)
    hairzone=head & ~dil(face,2)
    shoulders=np.zeros((FS,FS),bool); shoulders[chin+3:,:]=True
    filtercol=np.zeros((FS,FS),bool); filtercol[chin:min(FS,chin+8),max(0,cx-7):min(FS,cx+8)]=True
    exclude=hairzone | (shoulders & ~filtercol)
    core=op & dil(face,4) & ~exclude
    masklike=op & ~hairish & ~exclude
    region=(masklike & dil(head,10)) | core
    lab,n=ndimage.label(region); klbl=np.unique(lab[core])
    keep=np.isin(lab,klbl[klbl>0]) if len(klbl) and klbl.max()>0 else core
    out=np.zeros_like(ov); out[keep]=ov[keep]
    # FILL HOLES solid (mask must not show skin)
    o2=out[...,3]>8
    if o2.any():
        filled=ndimage.binary_fill_holes(o2); holes=filled&~o2
        if holes.any():
            _,(iy,ix)=ndimage.distance_transform_edt(~o2,return_indices=True)
            ys,xs=np.nonzero(holes); out[ys,xs]=out[iy[ys,xs],ix[ys,xs]]
    return out
def run(item):
    for g in ["male","female"]:
        canon={}; a0={}
        for d in EAST:
            wf=np.asarray(Image.open(f"{EQ.format(item=item,g=g)}/walk_{d}.png").convert("RGBA")).astype(np.int16)
            wb=np.asarray(Image.open(f"{BODY.format(g=g)}/walk_{d}.png").convert("RGBA")).astype(np.int16)
            ovs=[wf[:,i*FS:(i+1)*FS] for i in range(6)]; ci=int(np.argmax([(o[...,3]>8).sum() for o in ovs]))
            canon[d]=clip_fill(ovs[ci], wb[:,ci*FS:(ci+1)*FS])
            a0[d]=anchor(wb[:,ci*FS:(ci+1)*FS])
        for anim,nf in ANIMS.items():
            for d in EAST:
                bs=np.asarray(Image.open(f"{BODY.format(g=g)}/{anim}_{d}.png").convert("RGBA")).astype(np.int16)
                out=np.zeros((FS,FS*nf,4),dtype=np.int16)
                if d!="north":
                    for i in range(nf):
                        base=bs[:,i*FS:(i+1)*FS]; af=anchor(base)
                        if af is None or a0[d] is None: continue
                        placed=xt.shift_rgba(canon[d], int(round(af[0]-a0[d][0])), int(round(af[1]-a0[d][1])))
                        if d in BACK34:
                            face=xt.face_region(base)
                            placed = placed*0 if not face.any() else np.where(dil(face,2)[...,None], placed, 0)
                        out[:,i*FS:(i+1)*FS]=placed
                xt.save_rgba(out, f"{EQ.format(item=item,g=g)}/{anim}_{d}.png")
            for dst,src in MIRROR.items():
                ImageOps.mirror(Image.open(f"{EQ.format(item=item,g=g)}/{anim}_{src}.png")).save(f"{EQ.format(item=item,g=g)}/{anim}_{dst}.png")
        print(f"  {item} {g}: rebuilt clean+solid, head-locked")
for it in ["gas_mask","plague_doctor","tiki_mask","hockey_mask","ghost_mask"]:
    run(it)
print("DONE")
