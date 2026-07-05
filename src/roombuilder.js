// Turns map cells (from mapgen) into three.js geometry + colliders + lights + gates.
import * as THREE from 'three';
import { MAT } from './assets.js';
import * as Props from './props.js';
import { pointBlocked } from './collide.js';
import { WALL_H, WALL_T } from './mapgen.js';

const TILE = 3.6;   // world units per texture tile (horizontal)
const VT = 3.4;     // world units per texture tile (vertical)

function box(w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true; m.receiveShadow = true; return m;
}
function scaleUV(geo, sx, sy) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy);
  uv.needsUpdate = true;
}
// Floor/ceiling plane. Tiling is baked entirely into these per-cell UVs so the shared
// surface texture (see surf) can keep a constant repeat of 1. The OLD code tiled these
// TWICE — once via scaleUV here and again via a per-cell texture.repeat of the same
// (size/TILE) factor — so the effective tiling was (size/TILE)². We fold that whole factor
// into the UVs here, which reproduces the exact look while letting every cell share one
// texture. (Walls only ever tiled once, so addWall's scaleUV is unchanged.)
function planeXZ(w, d, mat, up = true) {
  const g = new THREE.PlaneGeometry(w, d);
  scaleUV(g, (w / TILE) * (w / TILE), (d / TILE) * (d / TILE));
  const m = new THREE.Mesh(g, mat);
  m.rotation.x = up ? -Math.PI / 2 : Math.PI / 2;
  m.receiveShadow = true;
  return m;
}

// ---- Gate: a portcullis-style door that raises into the ceiling -------------
class Gate {
  constructor(mesh, aabb) {
    this.mesh = mesh; this.aabb = aabb;
    this.closedY = mesh.position.y;
    this.openY = this.closedY + WALL_H + 1.4;
    this.target = this.closedY;
    this.solid = true;
  }
  open() { this.target = this.openY; }
  close() { this.target = this.closedY; }
  openInstant() { this.mesh.position.y = this.openY; this.target = this.openY; this.solid = false; this.mesh.visible = false; }
  update(dt) {
    const y = this.mesh.position.y;
    const ny = y + (this.target - y) * Math.min(1, dt * 3.0);
    this.mesh.position.y = ny;
    this.mesh.visible = ny < this.openY - 0.15;
    this.solid = ny < this.closedY + WALL_H * 0.5;
  }
}

function makeGateMesh(side, gapCoord, gapW, fixedCoord) {
  const g = new THREE.Group();
  const H = WALL_H;
  const plankMat = MAT.woodDark, bandMat = MAT.iron;
  const vertical = (side === 'N' || side === 'S'); // gap runs along X
  const width = gapW + 0.2;
  // planks
  const nPlanks = 5;
  for (let i = 0; i < nPlanks; i++) {
    const t = (i / (nPlanks - 1) - 0.5) * width;
    const plank = box(vertical ? width / nPlanks - 0.02 : 0.34, H, vertical ? 0.34 : width / nPlanks - 0.02, plankMat);
    if (vertical) plank.position.set(t, 0, 0); else plank.position.set(0, 0, t);
    g.add(plank);
  }
  // iron bands
  for (const yy of [H * 0.25, H * 0.75]) {
    const band = box(vertical ? width : 0.42, 0.18, vertical ? 0.42 : width, bandMat);
    band.position.y = yy - H / 2; g.add(band);
  }
  // studs
  for (let i = -2; i <= 2; i++) {
    for (const yy of [H * 0.25, H * 0.75]) {
      const s = box(0.08, 0.08, 0.08, MAT.brassDark);
      const t = i * width / 6;
      if (vertical) s.position.set(t, yy - H / 2, 0.22); else s.position.set(0.22, yy - H / 2, t);
      g.add(s);
    }
  }
  // position at the gap
  if (vertical) g.position.set(gapCoord, H / 2, fixedCoord);
  else g.position.set(fixedCoord, H / 2, gapCoord);

  const aabb = vertical
    ? { minX: gapCoord - width / 2, maxX: gapCoord + width / 2, minZ: fixedCoord - 0.25, maxZ: fixedCoord + 0.25, top: WALL_H }
    : { minX: fixedCoord - 0.25, maxX: fixedCoord + 0.25, minZ: gapCoord - width / 2, maxZ: gapCoord + width / 2, top: WALL_H };
  return { mesh: g, aabb };
}

// side letter from a world direction {x,z}
function sideOf(dir) {
  if (dir.x === 1) return 'E';
  if (dir.x === -1) return 'W';
  if (dir.z === 1) return 'S';
  return 'N';
}

