// 2D (x,z) circle-vs-AABB collision helpers shared by player, enemies, world.
// AABB shape: { minX, maxX, minZ, maxZ, top? }.  `top` is the height of the box's
// upper surface; when supplied, an entity whose feet are within `clear` of that top
// (or above it) may pass over the box horizontally and stand on it — that's how the
// player jumps onto benches/tables. Omitting `top` (or a huge value) = a full wall.

export function resolveCircle(pos, radius, colliders, iterations = 2, feetY = 0, clear = 0) {
  let hit = false;
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < colliders.length; i++) {
      const b = colliders[i];
      // skip boxes low enough to stand on / already beneath the feet — no side blocking
      if (b.top !== undefined && b.top - feetY <= clear) continue;
      const cx = Math.max(b.minX, Math.min(pos.x, b.maxX));
      const cz = Math.max(b.minZ, Math.min(pos.z, b.maxZ));
      let dx = pos.x - cx, dz = pos.z - cz;
      let d2 = dx * dx + dz * dz;
      if (d2 > radius * radius) continue;
      hit = true;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        const push = (radius - d) / d;
        pos.x += dx * push; pos.z += dz * push;
      } else {
        // center inside the box — eject along least-penetration axis
        const penL = pos.x - b.minX, penR = b.maxX - pos.x;
        const penT = pos.z - b.minZ, penB = b.maxZ - pos.z;
        const minPen = Math.min(penL, penR, penT, penB);
        if (minPen === penL) pos.x = b.minX - radius;
        else if (minPen === penR) pos.x = b.maxX + radius;
        else if (minPen === penT) pos.z = b.minZ - radius;
        else pos.z = b.maxZ + radius;
      }
    }
  }
  return hit;
}

// Highest surface the entity can rest on at (x,z): the tallest collider whose
// footprint contains the point and whose top is no more than `clear` above the feet.
// Returns 0 (the floor) when nothing qualifies.
export function surfaceHeight(x, z, colliders, feetY, clear) {
  let h = 0;
  for (let i = 0; i < colliders.length; i++) {
    const b = colliders[i];
    if (b.top === undefined) continue;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    if (b.top <= feetY + clear && b.top > h) h = b.top;
  }
  return h;
}

export function pointBlocked(x, z, radius, colliders) {
  for (let i = 0; i < colliders.length; i++) {
    const b = colliders[i];
    const cx = Math.max(b.minX, Math.min(x, b.maxX));
    const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
    const dx = x - cx, dz = z - cz;
    if (dx * dx + dz * dz < radius * radius) return true;
  }
  return false;
}

// Is the straight floor segment (x0,z0)->(x1,z1) obstructed by any collider?
// Each box is inflated by `pad` (use the mover's radius) so a "clear" line means a
// circle of that radius could actually slide along it. Only colliders at least
// `minTop` tall block: the default (~0) means anything walk-over-low is ignored;
// pass a large minTop (e.g. 2) to test only against walls — a thrown sefer arcs over
// tables/benches, so its line-of-sight cares only about full-height obstructions.
// Used for enemy line-of-sight (walk straight when open, else use the flow field)
// and for the anti-perch throw check.
export function lineBlocked(x0, z0, x1, z1, colliders, pad = 0, minTop = 0.001) {
  const dx = x1 - x0, dz = z1 - z0;
  for (let i = 0; i < colliders.length; i++) {
    const b = colliders[i];
    if (b.top !== undefined && b.top < minTop) continue;
    const minX = b.minX - pad, maxX = b.maxX + pad;
    const minZ = b.minZ - pad, maxZ = b.maxZ + pad;
    // slab clip of the segment against the padded box on both axes
    let t0 = 0, t1 = 1, ok = true;
    if (Math.abs(dx) < 1e-8) {
      if (x0 < minX || x0 > maxX) ok = false;
    } else {
      let ta = (minX - x0) / dx, tb = (maxX - x0) / dx;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) ok = false;
    }
    if (ok) {
      if (Math.abs(dz) < 1e-8) {
        if (z0 < minZ || z0 > maxZ) ok = false;
      } else {
        let ta = (minZ - z0) / dz, tb = (maxZ - z0) / dz;
        if (ta > tb) { const t = ta; ta = tb; tb = t; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) ok = false;
      }
    }
    if (ok) return true;
  }
  return false;
}
