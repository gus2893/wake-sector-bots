// BRSim - the web port of the Wake Sector combat gym (environment contract v1).
// Mirrors the UE arena: disc r=5000, shrinking lethal ring, cover bands, crate clusters,
// exos, 8 agents, the 13-action scripted arbiter, and the 19-feature observation.
// Units: cm, seconds. Deterministic-ish via a seeded RNG per sim.
const BRSim = (() => {
  const TAU = Math.PI * 2;
  const RING_DPS = 20, WALK = 600, THINK = 0.3;
  const SIGHT = 4000;   // vision radius (contract tune 2026-07-07: was 8000; obs still /8000)
  const RANGE = 2400;   // max weapon engagement distance (was 3800)
  // world modes: wilds (default) = large BR map with POIs; arena = the legacy small gym
  const MODES = {
    arena: { wallR: 5000,  ringStart: 4800,  ringMin: 700, ringDelay: 45, ringStep: 450, ringEvery: 10, roundCap: 150, spawnR: 4000 },
    wilds: { wallR: 15000, ringStart: 14000, ringMin: 900, ringDelay: 40, ringStep: 950, ringEvery: 10, roundCap: 300, spawnR: 13500 },
  };
  const ACTIONS = ['FIGHT','PUSH','COVERFIGHT','ARMUP','RESTOCK','GETEXO','FLEETOGEAR','BREAKCONTACT','HUNT','ROTATE','EXPLORE','HEAL','SHIELDUP'];
  // BC brain (7-action) -> sim action indices
  const BC_MAP = { FIGHT: 0, LOOT: 4, GETEXO: 5, FLEE: 7, HUNT: 8, EXPLORE: 10, COVER: 2 };

  function mulberry(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // ---------- world ----------
  function buildWorld(mode) {
    const cov = [];   // circles {x,y,r} (walls = 4 OVERLAPPING circles: spacing 110 < 2r, no sight gaps)
    const pois = [];  // POI centres
    const pillar = (x, y) => cov.push({ x, y, r: 90 });
    const wallAt = (x, y, facing) => {
      const tx = -Math.sin(facing), ty = Math.cos(facing); // tangent
      for (const d of [-165, -55, 55, 165]) cov.push({ x: x + tx * d, y: y + ty * d, r: 62 });
    };
    if (mode === 'arena') {
      for (const [x, y] of [[420, 620], [420, -620], [-420, 620], [-420, -620]]) pillar(x, y);
      for (let s = 0; s < 8; s++) { const a = Math.PI / 8 + s * Math.PI / 4; wallAt(Math.cos(a) * 1400, Math.sin(a) * 1400, a); }
      for (let k = 0; k < 4; k++) { const a = Math.PI / 4 + k * Math.PI / 2 + 0.175; wallAt(Math.cos(a) * 2600, Math.sin(a) * 2600, a); }
      for (let s = 0; s < 8; s++) {
        const a = Math.PI / 8 + s * Math.PI / 4;
        pillar(Math.cos(a) * 3400, Math.sin(a) * 3400);
      }
      return { cov, pois };
    }
    // wilds: 8 POIs on two rings, each a fixed local kit (3 walls + 3 pillars) rotated
    // to its bearing, plus lone field pillars so rotations between POIs have cover
    for (let k = 0; k < 4; k++) pois.push({ x: Math.cos(k * Math.PI / 2) * 5200, y: Math.sin(k * Math.PI / 2) * 5200 });
    for (let k = 0; k < 4; k++) { const a = Math.PI / 4 + k * Math.PI / 2; pois.push({ x: Math.cos(a) * 9800, y: Math.sin(a) * 9800 }); }
    for (const c of pois) {
      const a = Math.atan2(c.y, c.x);
      wallAt(c.x + Math.cos(a) * 500, c.y + Math.sin(a) * 500, a);
      wallAt(c.x + Math.cos(a + 2.2) * 560, c.y + Math.sin(a + 2.2) * 560, a + 1.3);
      wallAt(c.x + Math.cos(a - 2.4) * 480, c.y + Math.sin(a - 2.4) * 480, a - 0.9);
      for (const [r, da] of [[420, 1.1], [380, -1.2], [700, 3.0]])
        pillar(c.x + Math.cos(a + da) * r, c.y + Math.sin(a + da) * r);
    }
    for (let k = 0; k < 12; k++) {
      const fa = k * Math.PI / 6 + Math.PI / 12;
      const fr = k % 3 === 0 ? 3400 : (k % 3 === 1 ? 7600 : 12000);
      pillar(Math.cos(fa) * fr, Math.sin(fa) * fr);
    }
    return { cov, pois };
  }
  function losBlocked(cov, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    if (len2 < 1) return false;
    for (const c of cov) {
      const t = Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / len2));
      const px = a.x + dx * t - c.x, py = a.y + dy * t - c.y;
      if (px * px + py * py < c.r * c.r) return true;
    }
    return false;
  }

  // ---------- sim ----------
  function create(opts = {}) {
    const rng = mulberry(opts.seed || 1);
    const mode = MODES[opts.mode] ? opts.mode : 'wilds';
    const world = buildWorld(mode);
    const sim = {
      t: 0, round: 0, rng, mode, ...MODES[mode],
      cover: world.cov, pois: world.pois, crates: [], exos: [],
      agents: [], events: [], wins: new Array(8).fill(0), deaths: new Array(8).fill(0),
      roundStart: 0, ringR: MODES[mode].ringStart, policies: new Array(8).fill(null),
      onEvent: opts.onEvent || null, speedHz: 10,
    };
    for (let i = 0; i < 8; i++) sim.agents.push(makeAgent(i));
    resetRound(sim);
    return sim;
  }
  function makeAgent(i) {
    return {
      i, name: 'B' + (i + 1), x: 0, y: 0, hp: 100, sh: 0, frame: false, alive: true,
      wpn: null, mag: 0, spare: 0, bandage: 0, recharge: 0,
      vx: 0, vy: 0, tgt: -1, settle: 0, burstEnd: 0, nextBurst: 0, firing: false,
      goal: 'spawn', anchor: null, anchored: false, coverBan: 0, holdUntil: 0,
      huntSpot: null, lastEnemySeen: -99, lastGunfire: -99, nextDose: 0,
      wander: null, dodge: 1, nextFlip: 0, forced: -1, lockTag: 0, lockUntil: 0,
      dmgDealt: 0,
    };
  }
  function resetRound(sim) {
    sim.round++; sim.roundStart = sim.t; sim.ringR = sim.ringStart;
    emit(sim, { k: 'round', n: sim.round });
    // gear
    sim.crates = []; sim.exos = [];
    if (sim.mode === 'arena') {
      for (let k = 0; k < 4; k++) {
        const a = Math.PI / 4 + k * Math.PI / 2, cx = Math.cos(a) * 2200, cy = Math.sin(a) * 2200;
        for (const [ox, oy] of [[180, 0], [-120, 160], [-120, -160]])
          sim.crates.push({ x: cx + ox, y: cy + oy, rifle: 1, ammo: 240, bandage: 3, recharge: 2 });
      }
      for (let e = 0; e < 8; e++) {
        const a = Math.PI / 4 + e * TAU / 8;
        sim.exos.push({ x: Math.cos(a) * 240, y: Math.sin(a) * 240, taken: false });
      }
    } else {
      // every POI is a named location: its own gear + one exo
      for (const c of sim.pois) {
        const pa = Math.atan2(c.y, c.x), pc = Math.cos(pa), ps = Math.sin(pa);
        for (const [ox, oy] of [[180, 0], [-120, 160], [-120, -160], [420, 260], [-380, -340]])
          sim.crates.push({ x: c.x + ox * pc - oy * ps, y: c.y + ox * ps + oy * pc, rifle: 1, ammo: 240, bandage: 3, recharge: 2 });
        sim.exos.push({ x: c.x - 80 * ps, y: c.y + 80 * pc, taken: false });
      }
    }
    // spawns: shuffled ring slots
    const slots = [...Array(8).keys()].sort(() => sim.rng() - 0.5);
    sim.agents.forEach((ag, idx) => {
      const a = slots[idx] * TAU / 8 + (sim.rng() - 0.5) * 0.2;
      Object.assign(ag, makeAgent(ag.i), {
        x: Math.cos(a) * sim.spawnR, y: Math.sin(a) * sim.spawnR, goal: 'drop',
      });
    });
  }
  function emit(sim, e) {
    e.t = sim.t;
    sim.events.push(e);
    if (sim.events.length > 400) sim.events.splice(0, 100);
    if (sim.onEvent) sim.onEvent(e);
  }

  // ---------- perception + observation (the contract) ----------
  function perceive(sim, ag) {
    const seen = { enemies: [], crates: [], exos: [] };
    for (const e of sim.agents)
      if (e !== ag && e.alive && dist(ag, e) < SIGHT && !losBlocked(sim.cover, ag, e)) seen.enemies.push(e);
    for (const c of sim.crates)
      if ((c.rifle || c.ammo || c.bandage || c.recharge) && dist(ag, c) < SIGHT && !losBlocked(sim.cover, ag, c)) seen.crates.push(c);
    for (const x of sim.exos)
      if (!x.taken && dist(ag, x) < SIGHT && !losBlocked(sim.cover, ag, x)) seen.exos.push(x);
    if (seen.enemies.length) ag.lastEnemySeen = sim.t;
    return seen;
  }
  // 19 features - same names/order as Saved/BRBrain/brain.json "features"
  function buildObs(sim, ag, seen) {
    const nearE = seen.enemies.length ? Math.min(...seen.enemies.map(e => dist(ag, e))) : 15000;
    const nearC = seen.crates.length ? Math.min(...seen.crates.map(c => dist(ag, c))) : -1;
    const alive = sim.agents.filter(a => a.alive).length;
    return [
      ag.hp / 100, Math.max(0, ag.sh) / 40, ag.wpn ? 1 : 0, ag.frame ? 1 : 0,
      ag.wpn ? ag.mag / 30 : 0, Math.hypot(ag.vx, ag.vy) / WALK,
      seen.enemies.length ? 1 : 0, Math.min(1, nearE / 8000),
      seen.crates.length ? 1 : 0, nearC < 0 ? 1 : Math.min(1, nearC / 8000),
      0, 0, ag.firing ? 1 : 0, 0,
      seen.enemies.length / 7, alive / 8,
      Math.min(1, (sim.t - sim.roundStart) / 1800),
      Math.hypot(ag.x, ag.y) / sim.wallR, 1,
    ];
  }

  // ---------- the arbiter (compact port of the 13-action menu) ----------
  function think(sim, ag) {
    const seen = perceive(sim, ag);
    const myR = Math.hypot(ag.x, ag.y);
    const warm = sim.t - ag.lastEnemySeen < 6;
    const tgt = pickTarget(sim, ag, seen);
    const armed = !!ag.wpn && (ag.mag > 0 || ag.spare > 0);
    const threat = seen.enemies.filter(e => e.wpn)
      .sort((a, b) => dist(ag, a) - dist(ag, b))[0] || null;
    const options = [];
    const add = (score, tag, run) => options.push({ score, tag, run });

    // reflex: evacuate the hot zone
    if (myR > sim.ringR - Math.min(400, sim.ringR * 0.4))
      add(95, -1, () => { ag.goal = 'evacuate'; steerTo(ag, scale(ag, sim.ringR * 0.5)); ag.firing = false; });
    // reflex: exo beside you (targets outside the safe zone are never options -
    // chasing them ping-pongs against the evacuate reflex)
    const inZone = p => Math.hypot(p.x, p.y) < sim.ringR - 250;
    const nearExo = seen.exos.filter(inZone).sort((a, b) => dist(ag, a) - dist(ag, b))[0];
    if (nearExo && !ag.frame && dist(ag, nearExo) < 1200)
      add(80, 5, () => actGetExo(sim, ag, nearExo));
    // heal / shield-up
    if (sim.t >= ag.nextDose && (!threat || dist(ag, threat) > 1500)) {
      if (ag.bandage > 0 && ag.hp < 75) add(ag.hp < 40 ? 72 : 55, 11, () => actDose(sim, ag, 'bandage'));
      if (ag.recharge > 0 && ag.frame && ag.sh < 25) add(56, 12, () => actDose(sim, ag, 'recharge'));
    }
    // fight family
    if (armed && tgt) {
      const hurt = ag.hp < 40 && ag.sh <= 0;
      add(hurt ? 40 : 65, 0, () => actFight(sim, ag, tgt, 'fight'));
      add((ag.hp < 70 || ag.sh <= 0) ? 68 : 25, 2, () => actFight(sim, ag, tgt, 'cover'));
      add(22, 1, () => actFight(sim, ag, tgt, 'push'));
    } else ag.firing = false;
    // hold cover through warm contact
    if (armed && ag.anchor && warm && !tgt)
      add(52, 13, () => { ag.goal = 'hold'; steerTo(ag, ag.anchor); });
    else if (ag.anchor && !warm) ag.anchor = null;
    // economy
    const gunCrate = seen.crates.filter(c => c.rifle > 0 && inZone(c)).sort((a, b) => dist(ag, a) - dist(ag, b))[0];
    const anyCrate = seen.crates.filter(inZone).sort((a, b) => dist(ag, a) - dist(ag, b))[0];
    if (!armed && gunCrate) add(52, 3, () => actLoot(sim, ag, gunCrate));
    if (anyCrate) add(ag.wpn && ag.mag + ag.spare <= 0 ? 70 : (armed ? 35 : 30), 4, () => actLoot(sim, ag, anyCrate));
    if (!ag.frame && nearExo) add(42, 5, () => actGetExo(sim, ag, nearExo));
    // survival
    if (!armed && threat && dist(ag, threat) < 800)
      add(90, 6, () => actFlee(sim, ag, threat, gunCrate));
    if (threat) add(20, 7, () => actFlee(sim, ag, threat, null));
    // hunt (cold trails)
    if (armed && !warm && ag.huntSpot && sim.t - ag.lastGunfire < 45)
      add(30, 8, () => { ag.goal = 'hunt'; steerTo(ag, ag.huntSpot); if (dist(ag, ag.huntSpot) < 900) ag.huntSpot = null; });
    // ROTATE (field-only, like UE): reposition toward the safe zone before the ring bites
    if (sim.mode === 'wilds' && myR > sim.ringR * 0.6 && sim.t - sim.roundStart > sim.ringDelay - 10)
      add(26, 9, () => { ag.goal = 'rotate'; steerTo(ag, scale(ag, sim.ringR * 0.5)); });
    // floor: wander the gear band
    add(1, 10, () => actWander(sim, ag));

    // policy override: forced action -> its option scores 88 (missing option falls through)
    if (ag.forced >= 0) {
      const tagOf = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12][ag.forced];
      for (const o of options) if (o.tag === tagOf) o.score = 88;
    }
    // stickiness + commitment lock
    for (const o of options) {
      if (o.tag === ag.lockTag && o.tag >= 0) o.score += 10;
      if (sim.t < ag.lockUntil && o.tag === ag.lockTag) o.score = Math.max(o.score, 89);
    }
    options.sort((a, b) => b.score - a.score);
    const ran = options[0];
    if (ran) {
      if (ran.tag !== ag.lockTag && ran.tag >= 0) ag.lockUntil = sim.t + 1.5;
      ag.lockTag = ran.tag;
      ran.run();
      if (ran.tag < 0 || ran.tag > 2) ag.firing = false; // actions are exclusive: not fighting -> not firing
    }
  }
  function pickTarget(sim, ag, seen) {
    let best = null, bestScore = -1e9;
    for (const e of seen.enemies) {
      const d = dist(ag, e);
      let s = -d * 0.02;
      if (!e.wpn && d < 1800) s += 30;
      if (e.wpn && d < 1200) s += 20;
      if (!losBlocked(sim.cover, ag, e)) s += 18;
      if (e.i === ag.tgt) s += 8;
      if (s > bestScore) { bestScore = s; best = e; }
    }
    ag.tgt = best ? best.i : -1;
    return best;
  }

  // ---------- executors ----------
  const scale = (p, r) => { const m = Math.hypot(p.x, p.y) || 1; return { x: p.x / m * r, y: p.y / m * r }; };
  function steerTo(ag, p) { ag.dest = { x: p.x, y: p.y }; }
  function actLoot(sim, ag, c) {
    ag.goal = 'loot'; steerTo(ag, c);
    if (dist(ag, c) < 250) {
      if (c.rifle > 0 && !ag.wpn) { c.rifle--; ag.wpn = 'Rifle'; ag.mag = 30; emit(sim, { k: 'loot', a: ag.i, item: 'Rifle' }); }
      if (c.ammo > 0) { ag.spare += Math.min(120, c.ammo); c.ammo -= Math.min(120, c.ammo); }
      if (c.bandage > 0) { ag.bandage += c.bandage; c.bandage = 0; }
      if (c.recharge > 0) { ag.recharge += c.recharge; c.recharge = 0; }
      ag.goal = 'looted';
    }
  }
  function actGetExo(sim, ag, x) {
    if (ag.frame) return;
    ag.goal = 'exo'; steerTo(ag, x);
    if (dist(ag, x) < 320) { x.taken = true; ag.frame = true; ag.sh = 40; emit(sim, { k: 'exo', a: ag.i }); }
  }
  function actDose(sim, ag, kind) {
    ag.goal = 'recover';
    if (kind === 'bandage') { ag.bandage--; ag.hp = Math.min(100, ag.hp + 30); }
    else { ag.recharge--; ag.sh = 40; }
    ag.nextDose = sim.t + 2.5;
    emit(sim, { k: 'heal', a: ag.i, item: kind });
  }
  function actFlee(sim, ag, threat, gear) {
    ag.goal = gear ? 'flee:gear' : 'disengage';
    if (gear) { actLoot(sim, ag, gear); ag.goal = 'flee:gear'; return; }
    // ring-safe escape heading
    let dx = ag.x - threat.x, dy = ag.y - threat.y;
    const m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m;
    for (const turn of [0, 1.05, -1.05, 2.09, -2.09]) {
      const c = Math.cos(turn), s = Math.sin(turn);
      const tx = ag.x + (dx * c - dy * s) * 1800, ty = ag.y + (dx * s + dy * c) * 1800;
      if (Math.hypot(tx, ty) < sim.ringR - 250) { steerTo(ag, { x: tx, y: ty }); return; }
    }
    steerTo(ag, scale(ag, sim.ringR * 0.5)); // boxed - run for the disc
  }
  function actWander(sim, ag) {
    ag.goal = 'wander';
    if (!ag.wander || dist(ag, ag.wander) < 300) {
      if (sim.mode === 'wilds') {
        // BR wandering means moving between POIs still inside the safe zone
        const choices = sim.pois.filter(p => Math.hypot(p.x, p.y) < sim.ringR - 600);
        if (choices.length) {
          const p = choices[Math.floor(sim.rng() * choices.length)];
          const oa = sim.rng() * TAU, or = 200 + sim.rng() * 500;
          ag.wander = { x: p.x + Math.cos(oa) * or, y: p.y + Math.sin(oa) * or };
        } else ag.wander = scale(ag, sim.ringR * 0.5);
      } else {
        const a = sim.rng() * TAU;
        let r = 1900 + 600 * Math.abs(Math.sin(a * 3));
        r = Math.min(r, Math.max(400, sim.ringR - 400));
        ag.wander = { x: Math.cos(a) * r, y: Math.sin(a) * r };
      }
    }
    steerTo(ag, ag.wander);
  }
  function findCover(sim, ag, tgt, advance = false, curD = 0) {
    // advance=true: leapfrog - next blocked spot TOWARD the enemy (must close >=150),
    // else the classic nearest-to-me blocked spot. Hop reach 950 either way.
    let best = null, bd = 1e9;
    for (const c of sim.cover) {
      const away = { x: c.x - tgt.x, y: c.y - tgt.y };
      const m = Math.hypot(away.x, away.y) || 1;
      const spot = { x: c.x + away.x / m * (c.r + 150), y: c.y + away.y / m * (c.r + 150) };
      if (Math.hypot(spot.x, spot.y) > sim.ringR - 200) continue;   // cover in the storm is not cover
      if (dist(ag, spot) > 950) continue;
      if (advance && dist(spot, tgt) > curD - 150) continue;
      const score = advance ? dist(spot, tgt) : dist(ag, spot);
      if (score < bd && losBlocked(sim.cover, spot, tgt)) { bd = score; best = spot; }
    }
    return best;
  }
  function actFight(sim, ag, tgt, mode) {
    ag.goal = mode === 'cover' ? 'coverfight' : mode;
    const d = dist(ag, tgt);
    ag.settle = Math.min(1, ag.settle + THINK / 0.9);
    // cover posture: anchor + hold; push: close hard; fight: keep band
    if (mode === 'cover' && sim.t >= ag.coverBan) {
      // out-of-range camping is the death of coverfight: leapfrog cover toward the
      // enemy, and if no advancing cover exists yield to fight movement for a while
      const advance = d > RANGE - 200;
      if (advance && ag.anchor && dist(ag, ag.anchor) < 200) ag.anchor = null;
      if (!ag.anchor) ag.anchor = findCover(sim, ag, tgt, advance, d);
      if (ag.anchor) {
        steerTo(ag, ag.anchor);
        if (dist(ag, ag.anchor) < 200 && losBlocked(sim.cover, ag, tgt)) {
          // peek PERPENDICULAR to the firing line, stable side, far enough (330+90) to
          // clear the wall end - 230 parallel to a 330 wall never opened the line
          if (sim.t >= ag.nextFlip) { ag.dodge = -ag.dodge; ag.nextFlip = sim.t + 1.2 + sim.rng() * 0.8; }
          const fl = dist(ag.anchor, tgt) || 1;
          const fx = (tgt.x - ag.anchor.x) / fl, fy = (tgt.y - ag.anchor.y) / fl;
          steerTo(ag, { x: ag.anchor.x - fy * ag.dodge * 330 + fx * 90, y: ag.anchor.y + fx * ag.dodge * 330 + fy * 90 });
        }
      } else ag.coverBan = sim.t + 5;
    } else if (mode === 'push' || d > RANGE - 400) {
      steerTo(ag, tgt);
    } else if (d < 900 && mode !== 'push') {
      const away = scale({ x: ag.x - tgt.x, y: ag.y - tgt.y }, 1);
      steerTo(ag, { x: ag.x + away.x * 500, y: ag.y + away.y * 500 });
    } else {
      // serpentine
      if (sim.t >= ag.nextFlip) { ag.dodge = -ag.dodge; ag.nextFlip = sim.t + 0.55 + sim.rng() * 0.6; }
      const fx = (tgt.x - ag.x) / d, fy = (tgt.y - ag.y) / d;
      steerTo(ag, { x: ag.x - fy * ag.dodge * 420 + fx * 120, y: ag.y + fx * ag.dodge * 420 + fy * 120 });
    }
    // trigger: start a burst only when NOT already in one (re-triggering every think
    // kept pushing burstEnd forward -> bots planted, firing forever). The rounds
    // themselves flow from step() every tick, not from this 0.3s think.
    const blocked = losBlocked(sim.cover, ag, tgt);
    if (!ag.firing && !blocked && d < RANGE && ag.mag > 0 && sim.t >= ag.nextBurst) {
      ag.firing = true; ag.burstEnd = sim.t + 0.75;
    }
    if (ag.firing && (sim.t >= ag.burstEnd || blocked || ag.mag <= 0)) {
      ag.firing = false; ag.nextBurst = sim.t + 0.7 + sim.rng() * 0.4;
      if (ag.mag <= 0 && ag.spare > 0) { const n = Math.min(30, ag.spare); ag.mag = n; ag.spare -= n; }
    }
  }
  function fireAt(sim, ag, tgt) {
    // 8 rounds/s while the trigger is down; hit chance from the UE aim-error model
    ag.roundAcc = (ag.roundAcc || 0) + sim.dt * 8;
    while (ag.roundAcc >= 1 && ag.mag > 0) {
      ag.roundAcc--; ag.mag--;
      const d = dist(ag, tgt);
      const err = (15 + d * 0.012 + Math.hypot(tgt.vx, tgt.vy) * 0.09 + Math.hypot(ag.vx, ag.vy) * 0.10)
        * (1 - 0.85 * ag.settle);
      const p = Math.max(0.03, Math.min(0.95, 50 / (2 * Math.max(1, err))));
      ag.lastGunfireBroadcast = true;
      if (sim.rng() < p) {
        let dmg = 4.5;
        if (tgt.sh > 0) { const abs = Math.min(tgt.sh, dmg); tgt.sh -= abs; dmg -= abs; }
        tgt.hp -= dmg;
        ag.dmgDealt += 4.5;
        emit(sim, { k: 'hit', a: ag.i, v: tgt.i });
        if (tgt.hp <= 0) kill(sim, tgt, ag);
      }
    }
  }
  function kill(sim, victim, by) {
    victim.alive = false; victim.firing = false;
    sim.deaths[victim.i]++;
    emit(sim, { k: 'death', a: victim.i, by: by ? by.i : -1 });
    const alive = sim.agents.filter(a => a.alive);
    if (alive.length <= 1) {
      if (alive.length === 1) { sim.wins[alive[0].i]++; emit(sim, { k: 'win', a: alive[0].i }); }
      resetRound(sim);
    }
  }

  // ---------- tick ----------
  function step(sim, dt) {
    sim.dt = dt; sim.t += dt;
    // ring shrink
    const rt = sim.t - sim.roundStart;
    if (rt > sim.ringDelay)
      sim.ringR = Math.max(sim.ringMin, sim.ringStart - Math.floor((rt - sim.ringDelay) / sim.ringEvery) * sim.ringStep);
    // stalemate cap
    if (rt > sim.roundCap) { resetRound(sim); return; }
    for (const ag of sim.agents) {
      if (!ag.alive) continue;
      // think at cadence
      ag.thinkAcc = (ag.thinkAcc || 0) + dt;
      if (ag.thinkAcc >= THINK) {
        ag.thinkAcc = 0;
        if (sim.policies[ag.i]) ag.forced = sim.policies[ag.i](buildObs(sim, ag, perceive(sim, ag)));
        else ag.forced = -1;
        think(sim, ag);
        if (!ag.firing) ag.settle = Math.max(0, ag.settle - 0.15);
      }
      // continuous trigger between thinks - the fire RATE lives on the sim tick
      // (dt-accumulated in fireAt), the think only starts/stops the burst
      if (ag.firing) {
        const ft = sim.agents[ag.tgt];
        if (!ft || !ft.alive) ag.firing = false;
        else if (!losBlocked(sim.cover, ag, ft)) fireAt(sim, ag, ft);
      }
      // gunfire audio -> hunt leads
      if (ag.lastGunfireBroadcast) {
        ag.lastGunfireBroadcast = false;
        for (const o of sim.agents)
          if (o !== ag && o.alive && dist(ag, o) < 15000) { o.huntSpot = { x: ag.x, y: ag.y }; o.lastGunfire = sim.t; }
      }
      // move (planted while firing)
      const sp = ag.firing ? 0 : WALK;
      if (ag.dest && sp > 0) {
        let dx = ag.dest.x - ag.x, dy = ag.dest.y - ag.y;
        const m = Math.hypot(dx, dy);
        if (m > 30) {
          ag.vx = dx / m * sp; ag.vy = dy / m * sp;
          let nx = ag.x + ag.vx * dt, ny = ag.y + ag.vy * dt;
          // collide with cover circles + wall
          for (const c of sim.cover) {
            const cd = Math.hypot(nx - c.x, ny - c.y);
            if (cd < c.r + 40) {
              const push = (c.r + 40 - cd) + 1;
              nx += (nx - c.x) / (cd || 1) * push; ny += (ny - c.y) / (cd || 1) * push;
            }
          }
          const wr = Math.hypot(nx, ny);
          if (wr > sim.wallR - 60) { nx = nx / wr * (sim.wallR - 60); ny = ny / wr * (sim.wallR - 60); }
          ag.x = nx; ag.y = ny;
        } else { ag.vx = ag.vy = 0; }
      } else { ag.vx = ag.vy = 0; }
      // ring damage
      if (Math.hypot(ag.x, ag.y) > sim.ringR) {
        let dmg = RING_DPS * dt;
        if (ag.sh > 0) { const abs = Math.min(ag.sh, dmg); ag.sh -= abs; dmg -= abs; }
        ag.hp -= dmg;
        if (ag.hp <= 0 && ag.alive) kill(sim, ag, null);
      }
    }
  }

  // ---------- headless rollout (training / eval) ----------
  // policyFn(obs)->action for the POLICY cohort (odd agents); scripted drive the rest.
  function runRounds(policyFn, nRounds, seed = 7) {
    const sim = create({ seed });
    for (let i = 0; i < 8; i++) sim.policies[i] = (i % 2 === 1) ? policyFn : null;
    const startRound = sim.round;
    let guard = 0;
    while (sim.round - startRound < nRounds && guard++ < nRounds * sim.roundCap * 12) step(sim, 0.1);
    let polWins = 0, scrWins = 0, polDeaths = 0, scrDeaths = 0, dmg = 0;
    sim.agents.forEach((a, i) => {
      if (i % 2 === 1) { polWins += sim.wins[i]; polDeaths += sim.deaths[i]; dmg += a.dmgDealt; }
      else { scrWins += sim.wins[i]; scrDeaths += sim.deaths[i]; }
    });
    return { polWins, scrWins, polDeaths, scrDeaths, dmg };
  }

  // ---------- shared renderer ----------
  function draw(sim, cv) {
    const ctx = cv.getContext('2d');
    const S = cv.width / 2 / (sim.wallR * 1.06);
    const X = x => cv.width / 2 + x * S, Y = y => cv.height / 2 - y * S;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = '#26314a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(X(0), Y(0), sim.wallR * S, 0, TAU); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,93,93,.7)';
    ctx.beginPath(); ctx.arc(X(0), Y(0), sim.ringR * S, 0, TAU); ctx.stroke();
    ctx.fillStyle = '#1c2438';
    for (const c of sim.cover) { ctx.beginPath(); ctx.arc(X(c.x), Y(c.y), c.r * S, 0, TAU); ctx.fill(); }
    ctx.fillStyle = '#7c5a1e';
    for (const c of sim.crates)
      if (c.rifle || c.ammo || c.bandage || c.recharge) ctx.fillRect(X(c.x) - 3, Y(c.y) - 3, 6, 6);
    ctx.fillStyle = '#3fd0c9';
    for (const x of sim.exos) if (!x.taken) { ctx.beginPath(); ctx.arc(X(x.x), Y(x.y), 4, 0, TAU); ctx.fill(); }
    // shot tracers under the agents: who is shooting whom
    ctx.strokeStyle = 'rgba(255,184,77,.75)'; ctx.lineWidth = 1.5;
    for (const ag of sim.agents) {
      const ft = sim.agents[ag.tgt];
      if (!ag.alive || !ag.firing || !ft || !ft.alive) continue;
      ctx.beginPath(); ctx.moveTo(X(ag.x), Y(ag.y)); ctx.lineTo(X(ft.x), Y(ft.y)); ctx.stroke();
    }
    ctx.lineWidth = 2;
    for (const ag of sim.agents) {
      if (!ag.alive) continue;
      const px = X(ag.x), py = Y(ag.y), col = BRData.agentColor(ag.i);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(px, py, ag.firing ? 6.5 : 5, 0, TAU); ctx.fill();
      if (ag.firing) { ctx.strokeStyle = '#ffb84d'; ctx.beginPath(); ctx.arc(px, py, 9, 0, TAU); ctx.stroke(); }
      ctx.fillStyle = '#26314a'; ctx.fillRect(px - 11, py - 14, 22, 3);
      ctx.fillStyle = ag.hp > 40 ? '#46d18c' : '#ff5d5d';
      ctx.fillRect(px - 11, py - 14, 22 * Math.max(0, ag.hp) / 100, 3);
      if (ag.sh > 0) { ctx.fillStyle = '#4da3ff'; ctx.fillRect(px - 11, py - 18, 22 * ag.sh / 40, 2); }
      ctx.fillStyle = '#d7e0f0'; ctx.font = '10.5px Consolas';
      ctx.fillText(`${ag.name} ${ag.goal}`, px + 9, py - 5);
    }
  }

  return { create, step, draw, runRounds, buildObs, perceive, reset: resetRound, ACTIONS, BC_MAP,
    losBlocked, think };  // losBlocked + think exported for the smoke tests
})();
if (typeof module !== 'undefined') module.exports = BRSim; // node smoke tests