function makeInstance(cell) {
  return {
    cell, group: new THREE.Group(),
    staticColliders: [], gates: [], lights: [], flames: [], glows: [], windows: [], bookshelves: [], seats: [],
    _mats: [], _geos: [],
    center: cell.center || { x: (cell.minX + cell.maxX) / 2, z: (cell.minZ + cell.maxZ) / 2 },
    floorY: 0,
    getColliders() {
      const out = this.staticColliders.slice();
      for (const g of this.gates) if (g.solid) out.push(g.aabb);
      return out;
    },
    update(dt, time) {
      for (const L of this.lights) {
        const f = 0.82 + 0.18 * Math.sin(time * L.speed + L.phase) + 0.06 * Math.sin(time * L.speed * 2.7 + L.phase);
        L.light.intensity = L.base * f;
      }
      for (const fl of this.flames) fl.scale.y = 0.85 + 0.3 * Math.sin(time * 11 + fl.position.x * 3);
      for (const g of this.gates) g.update(dt);
      for (const w of this.windows) w.update(dt);
    },
    dispose(scene) {
      for (const w of this.windows) w.dispose();
      scene.remove(this.group);
      this.group.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
      for (const m of this._mats) { if (m.map) m.map.dispose(); m.dispose(); }
    },
  };
}

// Shared surface material per base (floor / ceiling / wall). The old surf() cloned the
// material AND its texture per cell and forced a fresh GPU upload (needsUpdate), then
// disposed it on teardown — churning ~1 MB of texture uploads for every room streamed in and
// out (a chunk of the room first-draw stall). Now ONE material+texture is built per base and
// reused by every cell: all tiling lives in the per-cell geometry UVs (see planeXZ /
// addWall), so a constant texture.repeat of 1 serves every size. Shared → never pushed to
// inst._mats and never disposed (bounded, like the MAT.* palette). `offset` returns a
// distinct variant carrying polygonOffset for the corridor walls, whose jamb overlaps the
// room's and would otherwise z-fight.
// Shared surface material per base (floor / ceiling / wall). The old surf() cloned the
// material AND its texture per cell and forced a fresh GPU upload (needsUpdate), then
// disposed it on teardown — churning ~1 MB of texture uploads for every room streamed in and
// out (a chunk of the room first-draw stall). Now ONE material+texture is built per base and
// reused by every cell: all tiling lives in the per-cell geometry UVs (see planeXZ /
// addWall), so a constant texture.repeat of 1 serves every size. Shared → never pushed to
// inst._mats and never disposed (bounded, like the MAT.* palette). `offset` returns a
// distinct variant carrying polygonOffset for the corridor walls, whose jamb overlaps the
// room's and would otherwise z-fight.
const _surfCache = new Map();
function surf(baseMat, offset = false) {
  let entry = _surfCache.get(baseMat);
  if (!entry) { entry = {}; _surfCache.set(baseMat, entry); }
  const k = offset ? 'off' : 'plain';
  if (!entry[k]) {
    const m = baseMat.clone();
    if (baseMat.map) {
      m.map = baseMat.map.clone();
      m.map.wrapS = m.map.wrapT = THREE.RepeatWrapping;
      m.map.repeat.set(1, 1);
      m.map.needsUpdate = true;
    }
    if (offset) { m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1; }
    entry[k] = m;
  }
  return entry[k];
}

function addWall(inst, wallMat, rect, side, gap, gapW) {
  const { minX, maxX, minZ, maxZ } = rect;
  const H = WALL_H, T = WALL_T;
  const alongZ = (side === 'W' || side === 'E');
  let fixed, a, b;
  if (side === 'W') { fixed = minX; a = minZ - T; b = maxZ + T; }
  else if (side === 'E') { fixed = maxX; a = minZ - T; b = maxZ + T; }
  else if (side === 'N') { fixed = minZ; a = minX; b = maxX; }
  else { fixed = maxZ; a = minX; b = maxX; }

  const segs = [];
  if (gap == null) segs.push([a, b]);
  else {
    const g0 = gap - gapW / 2, g1 = gap + gapW / 2;
    if (g0 > a + 0.05) segs.push([a, g0]);
    if (g1 < b - 0.05) segs.push([g1, b]);
    // lintel above the doorway
    const lg = new THREE.BoxGeometry(alongZ ? T : gapW, H - 3.4, alongZ ? gapW : T);
    const lint = new THREE.Mesh(lg, wallMat); lint.receiveShadow = true;
    if (alongZ) lint.position.set(side === 'W' ? fixed - T / 2 : fixed + T / 2, H - (H - 3.4) / 2, gap);
    else lint.position.set(gap, H - (H - 3.4) / 2, side === 'N' ? fixed - T / 2 : fixed + T / 2);
    inst.group.add(lint);
  }
  for (const [s0, s1] of segs) {
    const len = s1 - s0, mid = (s0 + s1) / 2;
    let g, mesh, aabb;
    if (alongZ) {
      g = new THREE.BoxGeometry(T, H, len); scaleUV(g, len / TILE, H / VT);
      mesh = new THREE.Mesh(g, wallMat); mesh.receiveShadow = true;
      const cx = side === 'W' ? fixed - T / 2 : fixed + T / 2;
      mesh.position.set(cx, H / 2, mid);
      aabb = { minX: cx - T / 2, maxX: cx + T / 2, minZ: s0, maxZ: s1, top: H };
    } else {
      g = new THREE.BoxGeometry(len, H, T); scaleUV(g, len / TILE, H / VT);
      mesh = new THREE.Mesh(g, wallMat); mesh.receiveShadow = true;
      const cz = side === 'N' ? fixed - T / 2 : fixed + T / 2;
      mesh.position.set(mid, H / 2, cz);
      aabb = { minX: s0, maxX: s1, minZ: cz - T / 2, maxZ: cz + T / 2, top: H };
    }
    inst.group.add(mesh); inst.staticColliders.push(aabb);
  }
}

