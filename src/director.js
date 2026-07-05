// Orchestrates the run: streams rooms/corridors, ramps difficulty, spawns waves,
// locks gates for combat, drops pickups, drives combat music & objectives.
import * as THREE from 'three';
import { MapGen, WALL_H } from './mapgen.js';
import { buildCorridor, buildRoom } from './roombuilder.js';
import { Enemy, ARCHETYPES } from './enemy.js';
import { NavField } from './pathfind.js';
import { MAT } from './assets.js';

const KEEP_CELLS = 4;

// How far past a room's entrance wall the player's center must reach before combat
// trips. Small, so it fires the instant you step over the threshold — the doorway is
// the only breach in that wall, so any positive penetration means you're through it.
const ROOM_ENTER_DEPTH = 0.35;
// When combat trips, shove the player at least this far in from the entrance so the
// descending portcullis seals BEHIND them instead of clipping/trapping them mid-gap.
// Clears the gate slab (±0.25) plus the player radius (0.4) with margin to spare.
const ROOM_ENTER_PUSH = 1.0;

// The world streams rooms/corridors continuously, and each cell owns a handful of
// point lights (chandeliers, window glows, corridor sconces). three.js bakes the
// scene's total point-light count into every material's shader as a `#define`, so
// whenever that count changed — which was every single room, since it wandered from
// ~14 to ~34 — three.js recompiled every visible material's program. That GPU
// program link is the large stall that hit right when a room was cleared and the
// next cell was generated. We keep the number of *visible* point lights pinned to a
// constant instead: the nearest ones to the player stay lit, and zero-intensity
// filler lights pad the count up when a stretch happens to have fewer. Constant
// count -> shaders compile once -> no recompile spike (and it also caps worst-case
// per-fragment lighting cost, which used to run all 34 lights).
const POINT_LIGHT_BUDGET = 20;

// The same problem exists for SPOTLIGHTS. Each room used to own a shadow-casting spot, so the
// scene's spotlight count changed every time a hall streamed in/out — and three.js bakes that
// count into every material's shader, forcing a full program recompile (the 20–70ms
// room-transition stall). Instead the director keeps a FIXED pool of this many spots and
// slides them onto the rooms nearest the player, so the count never changes and shaders compile
// once. Sized to cover the most rooms ever live at once (the current room + the one you just
// cleared behind you, or the next one ahead — the streamer keeps exactly two live), so no
// visible room loses its spot and the per-frame shadow cost matches the old per-room setup.
const SPOT_BUDGET = 2;

// ---- Shekels ---------------------------------------------------------------
// A coin resource (max 3 in the player's pocket). One pops off every fallen boss and
// bounces to the floor as a collectable; with one in hand the player can toss it as a
// lure that skitters (and bounces off walls) across the room, pulling every bochur off
// the player until the first to reach it snatches it up.
const SHEKEL_GRAV = 17;          // matches the thrown-sefer feel
const SHEKEL_R = 0.18;           // coin radius for wall-bounce + grab tests
const SHEKEL_FLOOR = 0.1;        // centre height a bouncing coin bottoms out at
const SHEKEL_STAND_Y = 0.19;     // a settled coin rights itself onto its edge — centre ≈ its radius up
const SHEKEL_BOUNCE = 0.46;      // floor restitution
const SHEKEL_WALL_BOUNCE = 0.6;  // wall restitution
const SHEKEL_PICKUP_R = 1.2;     // how close the player must be to pocket a resting coin
const LURE_LIFETIME = 16;        // a tossed lure nobody grabs fades after this long (seconds settled)

// How long a collectable the PLAYER is meant to grab (a kugel plate, a boss-drop shekel)
// lingers before it expires and vanishes. The clock is pure accumulated `dt` inside
// update(), and update() runs only in the 'playing' state — so a cut-scene (which flips
// the game out of 'playing') freezes every live collectable's timer and it resumes right
// where it left off when the player returns. It shrinks away over the final COLLECT_FADE
// seconds instead of popping out. Tossed lures are exempt — they use LURE_LIFETIME.
const COLLECT_TTL = 5;           // seconds a kugel/boss-shekel stays grabbable before expiring
const COLLECT_FADE = 0.8;        // over the last this-many seconds it shrinks to nothing

export class Director {
  constructor(game) {
    this.game = game; // { scene, rng, audio, ui, player, quality, addScore, floaty3d }
  }

