// ENGINE QA HARNESS — captures cosmetics IN THE RUNNING GAME, the exact
// pixels a player sees (renderer filtering, equipment sync, dir mapping all
// included — offline sheet QA misses every one of those).
//
// Load in the console at http://localhost:8080/?dev (after joining):
//   fetch('/tools-engine-qa.js') — or paste this file.
// Then e.g.:
//   __qa.ensureGrid('g1', 16, 9);
//   let r = 0;
//   for (const anim of ['walk','jump'])
//     for (const f of ['S','SD','D','WD','W','WA','A','SA'])
//       console.log(anim, f, await __qa.row('g1','leather_jacket','female',anim,f,r++));
// Each row() returns "bodyFrame/equipFrame ..." pairs — any X/Y mismatch on a
// non-idle anim is an engine sync bug; 'H' marks a hidden equipment sprite.
// Screenshot the #g1 canvas for the visual contact sheet.
//
// The harness PUMPS Phaser's loop manually (window.__game.loop.step), so it
// works even when the browser throttles rAF (occluded/automated windows).
(() => {
  const iso = window.__game.scene.getScene('IsoScene');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pump = () => { try { window.__game.loop.step(performance.now()); } catch (e) {} };
  const pumpedWait = async (ms) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) { pump(); await sleep(25); }
  };
  const snap = (x, y, w, h) => new Promise((res) => iso.game.renderer.snapshotArea(x, y, w, h, res));
  const av = () => [...iso.avatars.values()].find((a) => a.slotIndex === iso.mySlotIndex);
  const CFG = { idle: { n: 5, dt: 250 }, walk: { n: 7, dt: 110 },
                run: { n: 7, dt: 75 }, jump: { n: 9, dt: 62 } };
  const CW = 260, CH = 320, CX = 510, CY = 185, SCALE = 0.7;
  window.__qa = {
    ensureGrid(id, rows, cols) {
      let cv = document.getElementById(id);
      if (!cv) { cv = document.createElement('canvas'); cv.id = id; document.body.appendChild(cv); }
      cv.width = Math.round(cols * CW * SCALE) + 90;
      cv.height = Math.round(rows * CH * SCALE);
      Object.assign(cv.style, { position: 'absolute', left: '0', top: '0', zIndex: 99999 });
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#2a2a30'; ctx.fillRect(0, 0, cv.width, cv.height);
    },
    async row(id, item, gender, anim, facing, rowIdx) {
      const a = av();
      if (a.charKey !== gender) {
        a.charKey = gender;
        iso.ensureCharLoaded && iso.ensureCharLoaded(gender);
        await pumpedWait(1100);
      }
      iso.applyLoadout(a, { upper_body: item }, gender);
      iso.playerFacing = facing;
      a.sprinting = (anim === 'run'); a.speedBoosted = false;
      a.jumpOffset = (anim === 'jump') ? -10 : 0;
      a.lastTileChange = (anim === 'idle') ? 0 : (performance.now() + 1e7);
      iso.cameras.main.setZoom(3.0);
      iso.cameras.main.centerOn(a.bodySprite.x, a.bodySprite.y - 8);
      await pumpedWait(750);
      const cur = a.bodySprite.anims.currentAnim;
      if (cur) a.bodySprite.anims.play(cur.key, false);
      pump();
      const { n, dt } = CFG[anim];
      const cv = document.getElementById(id);
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      const meta = [];
      for (let i = 0; i < n; i++) {
        pump();
        const b = av();
        const bodyIdx = b.bodySprite.anims.currentFrame ? b.bodySprite.anims.currentFrame.index : -1;
        let eqIdx = -2, eqVis = null;
        for (const [, spr] of b.equipmentLayers) {
          eqVis = spr.visible;
          if (spr.anims.currentFrame && spr.anims.currentAnim) {
            eqIdx = spr.anims.currentAnim.frames.indexOf(spr.anims.currentFrame) + 1;
          }
        }
        const img = await snap(CX, CY, CW, CH);
        ctx.drawImage(img, 90 + i * CW * SCALE, rowIdx * CH * SCALE, CW * SCALE, CH * SCALE);
        meta.push(`${bodyIdx}/${eqIdx}${eqVis === false ? 'H' : ''}`);
        await pumpedWait(dt);
      }
      ctx.fillStyle = '#ffff66'; ctx.font = '12px monospace';
      ctx.fillText(`${anim} ${facing}`, 4, rowIdx * CH * SCALE + 14);
      return meta.join(' ');
    },
  };
  console.log('[engine-qa] installed — see file header for usage');
})();