function addPointLight(inst, color, intensity, dist, x, y, z, flicker = true) {
  const L = new THREE.PointLight(color, intensity, dist, 2);
  L.position.set(x, y, z);
  inst.group.add(L);
  inst.lights.push({ light: L, base: intensity, phase: Math.random() * 6.28, speed: flicker ? 6 + Math.random() * 4 : 0 });
  return L;
}

// ============================================================ CORRIDOR
export function buildCorridor(cell, rng, quality) {
  const inst = makeInstance(cell);
  const { minX, maxX, minZ, maxZ } = cell;
  const w = maxX - minX, d = maxZ - minZ;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;

  const floorMat = surf(MAT.floor);
  const floor = planeXZ(w, d, floorMat); floor.position.set(cx, 0, cz); inst.group.add(floor);
  const ceilMat = surf(MAT.ceiling);
  const ceil = planeXZ(w, d, ceilMat, false); ceil.position.set(cx, WALL_H, cz); inst.group.add(ceil);

  // At every doorway the corridor's side walls (extended by WALL_T past the seam)
  // interpenetrate the room's entry/exit jamb — two opaque boxes sharing a coplanar face at
  // identical depth, which z-fights and pops the two wall textures in/out as the camera
  // moves. The `offset` variant biases the corridor walls very slightly deeper so the room's
  // door frame always wins the tie. (Room walls use the plain variant, so only the corridor
  // side is biased — the depth offset is invisible everywhere else.)
  const wallMat = surf(MAT.wallCool, true);
  const dir = cell.dir;
  const alongZ = dir.z !== 0; // corridor runs along Z -> side walls are W/E
  if (alongZ) {
    addWall(inst, wallMat, cell, 'W', null);
    addWall(inst, wallMat, cell, 'E', null);
    // seal the dead-end behind the player's start
    if (cell.spawn) addWall(inst, wallMat, cell, dir.z < 0 ? 'S' : 'N', null);
  } else {
    addWall(inst, wallMat, cell, 'N', null);
    addWall(inst, wallMat, cell, 'S', null);
    if (cell.spawn) addWall(inst, wallMat, cell, dir.x < 0 ? 'E' : 'W', null);
  }

  // lights + sconces down the hall
  const steps = Math.max(1, Math.round((alongZ ? d : w) / 5));
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) / steps;
    const lx = alongZ ? cx : minX + w * t;
    const lz = alongZ ? minZ + d * t : cz;
    addPointLight(inst, 0xffca80, 9, 12, lx, WALL_H - 0.7, lz);
    // wall sconce visuals on both walls
    for (const s of [-1, 1]) {
      const sc = Props.sconce();
      if (alongZ) { sc.position.set(cx + s * (w / 2 - 0.15), 2.4, lz); sc.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2; }
      else { sc.position.set(lx, 2.4, cz + s * (d / 2 - 0.15)); sc.rotation.y = s > 0 ? Math.PI : 0; }
      inst.group.add(sc); inst.flames.push(...(sc.userData.flames || []));
    }
  }
  // occasional bookshelf or banner
  if (rng.chance(0.6)) {
    const bs = Props.bookshelf(2, 3.2);
    if (alongZ) { bs.position.set(minX + 0.26, 0, cz + rng.spread(d / 2 - 2)); bs.rotation.y = Math.PI / 2; }
    else { bs.position.set(cx + rng.spread(w / 2 - 2), 0, minZ + 0.26); bs.rotation.y = 0; }
    inst.group.add(bs);
    registerShelf(inst, bs);   // track the shelf so a slam can spill its sefarim
  }
  return inst;
}

// Register a placed bookshelf's controller so its falling-book mechanic can be driven
// (the director ticks it against the player each frame). refreshWorld() must run after the
// group has been positioned + rotated so its world transform/footprint are correct.
function registerShelf(inst, bs) {
  const sh = bs.userData.shelf;
  if (!sh) return;
  sh.refreshWorld();
  inst.bookshelves.push(sh);
}