  reset() {
    // dispose everything
    if (this.cells) for (const c of this.cells) c.dispose(this.game.scene);
    if (this.enemies) for (const e of this.enemies) { this.game.scene.remove(e.root); e.dispose(); }
    if (this.pickups) for (const p of this.pickups) this.game.scene.remove(p.group);
    if (this.projectiles) for (const pr of this.projectiles) this._disposeProjectile(pr);
    if (this.shekels) for (const s of this.shekels) this._disposeShekel(s);

    this.mapgen = new MapGen(this.game.rng);
    this.cells = [];
    // Fixed pool of filler point lights (intensity 0) so the scene's visible
    // point-light count can be held constant — see POINT_LIGHT_BUDGET. Created once
    // and reused across runs (the scene persists), just re-hidden here.
    if (!this._fillers) {
      this._fillers = [];
      for (let i = 0; i < POINT_LIGHT_BUDGET; i++) {
        const f = new THREE.PointLight(0xffffff, 0, 0.001, 2);
        f.visible = false;
        this.game.scene.add(f);
        this._fillers.push(f);
      }
    }
    // Fixed pool of shadow-casting spotlights (see SPOT_BUDGET) — streamed rooms no longer own
    // one, so the scene's spotlight count stays constant and shaders never recompile as halls
    // stream. Repositioned onto the nearest rooms each frame by _applySpotBudget. Created once
    // and reused across runs (the scene persists).
    if (!this._spotPool && this.game.quality.shadows) {
      this._spotPool = [];
      for (let i = 0; i < SPOT_BUDGET; i++) {
        const spot = new THREE.SpotLight(0xffca82, 0, 30, Math.PI / 3.1, 0.5, 1.6);
        spot.castShadow = true;
        spot.shadow.mapSize.set(this.game.quality.shadowSize, this.game.quality.shadowSize);
        spot.shadow.camera.near = 1; spot.shadow.camera.far = 30; spot.shadow.bias = -0.0006;
        spot.position.set(0, WALL_H - 0.4, 0);
        this.game.scene.add(spot); this.game.scene.add(spot.target);
        this._spotPool.push({ spot, phase: Math.random() * 6.28 });
      }
    }
    this._litPoints = [];   // scratch array reused by _applyLightBudget
    this.rooms = [];        // room instances in order
    this.enemies = [];
    this._spawnQueue = []; // pending wave members, instantiated a couple per frame (see update drain)
    this.pickups = [];
    this.projectiles = [];  // thrown sefarim in flight (anti-perch)
    this.shekels = [];      // world shekels: bouncing boss-drops (mode 'pickup') + tossed lures (mode 'lure')
    this._lureTargets = []; // scratch list of live lure positions, rebuilt each frame for enemy AI
    this.campT = 0;         // how long the player has camped an unreachable perch
    this.roomState = 'idle'; // idle | approach | combat | cleared
    this.activeRoom = null;
    this.nav = null;          // flow-field pathfinder for the room being fought in
    this.pendingWaves = 0;
    this.waveDelay = 0;
    this._pendingSpawn = null; // room awaiting its next wave; gates the clear check, so
                               // it MUST reset or a mid-delay restart wedges every room shut
    this.depth = 0;
    this.kills = 0;
    this.objTimer = 0;
    this._genIndex = 0;
    this.boss = null;
    this.barer = null;        // Chaim Barer (every 12th hall)
    this.barerFreed = false;  // becomes true once the boss dies and he's vulnerable
    this._pregenRoom = null;  // next room pre-built + GPU-warmed during a finisher (see pregenNextRoom)

    // player ctx (stable object)
    const p = this.game.player;
    this.playerCtx = {
      pos: p.pos, radius: p.radius,
      takeDamage: (d, s) => p.takeDamage(d, s),
      eject: (fromPos, force, dmg) => p.knockOff(fromPos, force, dmg),
      knockBack: (fromPos, dist) => p.knockBack(fromPos, dist),   // bulvan: shove the player back
      applySlow: (factor, dur) => p.applySlow(factor, dur),       // mekubal: bind the player's legs
      get invuln() { return p.invuln; },
      get dead() { return p.dead; },
    };
  }

  start() {
    this.reset();
    // spawn corridor
    const c0 = this.mapgen.spawnCorridor();
    this._addCell(buildCorridor(c0, this.game.rng, this.game.quality));
    // first room (+ its outgoing corridor)
    this._generateRoom();

    // place player in the spawn corridor, facing into the yeshiva
    this.game.player.spawn(0, -1.6, 0);

    this.game.audio.setMusic('menu');
    this.game.audio.ambient(true);
    this.game.ui.objective('Enter the beis medrash…', 'warn');
    this.objTimer = 3;
    this.roomState = 'approach';
    // pin the light + spotlight budgets before the first frame renders (avoids an opening hitch)
    this._applyLightBudget();
    this._applySpotBudget(this.game.time);
  }

  // Hold the number of visible point lights constant so material shaders never need
  // recompiling as cells stream in and out. The nearest `POINT_LIGHT_BUDGET` real
  // lights to the player stay lit; any shortfall is padded with hidden-cost fillers.
  // Runs every frame (after any generate/dispose this tick, before the render).
  _applyLightBudget() {
    if (!this._fillers) return;
    const reals = this._litPoints;
    reals.length = 0;
    for (const c of this.cells) {
      const ls = c.lights;
      for (let j = 0; j < ls.length; j++) {
        const L = ls[j].light;
        if (L.isPointLight) reals.push(L);
      }
    }
    const budget = POINT_LIGHT_BUDGET, fillers = this._fillers;
    if (reals.length <= budget) {
      for (let i = 0; i < reals.length; i++) reals[i].visible = true;
      const need = budget - reals.length;
      for (let i = 0; i < fillers.length; i++) fillers[i].visible = i < need;
      return;
    }
    // more real lights than the budget — keep the nearest `budget` to the player lit
    const px = this.game.player.pos.x, pz = this.game.player.pos.z;
    reals.sort((a, b) => {
      const ax = a.position.x - px, az = a.position.z - pz;
      const bx = b.position.x - px, bz = b.position.z - pz;
      return (ax * ax + az * az) - (bx * bx + bz * bz);
    });
    for (let i = 0; i < reals.length; i++) reals[i].visible = i < budget;
    for (let i = 0; i < fillers.length; i++) fillers[i].visible = false;
  }

  // Slide the fixed spotlight pool onto the rooms nearest the player each frame. Because the
  // pool is a constant size, the scene's spotlight count never changes as halls stream — so
  // three.js compiles the material shaders once instead of relinking every material on each
  // room transition. A pool spot with no room to cover dims to zero but stays in the scene,
  // holding the count constant. `time` drives the same gentle flicker the per-room spots had.
  _applySpotBudget(time) {
    if (!this._spotPool) return;
    const px = this.game.player.pos.x, pz = this.game.player.pos.z;
    const live = this._spotRooms || (this._spotRooms = []);
    live.length = 0;
    for (const c of this.cells) {
      if (!c.cell || c.cell.type !== 'room') continue;
      const dx = c.center.x - px, dz = c.center.z - pz;
      live.push({ inst: c, d2: dx * dx + dz * dz });
    }
    live.sort((a, b) => a.d2 - b.d2);
    for (let i = 0; i < this._spotPool.length; i++) {
      const ps = this._spotPool[i], r = live[i];
      if (r) {
        const inst = r.inst;
        ps.spot.position.set(inst.center.x, WALL_H - 0.4, inst.center.z);
        ps.spot.target.position.set(inst.center.x, 0, inst.center.z);
        const td = inst.cell.themeData;
        if (td && td.light != null) ps.spot.color.setHex(td.light);
        ps.spot.intensity = 40 * (0.82 + 0.18 * Math.sin(time * 5 + ps.phase));
      } else {
        ps.spot.intensity = 0;   // no room to cover — contribute nothing, but stay in the count
      }
    }
  }

  _addCell(inst) {
    inst.genIndex = this._genIndex++;
    this.cells.push(inst);
    this.game.scene.add(inst.group);
    return inst;
  }

