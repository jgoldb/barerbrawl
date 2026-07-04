// Flow-field pathfinding for the enemy swarm.
//
// A whole crowd chasing one target is the textbook case for a flow field: build a
// grid over the combat room, run a single breadth-first sweep out from the player's
// cell across the walkable cells, and every enemy just reads the pre-computed
// direction stored in the cell it stands on. One BFS per frame serves any number of
// enemies, and because the wave propagates *around* furniture, the directions route
// around tables/benches instead of walking into them.
//
// The distance field is 4-connected (so it can never leak diagonally through the
// corner between two props), while the per-cell direction is chosen from all 8
// neighbours so the resulting motion still reads as smooth diagonal movement.
//
// Two details keep enemies out of the "stuck against furniture even though a way
// around exists" trap:
//   1. A fairly fine grid (0.4u). A coarse grid aliases narrow detours out of
//      existence — the sweep can't "see" the roundabout route, so the flow never
//      guides an enemy along it. 0.4u resolves the gaps real furniture leaves.
//   2. dirAt() never dead-ends. An enemy shoved onto a blocked/unreachable cell (by
//      knockback or the crowd) used to read a (0,0) flow and fall back to charging the
//      obstacle in a straight line. It now steers back toward the nearest reachable
//      cell on the field — i.e. onto the route — instead of grinding on the prop.
import { pointBlocked } from './collide.js';

const NEIGHBORS8 = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