// ============================================================ ROOM
// `reserve` (optional): a list of {x,z,hx,hz,top?} zones to claim BEFORE decorating
// and BEFORE the spawn grid is sampled. Used by the title/intro backdrop to stake out
// its hand-placed set-piece (ark, bimah, candelabra) and fixed cast so procedural
// furniture and the crowd both keep clear of them. Gameplay rooms pass nothing.
export function buildRoom(cell, rng, quality, reserve = [], opts = {}) {
  const inst = makeInstance(cell);
  const { minX, maxX, minZ, maxZ } = cell;
  const w = maxX - minX, d = maxZ - minZ;
  const cx = cell.center.x, cz = cell.center.z;
  const td = cell.themeData;

  // ---- floor + ceiling
  const floorBase = MAT[td.floor] || MAT.floor;
  const floorMat = surf(floorBase);
  const floor = planeXZ(w, d, floorMat); floor.position.set(cx, 0, cz); inst.group.add(floor);
  const ceilMat = surf(MAT.ceiling);
  const ceil = planeXZ(w, d, ceilMat, false); ceil.position.set(cx, WALL_H, cz); inst.group.add(ceil);

  // ---- walls with gaps at entrance/exit
  const wallMat = surf(MAT[td.wall] || MAT.wallWarm);
  const entSide = sideOf(cell.entryDir);
  const exitSide = sideOf(cell.exitDir);
  const gapCoordFor = (side, pt) => (side === 'E' || side === 'W') ? pt.z : pt.x;
  const gaps = {};
  gaps[entSide] = { coord: gapCoordFor(entSide, cell.entryPoint), which: 'entrance' };
  gaps[exitSide] = { coord: gapCoordFor(exitSide, cell.exitPoint), which: 'exit' };

  for (const side of ['N', 'S', 'E', 'W']) {
    const g = gaps[side];
    addWall(inst, wallMat, cell, side, g ? g.coord : null, cell.gapW);
  }

  // ---- gates
  const fixedFor = (side) => side === 'W' ? minX : side === 'E' ? maxX : side === 'N' ? minZ : maxZ;
  const entGate = makeGateMesh(entSide, gaps[entSide].coord, cell.gapW, fixedFor(entSide));
  inst.group.add(entGate.mesh);
  inst.entranceGate = new Gate(entGate.mesh, entGate.aabb);
  inst.entranceGate.openInstant(); // open so the player can walk in

  const exGate = makeGateMesh(exitSide, gaps[exitSide].coord, cell.gapW, fixedFor(exitSide));
  inst.group.add(exGate.mesh);
  inst.exitGate = new Gate(exGate.mesh, exGate.aabb); // starts closed
  inst.gates.push(inst.entranceGate, inst.exitGate);

  // ---- lighting
  const nChand = cell.boss ? 3 : (w * d > 260 ? 2 : 1);
  const chandXs = nChand === 1 ? [cx] : nChand === 2 ? [cx - w / 4, cx + w / 4] : [cx - w / 4, cx, cx + w / 4];
  for (const lx of chandXs) {
    const ch = Props.chandelier(cell.boss ? 8 : 6, cell.boss ? 1.0 : 0.8);
    ch.position.set(lx, WALL_H - 1.1, cz);
    inst.group.add(ch); inst.flames.push(...ch.userData.flames);
    addPointLight(inst, td.light, cell.boss ? 16 : 12, Math.max(w, d) * 0.9, lx, WALL_H - 1.4, cz);
  }
  // primary shadow-casting spot from the ceiling. Streamed gameplay rooms pass `noSpot`: the
  // director lights them with a fixed-size spotlight pool instead (see Director._applySpotBudget),
  // so the scene's spotlight COUNT never changes as halls stream and shaders never recompile.
  // The title/cut-scene backdrops keep their own spot (single static scenes, no streaming).
  if (quality.shadows && !opts.noSpot) {
    const spot = new THREE.SpotLight(td.light, 40, Math.max(w, d) * 1.4, Math.PI / 3.1, 0.5, 1.6);
    spot.position.set(cx, WALL_H - 0.4, cz);
    spot.target.position.set(cx, 0, cz);
    spot.castShadow = true;
    spot.shadow.mapSize.set(quality.shadowSize, quality.shadowSize);
    spot.shadow.camera.near = 1; spot.shadow.camera.far = Math.max(w, d) * 1.5; spot.shadow.bias = -0.0006;
    inst.group.add(spot); inst.group.add(spot.target);
    inst.lights.push({ light: spot, base: 40, phase: Math.random() * 6.28, speed: 5 });
  }

  // ---- decoration (innerBounds must exist first — freeSpot() reads it)
  inst.innerBounds = { minX: minX + 1.0, maxX: maxX - 1.0, minZ: minZ + 1.0, maxZ: maxZ - 1.0 };
  inst._footprints = [];
  // Stake out caller-reserved zones first: a footprint (so procedural furniture avoids
  // them) AND a collider (so the spawn-point grid below never lands inside them).
  for (const r of reserve) {
    inst._footprints.push({ x: r.x, z: r.z, hx: r.hx, hz: r.hz });
    inst.staticColliders.push({ minX: r.x - r.hx, maxX: r.x + r.hx, minZ: r.z - r.hz, maxZ: r.z + r.hz, top: r.top != null ? r.top : WALL_H });
  }
  decorate(inst, cell, rng);

  // ---- spawn helpers
  // Precompute a grid of guaranteed-clear standing spots. Every furniture footprint
  // (tables, benches, bimah, aron, pillars…) is already a collider by now, so any
  // point that clears them by `pad` is safe to spawn on — no more bochurim wedged
  // inside a table. Sampled once here; randomSpawn just draws from the list.
  inst.spawnPoints = [];
  {
    const ib = inst.innerBounds, cols = inst.getColliders(), pad = 0.6, step = 1.0;
    for (let x = ib.minX + 0.4; x <= ib.maxX - 0.4; x += step) {
      for (let z = ib.minZ + 0.4; z <= ib.maxZ - 0.4; z += step) {
        if (nearGap(cell, x, z, 2.2)) continue;           // keep the doorways clear
        if (!pointBlocked(x, z, pad, cols)) inst.spawnPoints.push({ x, z });
      }
    }
  }

  // `taken`/`selfDist`: pass an accumulating list of already-used points (and a min
  // separation) to keep successive static spawns — e.g. the title crowd — from
  // stacking on the same grid point. Gameplay enemies drift apart on their own, so
  // the director omits these.
  inst.randomSpawn = function (rng2, avoid, minDist, taken, selfDist) {
    const pts = this.spawnPoints;
    const sd2 = (selfDist || 0) * (selfDist || 0);
    const clearOfTaken = (p) => {
      if (!taken || !taken.length || sd2 <= 0) return true;
      for (const t of taken) { const dx = p.x - t.x, dz = p.z - t.z; if (dx * dx + dz * dz < sd2) return false; }
      return true;
    };
    if (pts && pts.length) {
      const md2 = (minDist || 0) * (minDist || 0);
      for (let i = 0; i < 60; i++) {
        const p = pts[rng2.int(0, pts.length - 1)];
        if (avoid) { const dx = p.x - avoid.x, dz = p.z - avoid.z; if (dx * dx + dz * dz < md2) continue; }
        if (!clearOfTaken(p)) continue;
        return { x: p.x, z: p.z };
      }
      // dense room / everything too close to the player — take the farthest clear spot
      if (avoid) {
        let best = null, bd = -1;
        for (const p of pts) { if (!clearOfTaken(p)) continue; const dx = p.x - avoid.x, dz = p.z - avoid.z, dd = dx * dx + dz * dz; if (dd > bd) { bd = dd; best = p; } }
        if (best) return { x: best.x, z: best.z };
      }
      // last resort: any point still clear of taken, else the first point
      for (const p of pts) if (clearOfTaken(p)) return { x: p.x, z: p.z };
      return { x: pts[0].x, z: pts[0].z };
    }
    // fallback (only if the room somehow has no clear grid point)
    const ib = this.innerBounds, cols = this.getColliders();
    for (let i = 0; i < 50; i++) {
      const x = rng2.range(ib.minX, ib.maxX), z = rng2.range(ib.minZ, ib.maxZ);
      if (avoid) { const dx = x - avoid.x, dz = z - avoid.z; if (dx * dx + dz * dz < minDist * minDist) continue; }
      if (pointBlocked(x, z, 0.7, cols)) continue;
      return { x, z };
    }
    return { x: cx, z: cz };
  };

  // Nearest guaranteed-clear spot to (x,z) — used to nudge the boss out of the bimah
  // if the room center happens to be furnished.
  inst.spawnNear = function (x, z) {
    const pts = this.spawnPoints;
    if (!pts || !pts.length) return { x, z };
    let best = pts[0], bd = Infinity;
    for (const p of pts) { const dx = p.x - x, dz = p.z - z, dd = dx * dx + dz * dz; if (dd < bd) { bd = dd; best = p; } }
    return { x: best.x, z: best.z };
  };
  return inst;
}