  _generateRoom() {
    const roomCell = this.mapgen.makeRoom();
    const roomInst = buildRoom(roomCell, this.game.rng, this.game.quality, [], { noSpot: true });
    this._addCell(roomInst);
    this.rooms.push(roomInst);
    // outgoing corridor (visible through the exit gate once opened)
    const corr = this.mapgen.makeCorridor();
    this._addCell(buildCorridor(corr, this.game.rng, this.game.quality));
    return roomInst;
  }

  _disposeOld(beforeGenIndex) {
    const keep = [];
    for (const c of this.cells) {
      if (c.genIndex < beforeGenIndex) c.dispose(this.game.scene);
      else keep.push(c);
    }
    this.cells = keep;
  }

  // Pre-build the NEXT room ahead of its reveal and pay its one-time GPU cost up front,
  // while it's still hidden behind the closed exit gate — so the frame that reveals it
  // doesn't hitch. Used two ways: during combat (see update, every hall) and during the
  // Barer finisher's frozen close-up. buildRoom itself is only a few ms; the real stall is
  // the first *draw* of the new cell (shader link + texture + vertex-buffer upload), which
  // nothing pays until it renders. So we force that draw here: un-cull the new cells,
  // compile their programs, and render them once to a tiny offscreen target. _clearRoom
  // then reveals the already-warmed cell for free.
  pregenNextRoom() {
    if (this._pregenRoom) return;                     // already built + warmed for this hall
    this.game._perfTag = 'pregen';
    const roomInst = this._generateRoom();            // builds + adds room + outgoing corridor
    const corrInst = this.cells[this.cells.length - 1];
    this._pregenRoom = roomInst;
    const R = this.game.renderer;
    if (!R) return;                                   // no renderer (headless gen) — warm lazily on reveal
    const scene = this.game.scene, cam = this.game.player.camera;
    // Pin the visible point-light count BEFORE the warm render. _generateRoom just added the
    // new cell's point lights (visible by default); left unpinned, the warm render would see
    // a changed light count and recompile every material — the very stall we're warming to
    // avoid. Applying the budget first hides the far new lights so the count holds constant.
    this._applyLightBudget();
    const touched = [];
    for (const inst of [roomInst, corrInst]) inst.group.traverse((o) => {
      if (o.isMesh && o.frustumCulled) { o.frustumCulled = false; touched.push(o); }
    });
    try {
      if (!this._warmTarget) this._warmTarget = new THREE.WebGLRenderTarget(16, 16);
      R.compile(scene, cam);
      const prev = R.getRenderTarget();
      R.setRenderTarget(this._warmTarget);
      R.render(scene, cam);
      R.setRenderTarget(prev);
    } catch (e) { /* warming is best-effort; worst case the resume pays the cost as before */ }
    for (const o of touched) o.frustumCulled = true;  // restore normal culling for real play
  }

  diffScale(d) {
    return {
      hp: 1 + d * 0.08,
      speed: Math.min(1.6, 1 + d * 0.016),
      dmg: Math.min(2.5, 1 + d * 0.05),
      poise: Math.min(2, 1 + d * 0.035),  // guards toughen slowly — far behind HP growth
    };
  }

  // Enemy mix by hall depth. The two disruptors are sprinkled in as the run deepens and
  // then grow more common: the leg-binding mekubal from hall 3, the knock-you-back bulvan
  // from hall 5, so their new threats arrive one at a time rather than all at once.
  typeWeights(d) {
    if (d < 3) return [['bochur', 7], ['masmid', 3]];
    if (d < 5) return [['bochur', 5], ['masmid', 3], ['gabbai', 1], ['mekubal', 1]];
    if (d < 8) return [['bochur', 4], ['masmid', 3], ['gabbai', 2], ['mekubal', 2], ['bulvan', 1]];
    if (d < 12) return [['bochur', 3], ['masmid', 3], ['gabbai', 3], ['mekubal', 2], ['bulvan', 2]];
    return [['bochur', 3], ['masmid', 2], ['gabbai', 3], ['mekubal', 3], ['bulvan', 3]];
  }

  _spawnWave(room, opts = {}) {
    const rng = this.game.rng, d = this.depth;
    const scale = this.diffScale(d);
    const count = opts.count != null ? opts.count : Math.min(3 + Math.floor(d * 0.7), 9);
    const weights = this.typeWeights(d);
    // The boss enters immediately (kept synchronous so this.boss, its HP bar, and the Barer's
    // shield are all valid from frame one); the rank-and-file are QUEUED and streamed in a
    // couple per frame by update()'s drain, so a whole wave's `new Enemy` + first-draw upload
    // never lands in a single frame — that was the room-start stall.
    if (opts.boss) {
      const e = new Enemy('mashgiach', scale, rng);
      // center-stage entrance, but snap to a clear spot if the bimah/tables sit there
      const sp = room.spawnNear(room.center.x, room.center.z);
      e.setPos(sp.x, sp.z);
      this.game.scene.add(e.root);
      this.enemies.push(e);
      this.boss = e;
    }
    for (let i = 0; i < count; i++) this._spawnQueue.push({ room, scale, weights });
  }

  // Chaim Barer joins the Mashgiach every 12th hall — shielded until his master falls.
  _spawnBarer(room) {
    const scale = this.diffScale(this.depth);
    const e = new Enemy('barer', scale, this.game.rng);
    const sp = room.spawnNear(room.center.x + 3.0, room.center.z + 1.6);
    e.setPos(sp.x, sp.z);
    this.game.scene.add(e.root);
    this.enemies.push(e);
    this.barer = e;
    this.barerFreed = false;
    this.game.ui.setBarer(1, true);
  }

  aliveCount() { let n = 0; for (const e of this.enemies) if (!e.dead) n++; return n; }

  // debug: drop a Chaim Barer a few metres in front of the player (headless smoke test)
  debugSpawnBarerNearPlayer(vulnerable = false) {
    const p = this.game.player.pos;
    const e = new Enemy('barer', this.diffScale(12), this.game.rng);
    e.setPos(p.x, p.z - 3.2);
    e.facing = Math.PI; e.root.rotation.y = Math.PI;
    if (vulnerable) e.invulnerable = false;
    this.game.scene.add(e.root);
    this.enemies.push(e);
    this.barer = e;
    return e;
  }

