# Wake Sector bot-learning environment contract (v1)

The cross-engine definition of the combat-gym environment. The UE game (source of truth),
the BRWeb gym (sim.js), and any future port (Godot etc.) implement THIS, so policies,
records, and dashboards transfer between them.

## World (two modes, 2026-07-07: "wilds" is the default)
Both are disc worlds with a physical rim wall, a lethal shrinking ring (20 hp/s outside,
shield absorbs first), 8 unarmed agents on a shuffled spawn ring, last-standing or
time-cap rounds. Walls are 4 OVERLAPPING LoS circles (spacing 110, r 62 - no sight gaps).

**wilds** (default) - the large BR map for actual BR behaviours:
- radius 15000; ring 14000 -> 900 (starts t+40s, -950 every 10s); round cap 300s; spawns r=13500.
- 8 POIs: 4 at r=5200 on bearings k*90 deg, 4 at r=9800 on bearings 45 + k*90 deg. Each POI =
  a fixed kit rotated to its bearing (3 walls + 3 pillars), 5 crates (rifle x1, ammo 240,
  bandage x3, recharge x2 each), and 1 exo. 12 lone field pillars between POIs for rotations.
- ROTATE (action 9) is offered in wilds only (field rule, like UE): outside 0.6*ring near
  ring time, reposition to 0.5*ring on your own bearing (never outward).
- Wander targets POIs still inside the safe zone (BR looting migration).

**arena** (legacy gym):
- radius 5000; ring 4800 -> 700 (starts t+45s, -450 every 10s); round cap 150s; spawns r=4000.
- Cover: 4 centre pillars (+-420, +-620); 8 tangent walls (~450 long) at r=1400 on bearings
  22.5 + k*45 deg; 4 cluster walls at r=2600 on bearings 55 + k*90 deg; 8 pillars at r=3400
  on bearings 22.5 + k*45 deg. Nothing may stand on the spawn->loot travel lanes
  (the 45-degree bearing family).
- Loot: 4 crate clusters at r=2200 on bearings 45 + k*90 (3 crates each); 8 exos at r=240.

## Observation (19 floats, this exact order)
hp/100, shield/40, armed(0|1), exo_on(0|1), mag_frac, spd_norm, enemy_vis(0|1),
enemy_dist/8000, crate_vis(0|1), crate_dist/8000 (1 if none), air_vis, box_vis, firing(0|1),
crouch(0|1), n_enemies_seen_norm, alive_frac, t_frac, dist_center/wall_radius, air_dist (1 if none).
Perception is fog-of-war: line-of-sight within 4000 only (tuned down from 8000 on 2026-07-07;
weapon engagement range 2400, was 3800 - the /8000 obs normalizers are UNCHANGED so trained
brains keep their input encoding). The observation may only contain what a player could see.

## Actions (13, exclusive discrete)
0 FIGHT (neutral trade) | 1 PUSH (finisher movement, no cover acquisition) | 2 COVERFIGHT
(anchor + peek, never push-drops) | 3 ARMUP (weapons-only loot) | 4 RESTOCK (general loot) |
5 GETEXO | 6 FLEETOGEAR (unarmed survival sprint to a gun) | 7 BREAKCONTACT (pure disengage,
ring-safe headings) | 8 HUNT (cold gunfire trails only) | 9 ROTATE (deliberate move into the
safe disc - FIELD maps only; masked in the gym) | 10 EXPLORE | 11 HEAL | 12 SHIELDUP.
Every action is legality-gated ("anti-nonsense"): a forced action with no legal option falls
through to the best legal one. Scripted survival reflexes (ring evacuation, adjacent exo
grab) always outrank the policy's choice.

## Reward
+1 round win (last standing), -1 death; optional small damage shaping. Zero-sum per round -
fleet-average reward measures the environment, not progress; evaluate with cohort A/Bs
(policy agents and scripted agents in the SAME rounds, pooled deaths/wins).

## Combat model
Rifle: range 3800, bursts ~0.75s at 8 rounds/s, ~4.5 dmg/hit, mag 30, gaps ~0.9s, planted
while firing. Aim error (cm at target):
(15 + dist*0.012 + tgt_speed*0.09 + own_speed*0.10) * (1 - 0.85*settle), settle ramps over
0.9s on-target. Shield absorbs before health. Bandage +30 hp, recharge -> shield 40 (both
2.5s dose cooldown, usable only with separation from armed threats).

## Match record schema (NDJSON, one JSON object per line)
- {"k":"match", v, match_id, map, started_utc, snap_hz, pois:[{i,name,tier,x,y,z}],
  agents:[{a,kind,team,spawn_poi}]}
- {"k":"snap", t, a, x, y, z, yaw, pitch, spd, hp, sh, shm, stam, down, wpn, mag, spare,
  crouch, firing, cd, xd, goal, plan, see:{loot[],enemy[],air[],box[]}}  (2 Hz per agent)
- {"k":"fire", t, a, weapon} | {"k":"hit", t, a, v, dmg} | {"k":"death", t, a, by, x, y, z}
- {"k":"loot", t, a, crate, item, count, slot} | {"k":"cast", t, a, ability}
- {"k":"round", t, n} | {"k":"end", t, reason, winner}
Any engine that emits this schema gets the replay viewer + dashboards for free.

## Policy file formats
- brain.json (behavior clone): {features:[19 names], actions:[names], layers:[{w:[[out][in]],
  b:[out]}]} - ReLU hidden, linear output, argmax.
- Evolved genome (BRWeb): flat array [nSizes, ...sizes, ...(w,b per layer)] - see net.js.