// ---- decoration dispatch ----------------------------------------------------
function place(inst, prop, x, z, rotY = 0) {
  prop.position.set(x, 0, z);
  prop.rotation.y = rotY;
  inst.group.add(prop);
  const fp = prop.userData.footprint;
  if (fp) {
    const swap = Math.abs(Math.sin(rotY)) > 0.5;
    const hx = swap ? fp.hz : fp.hx, hz = swap ? fp.hx : fp.hz;
    // benches/tables expose a standHeight the player can jump onto; everything else is a full wall
    const top = prop.userData.standHeight != null ? prop.userData.standHeight : WALL_H;
    inst.staticColliders.push({ minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz, top });
    inst._footprints.push({ x, z, hx, hz });
  }
  // sittable props (benches/chairs) expose local seat anchors — transform each into a
  // world seat the player/NPCs can occupy. A yaw-only prop rotation maps local (lx,lz)
  // to world by the same rotation, and the occupant's facing yaw is rotY + the seat's.
  const seats = prop.userData.seats;
  if (seats) {
    const cos = Math.cos(rotY), sin = Math.sin(rotY);
    for (const s of seats) {
      inst.seats.push({
        x: x + s.x * cos + s.z * sin,
        y: s.y,
        z: z - s.x * sin + s.z * cos,
        ry: rotY + (s.ry || 0),
        occupant: null,
      });
    }
  }
  // collect flame meshes from this prop and any nested sub-props
  prop.traverse((o) => { if (o.userData && o.userData.flames) inst.flames.push(...o.userData.flames); });
  return prop;
}