  // debug: drop a shekel a couple of metres in front of the player, exactly as a fallen
  // boss would — same pop-out-and-bounce (see _dropShekel). Dev/headless hook to test the
  // shekel drop/collect flow without clearing a boss hall.
  debugDropShekelNearPlayer() {
    const p = this.game.player, f = p.forwardXZ();
    this._dropShekel(p.pos.x + f.x * 2.2, p.pos.z + f.z * 2.2);
  }

  // debug (local dev): force-clear the active combat hall — strip every live enemy so the
  // next update runs the room-clear path — to profile the clear transition on demand
  // without fighting through a whole wave. No-op outside combat.
  debugForceClear() {
    if (this.roomState !== 'combat' || !this.activeRoom) return;
    this.pendingWaves = 0; this.waveDelay = 0; this._pendingSpawn = null; this._spawnQueue.length = 0;
    for (const e of this.enemies) { this.game.scene.remove(e.root); e.dispose(); }
    this.enemies.length = 0;
    this.boss = null; this.barer = null;
  }

  _triggerRoom(room) {
    this.game._perfTag = 'room-trigger';
    this.depth = room.cell.depth;
    this.activeRoom = room;
    this.roomState = 'combat';
    // flow-field for the swarm: grid the room's furniture so enemies path around it.
    // 0.4u is fine enough to resolve the narrow lanes furniture leaves — a coarser grid
    // aliases real detours away, leaving enemies to grind on a table with a way around it.
    this.nav = new NavField(room.innerBounds, room.getColliders(), { cell: 0.4, clearance: 0.45 });
    room.entranceGate.close();
    // shove the player clear of the doorway so the portcullis drops behind them
    const p = this.game.player, c = room.cell;
    const inX = -c.entryDir.x, inZ = -c.entryDir.z;
    const depth = this._entryDepth(room, p.pos);
    if (depth < ROOM_ENTER_PUSH) {
      const d = ROOM_ENTER_PUSH - depth;
      p.nudgeBy(inX * d, inZ * d);   // smooth glide in, not a snap (see Player.nudgeBy)
    }
    this.game.audio.gate(false);
    this.game.audio.shofar();
    this.game.audio.setMusic('combat');
    this.game.audio.setIntensity(Math.min(1, this.depth / 15));
    this.game.ui.setDepth(this.depth);
    room._triggered = true;
    this.boss = null;
    this.barer = null;
    this.barerFreed = false;
    // a fresh fight starts clean — drop any lure coins the player tossed in the corridor
    // on the way in, so the new room's bochurim don't path toward a coin behind the gate
    for (let i = this.shekels.length - 1; i >= 0; i--) {
      if (this.shekels[i].mode === 'lure') { this._disposeShekel(this.shekels[i]); this.shekels.splice(i, 1); }
    }

    const boss = room.cell.boss;
    // wave plan
    if (boss) {
      this.pendingWaves = 1;
      this._spawnWave(room, { boss: true, count: Math.min(2 + Math.floor(this.depth * 0.25), 5) });
      // every 3rd boss (every 12th hall) the boss brings his lackey, Chaim Barer
      if (this.depth % 12 === 0) this._spawnBarer(room);
      this.game.ui.objective(this.barer ? 'THE MASHGIACH RISES — AND CHAIM BARER SNEERS' : 'THE MASHGIACH HAS RISEN', 'danger');
      this.game.ui.setBoss('The Mashgiach', 1);
    } else {
      let waves = 1;
      if (this.depth >= 3 && this.depth < 7) waves = this.game.rng.chance(0.5) ? 2 : 1;
      else if (this.depth >= 7 && this.depth < 12) waves = 2;
      else if (this.depth >= 12) waves = this.game.rng.chance(0.4) ? 3 : 2;
      this.pendingWaves = waves;
      this._spawnWave(room);
      this.game.ui.objective('Defeat the bochurim!', 'danger');
    }
    this.pendingWaves -= 1;
    this.objTimer = 2.6;
  }

  _nextWaveOrClear(room) {
    if (this.pendingWaves > 0) {
      this.pendingWaves -= 1;
      this.waveDelay = 1.4;
      this.game.audio.shofar();
      this.game.ui.objective('More of them pour in…', 'danger');
      this.objTimer = 2.2;
      this._pendingSpawn = room;
    } else {
      this._clearRoom(room);
    }
  }

  // Called by the game when the finisher's explosion resolves: clear out Barer and any
  // stragglers, then open the way onward.
  finishBarerEncounter() {
    for (const e of this.enemies) { this.game.scene.remove(e.root); e.dispose(); }
    this.enemies.length = 0;
    this.game.addScore(1500 + this.depth * 60);
    this.barer = null;
    this.barerFreed = false;
    if (this.activeRoom) this._clearRoom(this.activeRoom);
  }

  _clearRoom(room) {
    this.game._perfTag = 'room-clear';
    this.roomState = 'cleared';
    this.nav = null;
    this.campT = 0;
    this._spawnQueue.length = 0;   // drop any un-spawned reinforcements when the hall clears
    for (const pr of this.projectiles) this._disposeProjectile(pr);
    this.projectiles.length = 0;
    // combat's over: clear any tossed lures still lying around (the boss-drop collectable,
    // mode 'pickup', is kept so the player can still pocket it in the cleared hall)
    for (let i = this.shekels.length - 1; i >= 0; i--) {
      if (this.shekels[i].mode === 'lure') { this._disposeShekel(this.shekels[i]); this.shekels.splice(i, 1); }
    }
    room.exitGate.open();
    this.game.audio.gate(true);
    this.game.audio.setMusic('menu');
    this.boss = null;
    this.barer = null;
    this.game.ui.setBoss(null, null);
    this.game.ui.setBarer(null);
    this.game.ui.objective('The way is open — press on →', 'warn');
    this.objTimer = 4;
    // reward
    const bonus = 250 + this.depth * 75;
    this.game.addScore(bonus);
    this.game.ui.toast(`Hall cleared  +${bonus}`);
    // drop a kugel to recover
    this._dropPickup(room.center.x, room.center.z, room.cell.boss ? 2 : 1);
    // build the next room now (revealed through the corridor) — unless the finisher
    // already pre-built and GPU-warmed it during its frozen close-up (see pregenNextRoom),
    // leaving the resume frame nothing heavy to do
    if (this._pregenRoom) this._pregenRoom = null;
    else this._generateRoom();
    // dispose cells well behind us
    this._disposeOld(room.genIndex - 1);
    // boss halls fire their one-time cut-scenes: the first the dvar-torah, the second the
    // chavrusa with Rabbi Zehnwirth. The game consumes the flag on the next frame
    // (see _updatePlaying / _beginDvarTorah / _beginZehnwirth). `_dvarShown` is already
    // true by the time a second boss falls, so the two never collide.
    if (room.cell.boss) {
      if (!this.game._dvarShown) this.game._dvarPending = true;
      else if (!this.game._zehnShown) this.game._zehnPending = true;
    }
  }

