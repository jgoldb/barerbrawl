// Procedural layout: a winding chain of combat rooms joined by corridors.
// Pure geometry/description — no three.js here. The builder turns these into meshes.

export const CORRIDOR_W = 3.6;
export const WALL_H = 4.8;
export const WALL_T = 0.4;

// direction helpers (x,z) on the floor plane
const DIRS = { N: { x: 0, z: -1 }, S: { x: 0, z: 1 }, E: { x: 1, z: 0 }, W: { x: -1, z: 0 } };
function rotCCW(d) { return { x: d.z, z: -d.x }; }
function rotCW(d) { return { x: -d.z, z: d.x }; }
function neg(d) { return { x: -d.x, z: -d.z }; }
function perp(d) { return { x: -d.z, z: d.x }; }

const THEMES = {
  beis_medrash: { floor: 'floor', wall: 'wallWarm', light: 0xffcf82, amb: 0.5, fog: 0x241608, name: 'Beis Medrash' },
  library:      { floor: 'floor', wall: 'wallOld', light: 0xffc06a, amb: 0.38, fog: 0x1c1206, name: 'The Otzar' },
  dining:       { floor: 'floor', wall: 'wallWarm', light: 0xffd89a, amb: 0.6, fog: 0x2a1c0c, name: 'Chadar Ochel' },
  shul:         { floor: 'carpet', wall: 'wallWarm', light: 0xffd27a, amb: 0.55, fog: 0x2a1a0a, name: 'The Great Shul' },
  hall:         { floor: 'floor', wall: 'wallCool', light: 0xf0d0a0, amb: 0.42, fog: 0x1a1810, name: 'Study Hall' },
  cellar:       { floor: 'stone', wall: 'stone', light: 0xd8a860, amb: 0.28, fog: 0x120c08, name: 'The Cellar' },
  crypt:        { floor: 'stone', wall: 'stone', light: 0xc45a3a, amb: 0.22, fog: 0x140604, name: 'The Deep Halls' },
};

export class MapGen {
  constructor(rng) {
    this.rng = rng;
    this.cursor = { x: 0, z: 0 };
    this.dir = DIRS.N;
    this.step = 0;      // sequence counter
    this.roomCount = 0;
  }

  _rectFrom(a, b, half) {
    // rectangle spanning line a->b (axis aligned) widened by `half` on the perpendicular
    const p = perp(this.dir);
    const xs = [a.x + p.x * half, a.x - p.x * half, b.x + p.x * half, b.x - p.x * half];
    const zs = [a.z + p.z * half, a.z - p.z * half, b.z + p.z * half, b.z - p.z * half];
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
  }

  pickTheme(depth) {
    const r = this.rng;
    // Every 3rd room: the Great Shul (boss room)
    if (depth > 0 && depth % 3 === 0) return 'shul';
    if (depth >= 14) return r.weighted([['crypt', 5], ['cellar', 3], ['library', 1]]);
    if (depth >= 9) return r.weighted([['cellar', 3], ['library', 3], ['beis_medrash', 2], ['hall', 2]]);
    if (depth >= 4) return r.weighted([['beis_medrash', 4], ['library', 3], ['dining', 2], ['hall', 2]]);
    return r.weighted([['beis_medrash', 5], ['dining', 3], ['hall', 2]]);
  }

  // The opening hall where the player spawns.
  spawnCorridor() {
    const len = 9;
    const start = { ...this.cursor };
    const end = { x: start.x + this.dir.x * len, z: start.z + this.dir.z * len };
    const rect = this._rectFrom(start, end, CORRIDOR_W / 2);
    this.cursor = end;
    return {
      type: 'corridor', spawn: true, dir: { ...this.dir },
      ...rect, entry: start, exit: end, len, theme: 'beis_medrash',
    };
  }

  makeCorridor() {
    const r = this.rng;
    const len = r.range(6, 11);
    const start = { ...this.cursor };
    const end = { x: start.x + this.dir.x * len, z: start.z + this.dir.z * len };
    const rect = this._rectFrom(start, end, CORRIDOR_W / 2);
    this.cursor = end;
    return { type: 'corridor', dir: { ...this.dir }, ...rect, entry: start, exit: end, len, theme: 'hall' };
  }

  makeRoom() {
    const r = this.rng;
    this.roomCount++;
    const depth = this.roomCount;
    const theme = this.pickTheme(depth);
    const boss = theme === 'shul';

    // size grows with depth: a roomy baseline that ramps up to a larger cap
    const grow = Math.min(depth * 0.6, 12);
    let dep = r.range(15, 20) + grow;
    let wid = r.range(15, 20) + grow;
    if (boss) {
      // boss halls start large and keep scaling up with depth, also capped
      const bossGrow = Math.min(depth * 0.5, 10);
      dep = r.range(20, 25) + bossGrow;
      wid = r.range(21, 26) + bossGrow;
    }

    const D = this.dir, P = perp(D);
    const entrance = { ...this.cursor };
    const center = { x: entrance.x + D.x * dep / 2, z: entrance.z + D.z * dep / 2 };

    // rectangle: center ± D*dep/2 ± P*wid/2
    const cornersX = [center.x + D.x * dep / 2 + P.x * wid / 2, center.x + D.x * dep / 2 - P.x * wid / 2,
                      center.x - D.x * dep / 2 + P.x * wid / 2, center.x - D.x * dep / 2 - P.x * wid / 2];
    const cornersZ = [center.z + D.z * dep / 2 + P.z * wid / 2, center.z + D.z * dep / 2 - P.z * wid / 2,
                      center.z - D.z * dep / 2 + P.z * wid / 2, center.z - D.z * dep / 2 - P.z * wid / 2];
    const rect = {
      minX: Math.min(...cornersX), maxX: Math.max(...cornersX),
      minZ: Math.min(...cornersZ), maxZ: Math.max(...cornersZ),
    };

    // choose exit direction (never straight back toward the entrance). Boss halls
    // (the Great Shul) stand the Aron Kodesh — a full-height ark — centered on the
    // wall opposite the entrance, i.e. straight ahead (D). A straight-ahead exit would
    // then open right behind the ark, walling the player in after the boss falls, so
    // boss rooms only ever exit through a side wall, leaving that back wall for the ark.
    const choices = boss
      ? [{ d: rotCCW(D), w: 1 }, { d: rotCW(D), w: 1 }]
      : [{ d: D, w: 5 }, { d: rotCCW(D), w: 2 }, { d: rotCW(D), w: 2 }];
    const exitDir = r.weighted(choices.map((c) => [c.d, c.w]));

    // exit point = center pushed to the wall along exitDir
    // (dep/2 if the exit is parallel to entry heading, else wid/2)
    const halfExit = (exitDir.x === D.x && exitDir.z === D.z) || (exitDir.x === -D.x && exitDir.z === -D.z) ? dep / 2 : wid / 2;
    const exit = { x: center.x + exitDir.x * halfExit, z: center.z + exitDir.z * halfExit };

    this.cursor = exit;
    this.dir = exitDir;

    return {
      type: 'room', index: depth, depth, theme, boss,
      ...rect, center, size: { dep, wid },
      entryDir: neg(D),                 // wall side facing back toward corridor
      entryPoint: entrance,
      exitDir, exitPoint: exit,
      gapW: CORRIDOR_W,
      themeData: THEMES[theme],
    };
  }
}

export { THEMES };