// Does an (hx,hz) box at (x,z) collide with anything already placed? Every solid
// prop — tables, benches, pillars, AND the perimeter shelves/windows — registers a
// footprint, so this is the single source of truth for "is this spot taken". Pass
// `upto` to test against only the first N footprints (used to ignore a prop's own
// just-registered footprint when placing its attached benches).
function overlaps(inst, x, z, hx, hz, pad = 0.6, upto = -1) {
  const fps = inst._footprints;
  const n = upto < 0 ? fps.length : upto;
  for (let i = 0; i < n; i++) {
    const f = fps[i];
    if (Math.abs(x - f.x) < hx + f.hx + pad && Math.abs(z - f.z) < hz + f.hz + pad) return true;
  }
  return false;
}
function nearGap(cell, x, z, r = 3.4) {
  const a = cell.entryPoint, b = cell.exitPoint;
  return (Math.hypot(x - a.x, z - a.z) < r) || (Math.hypot(x - b.x, z - b.z) < r);
}
// The whole (hx,hz) footprint must sit inside `ib` — keeps furniture from poking
// through the walls.
function fitsBounds(ib, x, z, hx, hz) {
  return x - hx >= ib.minX && x + hx <= ib.maxX && z - hz >= ib.minZ && z + hz <= ib.maxZ;
}
// A clear, in-bounds spot for an object of half-extents (hx,hz): the sampled center
// is inset by (hx,hz) so the object always fits within the inner bounds, and it must
// clear every footprint placed so far (perimeter shelves/windows included).
function freeSpot(inst, cell, rng, hx, hz, pad = 0.6) {
  const ib = inst.innerBounds;
  if (ib.maxX - ib.minX < 2 * hx || ib.maxZ - ib.minZ < 2 * hz) return null; // too big for the room
  for (let i = 0; i < 40; i++) {
    const x = rng.range(ib.minX + hx, ib.maxX - hx), z = rng.range(ib.minZ + hz, ib.maxZ - hz);
    if (nearGap(cell, x, z)) continue;
    if (overlaps(inst, x, z, hx, hz, pad)) continue;
    return { x, z };
  }
  return null;
}

// Register a wall-hugging prop's footprint (and optionally a collider) in the
// room's occupancy so later furniture keeps clear of it. `halfLen` is its half-span
// along the wall, `depthHalf` how far it reaches into the room, `off` its center's
// offset from the wall face.
function registerWallProp(inst, s, c, halfLen, depthHalf, off, solid) {
  let x, z, hx, hz;
  if (s.along === 'z') { x = s.fixed + (s.side === 'W' ? off : -off); z = c; hx = depthHalf; hz = halfLen; }
  else { x = c; z = s.fixed + (s.side === 'N' ? off : -off); hx = halfLen; hz = depthHalf; }
  inst._footprints.push({ x, z, hx, hz });
  if (solid) inst.staticColliders.push({ minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz, top: WALL_H });
}