  // called by game when the player lands a kill
  reportKill(info) {
    this.kills++;
    // every boss (the Mashgiach) coughs up a shekel as he falls — it pops from his body
    // and bounces to the floor for the player to pocket
    if (info.type === 'mashgiach') this._dropShekel(info.pos.x, info.pos.z);
    if (info.type && info.type !== 'bochur' && this.game.rng.chance(info.type === 'masmid' ? 0.12 : 0.4)) {
      this._dropPickup(info.pos.x, info.pos.z, 1);
    }
  }

  _dropPickup(x, z, n = 1) {
    for (let i = 0; i < n; i++) {
      const g = new THREE.Group();
      const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.24, 0.05, 14), MAT.plate);
      const kugel = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), MAT.kugel);
      kugel.scale.set(1, 0.7, 1); kugel.position.y = 0.13; plate.add(kugel);
      g.add(plate);
      const ox = x + (i === 0 ? 0 : (this.game.rng.range(-1, 1)));
      const oz = z + (i === 0 ? 0 : (this.game.rng.range(-1, 1)));
      g.position.set(ox, 0.5, oz);
      this.game.scene.add(g);
      // age: seconds this plate has been on the floor; expires at COLLECT_TTL (paused during cut-scenes)
      this.pickups.push({ group: g, pos: { x: ox, z: oz }, t: this.game.rng.range(0, 6), age: 0 });
    }
  }

  // Track how long the player has held an unreachable perch; return whether the
  // anti-perch AI should be active this frame.
  _updatePerch(dt, player) {
    if (this.roomState !== 'combat') { this.campT = 0; return false; }
    const elevated = player.yOff > 0.2;
    let reachable = false;
    if (elevated) {
      for (const e of this.enemies) {
        if (e.dead) continue;
        const dx = e.pos.x - player.pos.x, dz = e.pos.z - player.pos.z;
        const r = e.arch.reach + player.radius + 0.35;
        if (dx * dx + dz * dz <= r * r) { reachable = true; break; }
      }
    }
    if (elevated && !reachable) this.campT += dt; else this.campT = 0;
    return this.campT > 1.2; // grace window: brief hops don't trigger the barrage
  }

  // Spawn a tumbling sefer that arcs from the thrower toward the player's torso.
  _spawnSefer(from, fromY, target, targetY, dmg) {
    const grp = new THREE.Group();
    const cover = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.1, 0.24), MAT.woodRed);
    const pages = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.08, 0.2), MAT.paper);
    pages.position.z = 0.02;
    grp.add(cover); grp.add(pages);
    const x0 = from.x, z0 = from.z, y0 = fromY + 1.3;      // released from about chest height
    grp.position.set(x0, y0, z0);
    this.game.scene.add(grp);
    // fixed flight time → solve the ballistic launch velocity that lands on the target
    const T = 0.5, gAcc = 17;
    const tx = target.x, tz = target.z, ty = targetY + 1.0;
    const vx = (tx - x0) / T, vz = (tz - z0) / T;
    const vy = (ty - y0) / T + 0.5 * gAcc * T;
    this.projectiles.push({ group: grp, x: x0, y: y0, z: z0, vx, vy, vz, g: gAcc, dmg, life: 2.4, spin: this.game.rng.range(7, 13) });
  }

  _disposeProjectile(pr) {
    this.game.scene.remove(pr.group);
    pr.group.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
  }

  // ---- Shekels --------------------------------------------------------------
  // A minted gold coin: a flat disc with a slightly darker rim, wrapped in a group so it
  // can tumble through the air and then settle flat on the floor.
  _makeShekelMesh() {
    const g = new THREE.Group();
    // CylinderGeometry groups: 0 = curved side, 1 = top cap, 2 = bottom cap. The flat caps
    // carry the struck Hebrew face; the reeded side is plain gold.
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(SHEKEL_R, SHEKEL_R, 0.055, 24),
      [MAT.shekelEdge, MAT.shekelFace, MAT.shekelFace],
    );
    disc.rotation.x = Math.PI / 2;   // stand the coin upright: faces point ±Z, it rests on its rim
    disc.castShadow = true;
    // a torus ringing the edge. A default torus lies in the XY plane (hole axis Z), which
    // already rings the now-upright (Z-axis) disc — no rotation needed.
    const rim = new THREE.Mesh(new THREE.TorusGeometry(SHEKEL_R, 0.022, 8, 24), MAT.shekelEdge);
    g.add(disc); g.add(rim);
    return g;
  }

  // Boss drop: pop a coin up out of the fallen body so it arcs and bounces onto the floor,
  // then rests as a collectable. `mode:'pickup'` — only the player can take it (walk over it).
  _dropShekel(x, z) {
    const g = this._makeShekelMesh();
    const y0 = 1.2;                                   // bursts from about chest height
    g.position.set(x, y0, z);
    this.game.scene.add(g);
    const rng = this.game.rng;
    const ang = rng.range(0, Math.PI * 2), out = rng.range(1.2, 2.4);
    this.shekels.push({
      group: g, mode: 'pickup',
      x, y: y0, z,
      vx: Math.cos(ang) * out, vz: Math.sin(ang) * out, vy: rng.range(3.6, 4.8),
      spin: rng.range(9, 15), tumbleX: rng.range(0.6, 1.0), tumbleZ: rng.range(0.3, 0.7),
      grounded: false, settled: false, grabbable: false, grabbed: false,
      settleT: 0, bob: rng.range(0, 6.28),
      age: 0,   // grabbable lifetime; expires at COLLECT_TTL (paused during cut-scenes)
    });
    this.game.audio.coinGet();   // a bright ching as it pops free (the boss "pays out")
  }

  // Player toss: fling a coin from the hand as a lure. `mode:'lure'` — enemies chase it and
  // the first to reach it snatches it. `info` = { x,z,y, dirX,dirZ, pitch } from Player._releaseToss.
  tossShekel(info) {
    const g = this._makeShekelMesh();
    const x0 = info.x + info.dirX * 0.5, z0 = info.z + info.dirZ * 0.5, y0 = info.y;
    g.position.set(x0, y0, z0);
    this.game.scene.add(g);
    const rng = this.game.rng;
    // a powerful, flat throw: lots of horizontal punch with a modest lob so it sails clear
    // across the hall (and keeps skipping off the floor — see the low friction on bounce)
    const speed = 14 + Math.max(0, -info.pitch) * 7;   // looking up hurls it farther still
    this.shekels.push({
      group: g, mode: 'lure',
      x: x0, y: y0, z: z0,
      vx: info.dirX * speed, vz: info.dirZ * speed, vy: 3.6 + Math.max(0, -info.pitch) * 2.6,
      spin: rng.range(12, 18), tumbleX: rng.range(0.7, 1.0), tumbleZ: rng.range(0.4, 0.8),
      grounded: false, settled: false, grabbable: false, grabbed: false,
      settleT: 0, bob: rng.range(0, 6.28),
    });
  }

  // Reflect a coin off wall / furniture sides it has run into this frame. Only surfaces
  // taller than the coin's current height can be hit (it sails over low benches when high,
  // but skitters off their sides once it's down rolling on the floor).
  _bounceShekelWalls(s, colliders) {
    for (let i = 0; i < colliders.length; i++) {
      const b = colliders[i];
      if (b.top !== undefined && b.top <= s.y) continue;   // coin is above this surface — no side contact
      const cx = Math.max(b.minX, Math.min(s.x, b.maxX));
      const cz = Math.max(b.minZ, Math.min(s.z, b.maxZ));
      let dx = s.x - cx, dz = s.z - cz;
      let d2 = dx * dx + dz * dz;
      if (d2 > SHEKEL_R * SHEKEL_R) continue;
      let nx, nz;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2); nx = dx / d; nz = dz / d;
        const push = SHEKEL_R - d;
        s.x += nx * push; s.z += nz * push;              // eject to the surface
      } else {
        // centre inside the box — pop out along the least-penetration axis
        const penL = s.x - b.minX, penR = b.maxX - s.x, penT = s.z - b.minZ, penB = b.maxZ - s.z;
        const m = Math.min(penL, penR, penT, penB);
        if (m === penL) { s.x = b.minX - SHEKEL_R; nx = -1; nz = 0; }
        else if (m === penR) { s.x = b.maxX + SHEKEL_R; nx = 1; nz = 0; }
        else if (m === penT) { s.z = b.minZ - SHEKEL_R; nx = 0; nz = -1; }
        else { s.z = b.maxZ + SHEKEL_R; nx = 0; nz = 1; }
      }
      // reflect the horizontal velocity about the wall normal, with restitution
      const vn = s.vx * nx + s.vz * nz;
      if (vn < 0) {
        s.vx -= (1 + SHEKEL_WALL_BOUNCE) * vn * nx;
        s.vz -= (1 + SHEKEL_WALL_BOUNCE) * vn * nz;
        const spd = Math.hypot(s.vx, s.vz);
        if (spd > 1.2 && !s.settled) this.game.audio.coinBounce(spd / 8);
      }
    }
  }

  _disposeShekel(s) {
    this.game.scene.remove(s.group);
    s.group.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
  }

  currentColliders() {
    const out = [];
    for (const c of this.cells) { const cc = c.getColliders(); for (let i = 0; i < cc.length; i++) out.push(cc[i]); }
    return out;
  }

  // breakable window panes across the streamed cells — the player's punch tests
  // against these to crack/shatter glass
  currentWindows() {
    const out = [];
    for (const c of this.cells) { const ws = c.windows; if (ws) for (let i = 0; i < ws.length; i++) out.push(ws[i]); }
    return out;
  }

  // bookshelf controllers across the streamed cells — the player tests these for a slam
  // (sprinting/knocked into one), and the director ticks their falling sefarim (below)
  currentBookshelves() {
    const out = [];
    for (const c of this.cells) { const bs = c.bookshelves; if (bs) for (let i = 0; i < bs.length; i++) out.push(bs[i]); }
    return out;
  }

  // seat anchors (benches/chairs) across the streamed cells — the player tests these
  // for the sit interaction (aim + range + availability); occupancy is tracked per seat.
  currentSeats() {
    const out = [];
    for (const c of this.cells) { const ss = c.seats; if (ss) for (let i = 0; i < ss.length; i++) out.push(ss[i]); }
    return out;
  }

  update(dt, time) {
    const g = this.game, player = g.player;

    // update world cells (flicker, gates)
    for (const c of this.cells) c.update(dt, time);

    const colliders = this.currentColliders();

    // ---- room progression: while not fighting, entering an un-triggered room starts combat
    if (this.roomState !== 'combat') {
      const inside = this._roomAt(player.pos);
      if (inside && !inside._triggered) this._triggerRoom(inside);
    }

    // ---- wave delay handling
    if (this.waveDelay > 0) {
      this.waveDelay -= dt;
      if (this.waveDelay <= 0 && this._pendingSpawn) { this._spawnWave(this._pendingSpawn); this._pendingSpawn = null; }
    }

    // ---- spawn-queue drain: stream a couple of wave members in per frame (see _spawnWave)
    // so a full wave's `new Enemy` + first-draw upload never lands in one frame — that was
    // the room-start stall. The spawn "rise" animation masks the staggered arrival.
    if (this.roomState === 'combat' && this._spawnQueue.length) {
      this.game._perfTag = 'wave-spawn';
      const per = Math.min(2, this._spawnQueue.length);
      for (let k = 0; k < per; k++) {
        const spec = this._spawnQueue.shift();
        const rng = this.game.rng;
        const e = new Enemy(rng.weighted(spec.weights), spec.scale, rng);
        const sp = spec.room.randomSpawn(rng, player.pos, 5.5);
        e.setPos(sp.x, sp.z);
        this.game.scene.add(e.root);
        this.enemies.push(e);
      }
    }

    // ---- anti-perch: is the player camping an elevated spot no enemy can melee?
    // Keyed off player.yOff (the height of whatever furniture they're on, single piece
    // or a whole cluster) + live unreachability, so it's agnostic to the layout. A short
    // grace timer means a quick hop up to reset still feels safe.
    const antiPerch = this._updatePerch(dt, player);
    this._antiPerch = antiPerch; // exposed for debugging/verification

    // ---- enemy updates
    const bounds = (this.roomState === 'combat' && this.activeRoom) ? this.activeRoom.innerBounds : null;
    // recompute the flow field toward the player (cheap: no-op unless the player
    // crossed into a new grid cell)
    if (this.nav) this.nav.update(player.pos.x, player.pos.z);
    // ---- shekel lures: every tossed coin still in play draws the whole room toward it
    const lures = this._lureTargets; lures.length = 0;
    for (const s of this.shekels) if (s.mode === 'lure' && !s.grabbed) lures.push({ x: s.x, z: s.z });
    const ctx = {
      player: this.playerCtx, colliders, enemies: this.enemies,
      audio: g.audio, time, camera: player.camera, bounds, nav: this.nav,
      antiPerch, campT: this.campT, perchY: player.yOff,
      lures: lures.length ? lures : null,
      spawnSefer: (from, fromY, target, targetY, dmg) => this._spawnSefer(from, fromY, target, targetY, dmg),
    };
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      e.update(dt, ctx);
      if (e.removeMe) { g.scene.remove(e.root); e.dispose(); this.enemies.splice(i, 1); }
    }
    // boss bar
    if (this.boss && !this.boss.dead) g.ui.setBoss('The Mashgiach', this.boss.hp / this.boss.maxHp);

    // ---- Chaim Barer: shielded until the Mashgiach falls, then exposed & fragile
    if (this.barer && !this.barer.dead && this.barer.state !== 'downed') {
      if (this.barer.invulnerable && (!this.boss || this.boss.dead)) {
        this.barer.invulnerable = false; this.barerFreed = true;
        g.audio.shofar();
        g.ui.setBoss(null, null);
        g.ui.toast('Chaim Barer is exposed — finish him!', 2.2);
        g.ui.objective('DESTROY CHAIM BARER', 'danger');
        this.objTimer = 3;
      }
      g.ui.setBarer(this.barer.hp / this.barer.maxHp, this.barer.invulnerable);
    }
    // Barer beaten down → play the cinematic "time stops" transition, which locks the
    // camera onto him as he crumples and then hands off to the interactive finisher (once)
    if (this.barer && this.barer.state === 'downed' && g.state === 'playing') {
      g._beginBarerDown(this.barer);
      return; // don't run the clear/wave check on the frame we transition out
    }

    // ---- clear / next wave check
    if (this.roomState === 'combat' && this.activeRoom && this.waveDelay <= 0 && !this._pendingSpawn && !this._spawnQueue.length) {
      if (this.aliveCount() === 0) this._nextWaveOrClear(this.activeRoom);
    }

    // ---- pickups
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      p.t += dt;
      // grabbable lifetime: this only advances while the director ticks (i.e. during
      // 'playing'), so a cut-scene freezes the countdown until the player is back
      p.age += dt;
      if (p.age >= COLLECT_TTL) { g.scene.remove(p.group); this.pickups.splice(i, 1); continue; }
      p.group.position.y = 0.5 + Math.sin(p.t * 2.2) * 0.08;
      p.group.rotation.y += dt * 1.4;
      p.group.scale.setScalar(Math.min(1, (COLLECT_TTL - p.age) / COLLECT_FADE));  // shrink away in its final seconds
      const dx = p.pos.x - player.pos.x, dz = p.pos.z - player.pos.z;
      if (dx * dx + dz * dz < 1.3 * 1.3) {
        player.heal(15);
        g.audio.pickup();
        g.ui.toast('Kugel!  +15 vitality', 1.4);
        g.scene.remove(p.group); this.pickups.splice(i, 1);
      }
    }

    // ---- thrown sefarim (anti-perch projectiles)
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      pr.vy -= pr.g * dt;
      pr.x += pr.vx * dt; pr.y += pr.vy * dt; pr.z += pr.vz * dt;
      pr.life -= dt;
      pr.group.position.set(pr.x, pr.y, pr.z);
      pr.group.rotation.x += pr.spin * dt; pr.group.rotation.z += pr.spin * 0.6 * dt;
      // hit the player? (aim at torso height above their current footing)
      const px = player.pos.x, pz = player.pos.z, py = player.yOff + 1.1;
      const dx = pr.x - px, dy = pr.y - py, dz = pr.z - pz;
      if (dx * dx + dy * dy + dz * dz < 0.6 * 0.6) {
        player.takeDamage(pr.dmg, { x: pr.x, z: pr.z });
        g.audio.hit(false, 1.25);
        this._disposeProjectile(pr); this.projectiles.splice(i, 1); continue;
      }
      if (pr.y < 0.06 || pr.life <= 0) { this._disposeProjectile(pr); this.projectiles.splice(i, 1); }
    }

    // ---- shekels: boss-drop collectables (pickup) + tossed lures (lure)
    for (let i = this.shekels.length - 1; i >= 0; i--) {
      const s = this.shekels[i];

      // boss-drop coins the player is meant to pocket carry a grabbable lifetime. Like the
      // kugel it only advances while the director ticks, so a cut-scene freezes it and it
      // resumes on return. (Tossed lures are exempt — they expire via LURE_LIFETIME below.)
      if (s.mode === 'pickup') {
        s.age += dt;
        if (s.age >= COLLECT_TTL) { this._disposeShekel(s); this.shekels.splice(i, 1); continue; }
        s.group.scale.setScalar(Math.min(1, (COLLECT_TTL - s.age) / COLLECT_FADE));  // shrink away in its final seconds
      }

      if (!s.settled) {
        // ballistic flight + tumble
        s.vy -= SHEKEL_GRAV * dt;
        s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
        this._bounceShekelWalls(s, colliders);
        s.group.rotation.x += s.spin * s.tumbleX * dt;
        s.group.rotation.z += s.spin * s.tumbleZ * dt;
        // floor contact → bounce and shed energy; settle once it's barely moving
        if (s.y <= SHEKEL_FLOOR && s.vy <= 0) {
          s.y = SHEKEL_FLOOR;
          s.grounded = true; s.grabbable = true;   // it's on the deck now — a bochur can snatch it
          const impact = -s.vy;
          // keep most of the horizontal on each skip so a hard throw carries down the hall
          s.vy = impact * SHEKEL_BOUNCE; s.vx *= 0.82; s.vz *= 0.82;
          if (impact > 0.4) this.game.audio.coinBounce(Math.min(1, impact / 5));
          if (s.vy < 1.0 && Math.hypot(s.vx, s.vz) < 0.9) { s.settled = true; s.vy = 0; s.vx = 0; s.vz = 0; s.settleT = 0; }
        }
        s.group.position.set(s.x, s.y, s.z);
      } else {
        // settled: the coin rights itself onto its edge (stood up 90° from flat — reads far
        // better in-game than lying face-down) and turns slowly so the struck face shows
        s.settleT += dt;
        const k = Math.min(1, dt * 8);
        s.group.rotation.x += (0 - s.group.rotation.x) * k;   // shed the tumble → upright on its rim
        s.group.rotation.z += (0 - s.group.rotation.z) * k;
        s.group.rotation.y += dt * (s.mode === 'pickup' ? 1.4 : 0.8);
        // rise onto the rim over the first ~0.3s so it stands; a collectable then bobs gently
        const rise = Math.min(1, s.settleT / 0.3), re = rise * rise * (3 - 2 * rise);
        let standY = SHEKEL_FLOOR + (SHEKEL_STAND_Y - SHEKEL_FLOOR) * re;
        if (s.mode === 'pickup') standY += Math.sin((time + s.bob) * 2.2) * 0.05;
        s.group.position.set(s.x, standY, s.z);
      }

      // pickup: the player pockets a resting coin by walking over it (no-op when already full)
      if (s.mode === 'pickup' && s.settled) {
        const dx = s.x - player.pos.x, dz = s.z - player.pos.z;
        if (dx * dx + dz * dz < SHEKEL_PICKUP_R * SHEKEL_PICKUP_R && player.shekels < player.maxShekels && player.addShekel()) {
          g.audio.coinGet();
          g.floaty3d({ x: s.x, z: s.z }, '₪ SHEKEL', { color: '#ffe27a', crit: true, size: 22 });
          if (!g._taughtShekel) { g._taughtShekel = true; g.ui.toast('Shekel pocketed! Press Q to toss it — the whole room chases the coin.', 3.6); }
          this._disposeShekel(s); this.shekels.splice(i, 1); continue;
        }
      }

      // lure: the first bochur to reach a grounded coin snatches it → the room snaps back onto the player
      if (s.mode === 'lure' && s.grabbable && this.roomState === 'combat') {
        let taker = null, best = Infinity;
        for (const e of this.enemies) {
          if (e.dead || e.state === 'downed') continue;
          const dx = e.pos.x - s.x, dz = e.pos.z - s.z, d2 = dx * dx + dz * dz, r = e.radius + 0.45;
          if (d2 < r * r && d2 < best) { best = d2; taker = e; }
        }
        if (taker) {
          g.audio.coinNab();
          g.floaty3d({ x: s.x, z: s.z }, 'GRABBED!', { color: '#f4d878', size: 18 });
          this._disposeShekel(s); this.shekels.splice(i, 1); continue;
        }
      }

      // lure lifetime: a coin nobody grabbed fades out so it doesn't litter the halls
      if (s.mode === 'lure' && s.settled) {
        if (s.settleT > LURE_LIFETIME) { this._disposeShekel(s); this.shekels.splice(i, 1); continue; }
        if (s.settleT > LURE_LIFETIME - 1) s.group.scale.setScalar(Math.max(0, LURE_LIFETIME - s.settleT));
      }
    }

    // ---- falling sefarim: books knocked off shelves the player slammed into tumble down,
    // thumping the player if they land on them (physics + hit test live in the controller)
    for (const c of this.cells) { const bs = c.bookshelves; if (bs) for (const sh of bs) sh.update(dt, player, g.audio); }

    // objective auto-hide
    if (this.objTimer > 0) { this.objTimer -= dt; if (this.objTimer <= 0 && this.roomState !== 'combat') g.ui.hideObjective(); }

    // keep the visible point-light count constant (runs after any room generated or
    // disposed this tick, so the upcoming render never sees a changed light count)
    this._applyLightBudget();
    // slide the fixed spotlight pool onto the nearest rooms (constant spot count -> no recompile)
    this._applySpotBudget(time);
  }

  // Signed penetration of `pos` past a room's entrance wall, along the inward normal
  // (-entryDir): 0 at the interior wall face, positive once inside the room.
  _entryDepth(room, pos) {
    const c = room.cell;
    return (pos.x - c.entryPoint.x) * -c.entryDir.x + (pos.z - c.entryPoint.z) * -c.entryDir.z;
  }

  _roomAt(pos) {
    // Newest un-triggered room the player has just stepped into. Keyed off how far
    // they've crossed the *entrance wall* — not an inset rect — so hugging the entry
    // wall into a corner still trips combat the moment you're through the doorway.
    // (The old test inset every wall by 1.2u, leaving a lip you could sidle along.)
    for (let i = this.rooms.length - 1; i >= 0; i--) {
      const room = this.rooms[i];
      if (room._triggered) continue;
      const c = room.cell;
      // stay within the room's footprint (a slack margin) so we don't match on the
      // entrance plane extended out past the walls
      if (pos.x < c.minX - 0.1 || pos.x > c.maxX + 0.1 || pos.z < c.minZ - 0.1 || pos.z > c.maxZ + 0.1) continue;
      if (this._entryDepth(room, pos) > ROOM_ENTER_DEPTH) return room;
    }
    return null;
  }
}