export class NavField {
  // bounds: {minX,maxX,minZ,maxZ} (the room's inner playable area)
  // colliders: AABB list for that room; clearance ~ enemy radius so paths keep them
  //            off the furniture; cell = grid resolution in world units.
  constructor(bounds, colliders, opts = {}) {
    const cell = opts.cell || 0.4;
    const clearance = opts.clearance != null ? opts.clearance : 0.45;
    this.cell = cell;
    this.minX = bounds.minX;
    this.minZ = bounds.minZ;
    this.cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cell));
    this.rows = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / cell));
    const n = this.cols * this.rows;
    this.blocked = new Uint8Array(n);
    this.dist = new Float32Array(n);
    this.flowX = new Float32Array(n);
    this.flowZ = new Float32Array(n);
    this._q = new Int32Array(n); // BFS ring buffer of cell indices
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const x = this.minX + (c + 0.5) * cell;
        const z = this.minZ + (r + 0.5) * cell;
        if (pointBlocked(x, z, clearance, colliders)) this.blocked[r * this.cols + c] = 1;
      }
    }
    this._tc = -1; this._tr = -1; // last target cell (skip rebuild when unchanged)
  }

  _clampCol(x) {
    let c = Math.floor((x - this.minX) / this.cell);
    if (c < 0) c = 0; else if (c >= this.cols) c = this.cols - 1;
    return c;
  }
  _clampRow(z) {
    let r = Math.floor((z - this.minZ) / this.cell);
    if (r < 0) r = 0; else if (r >= this.rows) r = this.rows - 1;
    return r;
  }

  _reachable(i) { return !this.blocked[i] && this.dist[i] !== Infinity; }

  // Nearest walkable cell to (c,r), spiralling outward. Lets the target sit on a
  // blocked cell (player pressed against a table) without breaking the sweep.
  _nearestFree(c, r) {
    const i = r * this.cols + c;
    if (!this.blocked[i]) return i;
    const maxRad = Math.max(this.cols, this.rows);
    for (let rad = 1; rad < maxRad; rad++) {
      for (let dr = -rad; dr <= rad; dr++) {
        const nr = r + dr;
        if (nr < 0 || nr >= this.rows) continue;
        const edge = (dr === -rad || dr === rad);
        const step = edge ? 1 : (2 * rad); // interior rows only visit the two side cells
        for (let dc = -rad; dc <= rad; dc += (step || 1)) {
          const nc = c + dc;
          if (nc < 0 || nc >= this.cols) continue;
          const ni = nr * this.cols + nc;
          if (!this.blocked[ni]) return ni;
        }
      }
    }
    return i;
  }

  // Rebuild the field so it flows toward (tx,tz). No-op when the target hasn't moved
  // to a new cell, so calling every frame is cheap.
  update(tx, tz) {
    const c = this._clampCol(tx), r = this._clampRow(tz);
    if (c === this._tc && r === this._tr) return;
    this._tc = c; this._tr = r;

    const cols = this.cols, rows = this.rows;
    const dist = this.dist, blocked = this.blocked, q = this._q;
    dist.fill(Infinity);

    const start = this._nearestFree(c, r);
    dist[start] = 0;
    let head = 0, tail = 0;
    q[tail++] = start;
    // 4-connected BFS (uniform cost -> plain FIFO gives exact shortest grid distance)
    while (head < tail) {
      const cur = q[head++];
      const cc = cur % cols, cr = (cur - cc) / cols;
      const nd = dist[cur] + 1;
      for (let k = 0; k < 4; k++) {
        const nc = cc + NEIGHBORS8[k][0], nr = cr + NEIGHBORS8[k][1];
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const ni = nr * cols + nc;
        if (blocked[ni] || dist[ni] !== Infinity) continue;
        dist[ni] = nd;
        q[tail++] = ni;
      }
    }

    // Per-cell flow: point at whichever of the 8 neighbours has the lowest distance,
    // skipping diagonals that would clip a blocked corner.
    const flowX = this.flowX, flowZ = this.flowZ;
    for (let cr = 0; cr < rows; cr++) {
      for (let cc = 0; cc < cols; cc++) {
        const ci = cr * cols + cc;
        if (blocked[ci] || dist[ci] === Infinity) { flowX[ci] = 0; flowZ[ci] = 0; continue; }
        let bestD = dist[ci], bx = 0, bz = 0;
        for (let k = 0; k < 8; k++) {
          const ox = NEIGHBORS8[k][0], oz = NEIGHBORS8[k][1];
          const nc = cc + ox, nr = cr + oz;
          if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
          const ni = nr * cols + nc;
          if (blocked[ni] || dist[ni] === Infinity) continue;
          if (k >= 4) {
            // diagonal: require both shared orthogonal cells open (no corner cutting)
            if (blocked[cr * cols + nc] || blocked[nr * cols + cc]) continue;
          }
          if (dist[ni] < bestD) { bestD = dist[ni]; bx = ox; bz = oz; }
        }
        if (bx === 0 && bz === 0) { flowX[ci] = 0; flowZ[ci] = 0; continue; }
        const inv = 1 / Math.hypot(bx, bz);
        flowX[ci] = bx * inv; flowZ[ci] = bz * inv;
      }
    }
  }

  // World-space heading from (x,z) toward the closest reachable cell on the field,
  // spiralling out and aiming at that cell's centre. This is the recovery path for an
  // enemy that's standing on a blocked/severed/flat cell (shoved into furniture by
  // knockback or the crowd): rather than stall or charge the prop in a straight line,
  // it walks back onto the route. Writes (0,0) only when nothing nearby is reachable.
  _escapeDir(x, z, c, r, out) {
    const cols = this.cols, rows = this.rows, cell = this.cell;
    const maxRad = Math.max(cols, rows);
    for (let rad = 1; rad <= maxRad; rad++) {
      let best = -1, bestDist = Infinity;
      for (let dr = -rad; dr <= rad; dr++) {
        const nr = r + dr;
        if (nr < 0 || nr >= rows) continue;
        const edge = (dr === -rad || dr === rad);
        const step = edge ? 1 : (2 * rad); // interior rows only visit the two side cells
        for (let dc = -rad; dc <= rad; dc += (step || 1)) {
          const nc = c + dc;
          if (nc < 0 || nc >= cols) continue;
          const ni = nr * cols + nc;
          if (!this._reachable(ni)) continue;
          // among the closest ring that has any reachable cell, pick the one nearest
          // the target (lowest BFS distance) so we rejoin the route heading the right way
          if (this.dist[ni] < bestDist) { bestDist = this.dist[ni]; best = ni; }
        }
      }
      if (best >= 0) {
        const bc = best % cols, br = (best - bc) / cols;
        const dx = (this.minX + (bc + 0.5) * cell) - x;
        const dz = (this.minZ + (br + 0.5) * cell) - z;
        const l = Math.hypot(dx, dz);
        if (l < 1e-6) { out.x = this.flowX[best]; out.z = this.flowZ[best]; }
        else { out.x = dx / l; out.z = dz / l; }
        return out;
      }
    }
    out.x = 0; out.z = 0;
    return out;
  }

  // Unit direction the enemy at (x,z) should travel to reach the target. Writes into
  // `out` and returns it; (0,0) means no route (caller should fall back to straight).
  dirAt(x, z, out) {
    const c = this._clampCol(x), r = this._clampRow(z);
    const i = r * this.cols + c;
    if (this._reachable(i) && (this.flowX[i] !== 0 || this.flowZ[i] !== 0)) {
      out.x = this.flowX[i]; out.z = this.flowZ[i];
      return out;
    }
    // Wedged onto a blocked / unreachable / flat cell — steer back onto the field
    // instead of returning a dead (0,0) that would make the caller charge the prop.
    return this._escapeDir(x, z, c, r, out);
  }
}