function perimeterShelves(inst, cell, rng) {
  const { minX, maxX, minZ, maxZ } = cell;
  const sides = [
    { side: 'W', fixed: minX, a: minZ, b: maxZ, along: 'z' },
    { side: 'E', fixed: maxX, a: minZ, b: maxZ, along: 'z' },
    { side: 'N', fixed: minZ, a: minX, b: maxX, along: 'x' },
    { side: 'S', fixed: maxZ, a: minX, b: maxX, along: 'x' },
  ];
  const entSide = sideOf(cell.entryDir), exitSide = sideOf(cell.exitDir);
  const sw = 2.2;
  for (const s of sides) {
    const gapCoord = (s.side === entSide) ? ((s.along === 'z') ? cell.entryPoint.z : cell.entryPoint.x)
      : (s.side === exitSide) ? ((s.along === 'z') ? cell.exitPoint.z : cell.exitPoint.x) : null;
    // Stride is wider than a shelf so bare wall shows between pieces (less clutter).
    // Stop while the shelf's far end (p+sw) still clears the far corner, so a shelf
    // never pokes through the perpendicular wall.
    for (let p = s.a + 1.4; p + sw <= s.b - 1.4; p += sw + 0.8) {
      const c = p + sw / 2;
      if (gapCoord != null && Math.abs(c - gapCoord) < cell.gapW / 2 + 1.4) continue;
      if (!rng.chance(0.6)) continue;   // leave gaps — not a solid wall of furniture
      if (rng.chance(0.25) && !cell.boss) {
        // a window instead of a shelf, sometimes. The whole shadow-box stands off
        // the wall (WINDOW_WELL + a hair) so the box clears the solid wall face.
        const win = Props.windowArch(1.4, 2.4, cell.theme === 'crypt' ? 0x3a4a6a : 0xffcf82);
        const off = Props.WINDOW_WELL + 0.02;
        let lx, lz;
        if (s.along === 'z') { const o = s.side === 'W' ? off : -off; win.position.set(s.fixed + o, 0, c); win.rotation.y = s.side === 'W' ? Math.PI / 2 : -Math.PI / 2; lx = s.fixed + o; lz = c; }
        else { const o = s.side === 'N' ? off : -off; win.position.set(c, 0, s.fixed + o); win.rotation.y = s.side === 'N' ? 0 : Math.PI; lx = c; lz = s.fixed + o; }
        inst.group.add(win);
        // register the breakable pane (now that it's positioned) so a punch can find it
        const bw = win.userData.breakable;
        if (bw) { bw.refreshWorld(); inst.windows.push(bw); }
        if (win.userData.glow !== undefined) addPointLight(inst, win.userData.glow, 3, 6, lx, 1.4, lz, false);
        // shallow footprint keeps furniture off the window well (the wall itself blocks)
        registerWallProp(inst, s, c, 0.7, 0.25, off, false);
        continue;
      }
      const bs = Props.bookshelf(sw, 3.4);
      if (s.along === 'z') { bs.position.set(s.fixed + (s.side === 'W' ? 0.26 : -0.26), 0, c); bs.rotation.y = s.side === 'W' ? Math.PI / 2 : -Math.PI / 2; }
      else { bs.position.set(c, 0, s.fixed + (s.side === 'N' ? 0.26 : -0.26)); bs.rotation.y = s.side === 'N' ? 0 : Math.PI; }
      inst.group.add(bs);
      registerShelf(inst, bs);   // track the shelf so a slam can spill its sefarim
      // full-width collider + footprint (the old 0.3×0.3 stub let props clip the shelf ends)
      registerWallProp(inst, s, c, sw / 2, 0.3, 0.26, true);
    }
  }
}

