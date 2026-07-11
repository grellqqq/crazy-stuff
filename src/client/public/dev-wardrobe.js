// DEV WARDROBE — paste into the browser console at http://localhost:8080/?dev
// Flip through every released top in every animation, in place, without a race.
// FORCE-RELOADS each item's sprites on switch (purges Phaser texture+anim cache
// and refetches with a fresh ?v) so you NEVER see stale art — no hard-reload needed.
// Keys:  [N]/[P] next/prev top   [G] gender   [1-4] idle/walk/run/jump   [F] turn   [R] reload current
(() => {
  const iso = window.__game.scene.getScene('IsoScene');
  // Always drive YOUR OWN (local) avatar. Grabbing the first avatar in the map
  // (values().next()) can land on a REMOTE player when others are in the room —
  // and remote avatars render differently (they were the source of the run/jump
  // "black square"), so you'd be QAing the wrong character.
  const av = [...iso.avatars.values()].find((a) => a.slotIndex === iso.mySlotIndex)
             || iso.avatars.values().next().value;
  if (!av) { console.warn('[wardrobe] no avatar yet — join a room first'); return; }
  console.log('[wardrobe] driving LOCAL avatar, slot', av.slotIndex, '(mySlot', iso.mySlotIndex + ')');
  const TOPS = ['varsity_red','circuit_jacket','galaxy_hoodie','puffer_orange','leather_jacket','leather_black','leather_green','hoodie_black','hoodie_blue','hoodie_brown','hoodie_green','hoodie_pink','hoodie_purple','hoodie_red','hoodie_white','hoodie_yellow'];
  const ANIMS = ['idle','walk','run','jump'];
  const FACINGS = ['S','SD','D','WD','W','WA','A','SA'];
  const COMPASS = ['south','south-west','west','north-west','north','north-east','east','south-east'];
  const SHORT = ['S','SA','A','WA','W','WD','D','SD'];
  const st = { ti:7, ai:0, fi:1, gender: av.charKey || 'male' };
  let hud = document.getElementById('wardrobe-hud');
  if (!hud) {
    hud = document.createElement('div'); hud.id = 'wardrobe-hud';
    Object.assign(hud.style, {position:'fixed',left:'8px',top:'8px',zIndex:99999,font:'14px monospace',color:'#fff',background:'rgba(0,0,0,.6)',padding:'6px 10px',whiteSpace:'pre',borderRadius:'4px'});
    document.body.appendChild(hud);
  }
  // Purge a top's cached textures + anims so the next applyLoadout refetches them
  // with a fresh cache-buster (the loader otherwise caches for the whole session).
  // CRITICAL: tear down live equipment sprites FIRST. Removing an anim/texture
  // that a sprite is mid-animation on fires a frame-update on a now-null frame
  // ("Cannot read properties of null (reading 'sourceSize')"), which crashes
  // Phaser's render loop and leaves a black square — the very bug this caused.
  const purge = (item, gender) => {
    const eqKey = `${item}_${gender}`;
    for (const avx of iso.avatars.values()) {
      if (!avx.equipmentLayers) continue;
      for (const spr of avx.equipmentLayers.values()) {
        try { if (spr.anims) spr.anims.stop(); spr.setVisible(false); spr.destroy(); } catch (e) {}
      }
      avx.equipmentLayers.clear();
    }
    for (const s of COMPASS) for (const inf of ['','run_','jump_','idle_']) {
      const k = `equip_${eqKey}_${inf}${s}`;
      if (iso.textures.exists(k)) iso.textures.remove(k);
    }
    for (const d of SHORT) for (const inf of ['','run_','jump_','idle_']) {
      const k = `equip_${eqKey}_${inf}${d}`;
      if (iso.anims.exists(k)) iso.anims.remove(k);
    }
    iso.loadedEquipment && iso.loadedEquipment.delete(eqKey);
    iso.loadingEquipment && iso.loadingEquipment.delete(eqKey);
  };
  const ensureGender = (cb) => {
    if (av.charKey !== st.gender) { av.charKey = st.gender; iso.ensureCharLoaded && iso.ensureCharLoaded(st.gender); setTimeout(cb, 900); }
    else cb();
  };
  const apply = (reload) => ensureGender(() => {
    if (reload) purge(TOPS[st.ti], st.gender);
    iso.applyLoadout(av, { upper_body: TOPS[st.ti] }, st.gender);
    iso.playerFacing = FACINGS[st.fi];
    const a = ANIMS[st.ai];
    av.sprinting = (a === 'run'); av.speedBoosted = false;
    av.jumpOffset = (a === 'jump') ? -10 : 0;
    av.lastTileChange = (a === 'idle') ? 0 : (performance.now() + 1e7);
    hud.textContent = `WARDROBE  [N/P] top [G] gender [1-4] anim [F] turn [R] reload\n${st.gender}  ${TOPS[st.ti]}  ${a}  ${FACINGS[st.fi]}`;
  });
  // Remove a prior paste's listener so re-pasting doesn't double-fire keys.
  if (window.__wardrobeKey) window.removeEventListener('keydown', window.__wardrobeKey);
  window.__wardrobeKey = (e) => {
    const k = e.key.toLowerCase();
    if (k === 'n') { st.ti = (st.ti + 1) % TOPS.length; apply(true); }
    else if (k === 'p') { st.ti = (st.ti - 1 + TOPS.length) % TOPS.length; apply(true); }
    else if (k === 'g') { st.gender = st.gender === 'male' ? 'female' : 'male'; apply(true); }
    else if (['1','2','3','4'].includes(k)) { st.ai = +k - 1; apply(false); }
    else if (k === 'f') { st.fi = (st.fi + 1) % FACINGS.length; apply(false); }
    else if (k === 'r') { apply(true); }
  };
  window.addEventListener('keydown', window.__wardrobeKey);
  iso.cameras.main.setZoom(3.0);
  iso.cameras.main.centerOn(av.bodySprite.x, av.bodySprite.y - 8);
  apply(true);  // force-reload the starting item so you see current art immediately
  console.log('[wardrobe] installed (force-reload on switch) — N/P top, G gender, 1-4 anim, F turn, R reload');
})();
