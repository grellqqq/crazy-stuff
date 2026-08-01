// COSMETIC QA HARNESS — in-engine, exhaustive, no blind spots.
// Renders a cosmetic on the ACTUAL avatar across every direction and movement,
// and — critically — the overlay ALONE (body hidden) which exposes anything
// wrong baked into the overlay (e.g. a head inside a mask = "double head").
// This is what offline sprite composites CANNOT catch, because they overlap the
// overlay on the same static body at the same position.
//
// Paste into the console at http://localhost:8080/?dev, then:
//   __qa('male','face_accessory','tiki_mask')                // full avatar, all 8 dirs x idle/walk/run/jump
//   __qa('male','face_accessory','tiki_mask',{bodyHidden:true})  // OVERLAY ALONE (double-head test)
//   __qaDetail('female','hair','hair_long_blue')             // head-zoomed, idle/walk/run
// A montage overlay appears top-left; screenshot it. Re-run to replace.
(() => {
  const iso = window.__game.scene.getScene('IsoScene');
  const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const FAC = ['S', 'SD', 'D', 'WD', 'W', 'WA', 'A', 'SA']; // all 8 facings
  const mkStates = () => [
    { k: 'idle', s: (av) => { av.sprinting = false; av.jumpOffset = 0; av.lastTileChange = 0; } },
    { k: 'walk', s: (av) => { av.sprinting = false; av.jumpOffset = 0; av.lastTileChange = performance.now() + 1e7; } },
    { k: 'walk2', s: (av) => { av.sprinting = false; av.jumpOffset = 0; av.lastTileChange = performance.now() + 1e7; }, w: 150 },
    { k: 'run', s: (av) => { av.sprinting = true; av.jumpOffset = 0; av.lastTileChange = performance.now() + 1e7; } },
    { k: 'jump', s: (av) => { av.sprinting = false; av.jumpOffset = -14; av.lastTileChange = performance.now() + 1e7; } },
  ];
  async function build(gender, slot, id, opts) {
    opts = Object.assign({ bodyHidden: false, cell: [120, 132], src: null }, opts);
    const av = [...iso.avatars.values()].find(a => a.slotIndex === iso.mySlotIndex);
    av.charKey = gender;
    await new Promise(r => iso.ensureCharLoaded(gender, r));
    const lo = {}; if (id) lo[slot] = id;
    iso.applyLoadout(av, lo, gender);
    await wait(1000); // texture load + dev evict
    if (av.label) av.label.setVisible(false);
    if (av.statusLabel) av.statusLabel.setVisible(false);
    const RW = 100, RH = 110;
    const rt = iso.add.renderTexture(0, 0, RW, RH).setVisible(false).setDepth(-9999);
    const snap = () => new Promise(res => rt.snapshot(res));
    const STATES = opts.detail
      ? mkStates().filter(s => ['idle', 'walk', 'run'].includes(s.k))
      : mkStates();
    const src = opts.src || (opts.detail ? [18, 12, 64, 58] : [0, 0, RW, RH]);
    const [cw, ch] = opts.cell, cols = STATES.length, rows = FAC.length;
    const cv = document.createElement('canvas'); cv.width = cols * cw + 34; cv.height = rows * ch + 18;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = opts.bodyHidden ? '#4a4a4a' : '#101018'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#0f0'; ctx.font = '11px monospace';
    STATES.forEach((s, c) => ctx.fillText(s.k, 34 + c * cw + 3, 12));
    for (let r = 0; r < rows; r++) {
      iso.playerFacing = FAC[r];
      ctx.fillStyle = '#0f0'; ctx.fillText(FAC[r], 2, 18 + r * ch + ch / 2);
      for (let c = 0; c < cols; c++) {
        STATES[c].s(av);
        await raf(); await wait(STATES[c].w || 90); await raf();
        const bx = av.bodySprite.x, by = av.bodySprite.y;
        rt.clear();
        if (!opts.bodyHidden) rt.draw(av.bodySprite, 50, 96);
        for (const s2 of av.equipmentLayers.values()) rt.draw(s2, 50 + (s2.x - bx), 96 + (s2.y - by));
        await raf();
        const img = await snap();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, src[0], src[1], src[2], src[3], 34 + c * cw, 18 + r * ch, cw, ch);
      }
    }
    rt.destroy();
    if (av.label) av.label.setVisible(true);
    let ov = document.getElementById('__qaov'); if (ov) ov.remove();
    ov = document.createElement('div'); ov.id = '__qaov';
    Object.assign(ov.style, { position: 'fixed', left: '0', top: '0', zIndex: '999999', background: '#000' });
    const im = document.createElement('img'); im.src = cv.toDataURL(); im.style.imageRendering = 'pixelated';
    ov.appendChild(im); document.body.appendChild(ov);
    return { ok: 1, size: [cv.width, cv.height], hint: 'screenshot the top-left montage' };
  }
  window.__qa = (g, slot, id, opts = {}) => build(g, slot, id, opts);
  window.__qaDetail = (g, slot, id, opts = {}) => build(g, slot, id, Object.assign({ detail: true, cell: [175, 150] }, opts));
  console.log('[cosmetic-qa] ready:  __qa(gender,slot,id[,{bodyHidden:true}])   __qaDetail(gender,slot,id)');
})();
