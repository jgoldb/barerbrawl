// Orchestrates the run: streams rooms/corridors, ramps difficulty, spawns waves,
// locks gates for combat, drops pickups, drives combat music & objectives.
import * as THREE from 'three';
import { MapGen } from './mapgen.js';
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
    this._litPoints = [];   // scratch array reused by _applyLightBudget
    this.rooms = [];        // room instances in order
    this.enemies = [];
    this.pickups = [];
    this.projectiles = [];  // thrown sefarim in flight (anti-perch)
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
    // pin the light count before the first frame renders (avoids an opening hitch)
    this._applyLightBudget();
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

  _addCell(inst) {
    inst.genIndex = this._genIndex++;
    this.cells.push(inst);
    this.game.scene.add(inst.group);
    return inst;
  }

  _generateRoom() {
    const roomCell = this.mapgen.makeRoom();
    const roomInst = buildRoom(roomCell, this.game.rng, this.game.quality);
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

  // Pre-build the NEXT room during the Barer finisher's frozen close-up and pay its
  // one-time GPU cost up front, while the world is hidden — so the resume frame doesn't
  // hitch. buildRoom itself is only a few ms; the real stall is the first *draw* of the
  // new cell (shader link + texture + vertex-buffer upload), which nothing pays until it
  // renders. So we force that draw here: un-cull the new cells, compile their programs,
  // and render them once to a tiny offscreen target. The cell sits beyond the still-closed
  // exit gate, unseen behind the finisher overlay, and _clearRoom reveals it on resume.
  pregenNextRoom() {
    if (this._pregenRoom) return;                     // already warmed for this finisher
    const roomInst = this._generateRoom();            // builds + adds room + outgoing corridor
    const corrInst = this.cells[this.cells.length - 1];
    this._pregenRoom = roomInst;
    const R = this.game.renderer;
    if (!R) return;                                   // no renderer (headless gen) — warm lazily on resume
    const scene = this.game.scene, cam = this.game.player.camera;
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

  typeWeights(d) {
    if (d < 3) return [['bochur', 7], ['masmid', 3]];
    if (d < 6) return [['bochur', 5], ['masmid', 3], ['gabbai', 1]];
    if (d < 10) return [['bochur', 4], ['masmid', 3], ['gabbai', 3]];
    return [['bochur', 3], ['masmid', 3], ['gabbai', 4]];
  }

  _spawnWave(room, opts = {}) {
    const rng = this.game.rng, d = this.depth;
    const scale = this.diffScale(d);
    const count = opts.count != null ? opts.count : Math.min(3 + Math.floor(d * 0.7), 9);
    const weights = this.typeWeights(d);
    for (let i = 0; i < count; i++) {
      const type = rng.weighted(weights);
      const e = new Enemy(type, scale, rng);
      const sp = room.randomSpawn(rng, this.game.player.pos, 5.5);
      e.setPos(sp.x, sp.z);
      this.game.scene.add(e.root);
      this.enemies.push(e);
    }
    if (opts.boss) {
      const e = new Enemy('mashgiach', scale, rng);
      // center-stage entrance, but snap to a clear spot if the bimah/tables sit there
      const sp = room.spawnNear(room.center.x, room.center.z);
      e.setPos(sp.x, sp.z);
      this.game.scene.add(e.root);
      this.enemies.push(e);
      this.boss = e;
    }
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

  _triggerRoom(room) {
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

    const boss = room.cell.boss;
    // wave plan
    if (boss) {
      this.pendingWaves = 1;
      this._spawnWave(room, { boss: true, count: Math.min(2 + Math.floor(this.depth * 0.25), 5) });
      // every 3rd boss (every 9th hall) the boss brings his lackey, Chaim Barer
      if (this.depth % 9 === 0) this._spawnBarer(room);
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
    this.roomState = 'cleared';
    this.nav = null;
    this.campT = 0;
    for (const pr of this.projectiles) this._disposeProjectile(pr);
    this.projectiles.length = 0;
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
  }

  // called by game when the player lands a kill
  reportKill(info) {
    this.kills++;
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
      this.pickups.push({ group: g, pos: { x: ox, z: oz }, t: this.game.rng.range(0, 6) });
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
    const ctx = {
      player: this.playerCtx, colliders, enemies: this.enemies,
      audio: g.audio, time, camera: player.camera, bounds, nav: this.nav,
      antiPerch, campT: this.campT, perchY: player.yOff,
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
    if (this.roomState === 'combat' && this.activeRoom && this.waveDelay <= 0 && !this._pendingSpawn) {
      if (this.aliveCount() === 0) this._nextWaveOrClear(this.activeRoom);
    }

    // ---- pickups
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      p.t += dt;
      p.group.position.y = 0.5 + Math.sin(p.t * 2.2) * 0.08;
      p.group.rotation.y += dt * 1.4;
      const dx = p.pos.x - player.pos.x, dz = p.pos.z - player.pos.z;
      if (dx * dx + dz * dz < 1.3 * 1.3) {
        player.heal(28);
        g.audio.pickup();
        g.ui.toast('Kugel!  +28 vitality', 1.4);
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

    // objective auto-hide
    if (this.objTimer > 0) { this.objTimer -= dt; if (this.objTimer <= 0 && this.roomState !== 'combat') g.ui.hideObjective(); }

    // keep the visible point-light count constant (runs after any room generated or
    // disposed this tick, so the upcoming render never sees a changed light count)
    this._applyLightBudget();
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