function decorate(inst, cell, rng) {
  const theme = cell.theme;
  if (theme !== 'shul') perimeterShelves(inst, cell, rng);

  if (theme === 'shul') {
    // Aron Kodesh against the wall opposite the entrance
    const back = { x: cell.center.x - cell.entryDir.x * (cell.size.dep / 2 - 0.6),
                   z: cell.center.z - cell.entryDir.z * (cell.size.dep / 2 - 0.6) };
    // face inward (toward entry)
    const faceRot = Math.atan2(cell.entryDir.x, cell.entryDir.z);
    const aron = Props.aronKodesh();
    place(inst, aron, back.x, back.z, faceRot);
    if (aron.userData.nerTamid) {
      addPointLight(inst, 0xff5a2a, 5, 8, aron.position.x + cell.entryDir.x * 0.6, WALL_H - 1.5, aron.position.z + cell.entryDir.z * 0.6, true);
    }
    // rows of benches in front of the bimah, facing the aron. Placed on the entrance
    // side (entryDir points back toward the doorway) starting clear of the 1.1-half
    // bimah platform, and never so close to the entrance wall that they block the gate.
    const perp = { x: -cell.entryDir.z, z: cell.entryDir.x };
    // benches run ALONG the width (perp) and are spaced front-to-back; the bench's
    // long axis is local +x, so orient local +x onto perp (not perp onto local +z,
    // which would lay each row along the spacing axis and stack them on each other).
    const benchRot = Math.atan2(-perp.z, perp.x);
    const frontLimit = cell.size.dep / 2 - 3.4;   // keep the doorway clear
    for (let r = 0; r < 3; r++) {
      const off = 2.6 + r * 2.4;
      if (off > frontLimit) break;
      const bench = Props.bench(Math.min(cell.size.wid - 3, 8));
      place(inst, bench, cell.center.x + cell.entryDir.x * off, cell.center.z + cell.entryDir.z * off, benchRot);
    }
    // central bimah (shtender on a low platform)
    const plat = box(2.2, 0.3, 2.2, MAT.woodMid); plat.position.set(cell.center.x, 0.15, cell.center.z); inst.group.add(plat);
    inst.staticColliders.push({ minX: cell.center.x - 1.1, maxX: cell.center.x + 1.1, minZ: cell.center.z - 1.1, maxZ: cell.center.z + 1.1, top: 0.3 });
    place(inst, Props.shtender(), cell.center.x, cell.center.z + 0.2, faceRot);
    return;
  }

  if (theme === 'cellar' || theme === 'crypt') {
    // pillars in a grid + a few tables, sparse & ominous
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const px = cell.center.x + sx * (cell.size.wid ? Math.min(cell.size.wid, cell.maxX - cell.minX) / 4 : 4) * 0.7;
      const pz = cell.center.z + sz * (cell.maxZ - cell.minZ) / 4 * 0.7;
      if (nearGap(cell, px, pz, 2.5)) continue;
      place(inst, Props.pillar(), px, pz);
    }
    const nT = rng.int(1, 2);
    for (let i = 0; i < nT; i++) {
      const len = rng.range(3.5, 5);
      const rot = rng.chance(0.5) ? Math.PI / 2 : 0;
      const hx = rot ? 0.6 : len / 2, hz = rot ? len / 2 : 0.6;
      const spot = freeSpot(inst, cell, rng, hx, hz, 0.7);
      if (spot) { const t = Props.studyTable(len, 1.2); place(inst, t, spot.x, spot.z, rot); }
    }
    return;
  }

  // beis_medrash / library / dining / hall : rows of tables + benches + shtenders
  const isDining = theme === 'dining';
  // fewer tables than before — less clutter, and each is guaranteed a clear footprint
  const area = (cell.maxX - cell.minX) * (cell.maxZ - cell.minZ);
  const nTables = Math.min(4, Math.max(1, Math.floor(area / 80)));
  for (let i = 0; i < nTables; i++) {
    const len = isDining ? rng.range(5, 7) : rng.range(3.5, 5.5);
    const rot = rng.chance(0.5) ? Math.PI / 2 : 0;
    const hx = rot ? 0.65 : len / 2, hz = rot ? len / 2 : 0.65;
    // reserve the flanking-bench margin (benches sit 1.1 out on the short axis, ~1.35 reach)
    const spot = freeSpot(inst, cell, rng, rot ? 1.4 : hx, rot ? hz : 1.4, 0.7);
    if (!spot) continue;
    const table = Props.studyTable(len, isDining ? 1.4 : 1.2);
    const nBefore = inst._footprints.length;   // benches may ignore the parent table's footprint
    place(inst, table, spot.x, spot.z, rot);
    // benches alongside — only where they stay in-bounds and clear of other furniture
    for (const s of [-1, 1]) {
      const bx = spot.x + (rot ? s * 1.1 : 0), bz = spot.z + (rot ? 0 : s * 1.1);
      const bhx = rot ? 0.25 : (len * 0.85) / 2, bhz = rot ? (len * 0.85) / 2 : 0.25;
      if (nearGap(cell, bx, bz)) continue;
      if (!fitsBounds(inst.innerBounds, bx, bz, bhx, bhz)) continue;
      if (overlaps(inst, bx, bz, bhx, bhz, 0.1, nBefore)) continue;
      // A bench's seats face its local +Z. Turn each bench so that front faces back at
      // the table (the +offset side is flipped 180°), so anyone sitting looks at the
      // shulchan rather than out into the room. The bench mesh is symmetric, and this
      // 180°/mirror never changes its axis-aligned footprint (place() keys the swap on
      // |sin rotY|), so colliders are unaffected — only the seat facing flips.
      const benchRot = rot ? (s > 0 ? -Math.PI / 2 : Math.PI / 2) : (s > 0 ? Math.PI : 0);
      place(inst, Props.bench(len * 0.85), bx, bz, benchRot);
    }
    // a shtender near some tables
    if (theme !== 'dining' && rng.chance(0.3)) {
      const sp2 = freeSpot(inst, cell, rng, 0.4, 0.4, 0.5);
      if (sp2) place(inst, Props.shtender(), sp2.x, sp2.z, rng.range(0, 6.28));
    }
  }
  // a single hanging banner high on a side wall, above the shelves so it never clips them
  if (rng.chance(0.35)) {
    const side = rng.sign();
    const bn = Props.banner(1.4, 1.1);
    bn.position.set(cell.center.x + side * ((cell.maxX - cell.minX) / 2 - 0.25), WALL_H - 0.15, cell.center.z);
    bn.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    inst.group.add(bn);
  }
}
