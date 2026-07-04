// Yeshiva furniture & set-dressing, built from primitives.
// Each factory returns a THREE.Group; solid props set group.userData.footprint = {hx,hz}
// (local half-extents) so the room builder can register a collider.
import * as THREE from 'three';
import { MAT } from './assets.js';
import * as T from './textures.js';

function box(w, h, d, mat, cast = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = cast; m.receiveShadow = true;
  return m;
}
function cyl(rt, rb, h, mat, seg = 12) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
// three.js Object3D.position is read-only — must .set() rather than reassign.
function put(mesh, x, y, z) { mesh.position.set(x, y, z); return mesh; }

// ---- Bookshelf full of sefarim (goes against a wall) -------------------------
export function bookshelf(w = 2.2, h = 3.6) {
  const g = new THREE.Group();
  const d = 0.5;
  const frameMat = MAT.woodDark;
  // back + book face
  const back = box(w, h, 0.06, MAT.books);
  back.position.set(0, h / 2, -d / 2 + 0.06);
  g.add(back);
  // side/frame
  g.add(put(box(0.1, h, d, frameMat), -w / 2, h / 2, 0));
  g.add(put(box(0.1, h, d, frameMat), w / 2, h / 2, 0));
  g.add(put(box(w, 0.12, d, frameMat), 0, h, 0));
  g.add(put(box(w, 0.16, d, frameMat), 0, 0.08, 0));
  // shelves
  const rows = Math.max(3, Math.round(h / 0.62));
  for (let i = 1; i < rows; i++) {
    const sh = box(w, 0.05, d - 0.06, frameMat, false);
    sh.position.set(0, (h / rows) * i, 0.02);
    g.add(sh);
  }
  g.userData.footprint = { hx: w / 2, hz: d / 2 };
  return g;
}

// ---- Long study table (shulchan) with sefarim + shtenders on top -------------
export function studyTable(len = 5, w = 1.3) {
  const g = new THREE.Group();
  const topH = 0.9;
  const top = box(len, 0.12, w, MAT.woodMid);
  top.position.y = topH; g.add(top);
  const legMat = MAT.woodDark;
  const lx = len / 2 - 0.3, lz = w / 2 - 0.3;
  for (const sx of [-lx, lx]) for (const sz of [-lz, lz]) {
    const leg = box(0.16, topH, 0.16, legMat);
    leg.position.set(sx, topH / 2, sz); g.add(leg);
  }
  // stretcher
  const st = box(len - 0.4, 0.1, 0.1, legMat); st.position.set(0, topH * 0.4, 0); g.add(st);
  // sefarim stacked on top
  const bookMats = [MAT.woodRed, MAT.woodDark, MAT.velvet, MAT.velvetBlue];
  const n = Math.floor(len);
  for (let i = 0; i < n; i++) {
    if (Math.random() < 0.35) continue;
    const bx = -len / 2 + 0.6 + i * (len - 1.2) / Math.max(1, n - 1);
    const bz = (Math.random() - 0.5) * (w - 0.5);
    const stack = 1 + (Math.random() * 2 | 0);
    for (let s = 0; s < stack; s++) {
      const bw = 0.28 + Math.random() * 0.12, bd = 0.36 + Math.random() * 0.1;
      const bk = box(bw, 0.08, bd, bookMats[(Math.random() * bookMats.length) | 0]);
      bk.rotation.y = (Math.random() - 0.5) * 0.5;
      bk.position.set(bx, topH + 0.1 + s * 0.09, bz);
      g.add(bk);
    }
  }
  // a couple of candlesticks
  for (let i = 0; i < 2; i++) {
    const cs = candlestick();
    cs.position.set(-len / 3 + i * (2 * len / 3), topH + 0.06, 0);
    cs.scale.setScalar(0.8);
    g.add(cs);
  }
  g.userData.footprint = { hx: len / 2, hz: w / 2 };
  g.userData.tableTop = topH;
  g.userData.standHeight = topH + 0.06; // top face of the 0.12-thick tabletop
  return g;
}

// ---- Shtender (lectern) ------------------------------------------------------
export function shtender() {
  const g = new THREE.Group();
  const post = cyl(0.06, 0.09, 1.05, MAT.woodDark, 8);
  post.position.y = 0.52; g.add(post);
  const base = cyl(0.34, 0.4, 0.08, MAT.woodDark, 12); base.position.y = 0.04; g.add(base);
  const slope = box(0.6, 0.05, 0.44, MAT.woodMid);
  slope.position.set(0, 1.06, 0.02); slope.rotation.x = -0.42; g.add(slope);
  const lip = box(0.6, 0.05, 0.05, MAT.woodDark); lip.position.set(0, 0.98, 0.2); g.add(lip);
  // open sefer on top
  const sefer = box(0.42, 0.03, 0.34, MAT.paper);
  sefer.position.set(0, 1.11, 0.02); sefer.rotation.x = -0.42; g.add(sefer);
  g.userData.footprint = { hx: 0.34, hz: 0.34 };
  return g;
}

// ---- Bench -------------------------------------------------------------------
export function bench(len = 3) {
  const g = new THREE.Group();
  const seat = box(len, 0.1, 0.5, MAT.woodMid); seat.position.y = 0.5; g.add(seat);
  for (const sx of [-len / 2 + 0.25, len / 2 - 0.25]) {
    const leg = box(0.14, 0.5, 0.45, MAT.woodDark); leg.position.set(sx, 0.25, 0); g.add(leg);
  }
  g.userData.footprint = { hx: len / 2, hz: 0.25 };
  g.userData.standHeight = 0.55; // top face of the seat (y 0.5 + half of 0.1)
  return g;
}

// ---- Chair -------------------------------------------------------------------
export function chair() {
  const g = new THREE.Group();
  const seat = box(0.5, 0.08, 0.5, MAT.woodMid); seat.position.y = 0.5; g.add(seat);
  const back = box(0.5, 0.6, 0.08, MAT.woodMid); back.position.set(0, 0.8, -0.21); g.add(back);
  for (const sx of [-0.2, 0.2]) for (const sz of [-0.2, 0.2]) {
    const leg = box(0.07, 0.5, 0.07, MAT.woodDark); leg.position.set(sx, 0.25, sz); g.add(leg);
  }
  g.userData.footprint = { hx: 0.3, hz: 0.3 };
  return g;
}

// ---- Candlestick (with flame) ------------------------------------------------
export function candlestick() {
  const g = new THREE.Group();
  const stem = cyl(0.03, 0.05, 0.28, MAT.brass, 8); stem.position.y = 0.14; g.add(stem);
  const foot = cyl(0.09, 0.11, 0.03, MAT.brass, 10); foot.position.y = 0.015; g.add(foot);
  const candle = cyl(0.03, 0.035, 0.22, MAT.wax, 8); candle.position.y = 0.39; g.add(candle);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.11, 7), MAT.flame);
  flame.position.y = 0.55; g.add(flame);
  const core = new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.06, 6), MAT.flameCore);
  core.position.y = 0.53; g.add(core);
  g.userData.flames = [flame];
  return g;
}

// ---- Hanging chandelier (visual; room builder adds the actual light) ---------
export function chandelier(arms = 6, r = 0.8) {
  const g = new THREE.Group();
  const chain = cyl(0.02, 0.02, 1.2, MAT.brassDark, 6); chain.position.y = 0.6; g.add(chain);
  const hub = cyl(0.14, 0.18, 0.16, MAT.brass, 10); hub.position.y = -0.1; g.add(hub);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.03, 6, 20), MAT.brass);
  ring.rotation.x = Math.PI / 2; ring.position.y = -0.2; g.add(ring);
  const flames = [];
  for (let i = 0; i < arms; i++) {
    const a = (i / arms) * Math.PI * 2;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const arm = cyl(0.02, 0.02, r, MAT.brass, 5);
    arm.position.set(x / 2, -0.15, z / 2); arm.rotation.z = Math.PI / 2; arm.rotation.y = -a;
    g.add(arm);
    const candle = cyl(0.03, 0.035, 0.22, MAT.wax, 6); candle.position.set(x, -0.05, z); g.add(candle);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.13, 7), MAT.flame);
    flame.position.set(x, 0.1, z); g.add(flame);
    flames.push(flame);
  }
  g.userData.flames = flames;
  g.userData.isLightFixture = true;
  return g;
}

// ---- Window with a warm/night glow (sits in a wall) --------------------------
// The glowing glass fronts a little shadow-box diorama: a back sky plane plus two
// transparent skyline layers at different depths, boxed in by dark reveal sides.
// Because the layers sit at real, different depths, they parallax against each
// other as the player moves. A jab cracks the pane; a haymaker — or any strike on
// an already-cracked pane — shatters it, dropping the glass to expose the diorama.
// The wall behind stays solid, so it is purely cosmetic — see BreakableWindow /
// roombuilder for the wiring.

// Cached, shared resources (a small bounded set keyed by glow color) so streaming
// rooms in and out never churns GPU textures/materials. Never disposed.
const _skyCache = new Map();    // glowHex -> back sky MeshBasicMaterial (opaque)
const _farCache = new Map();    // glowHex -> far skyline material (alpha cutout)
const _nearCache = new Map();   // glowHex -> near skyline material (alpha cutout)
const _glassCache = new Map();  // glowHex -> emissive glass MeshStandardMaterial
let _crackMat = null;           // shared crack overlay material
let _revealMat = null;          // shared dark reveal (window well) material

function skyMat(hex) {
  let m = _skyCache.get(hex);
  if (!m) { m = new THREE.MeshBasicMaterial({ map: T.nightSky(hex) }); _skyCache.set(hex, m); }
  return m;
}
// alphaTest cutout (not blended) so the layered silhouettes need no transparency
// sorting and occlude each other correctly by depth
function skylineMat(cache, hex, near) {
  let m = cache.get(hex);
  if (!m) { m = new THREE.MeshBasicMaterial({ map: T.nightSkyline(hex, near), transparent: true, alphaTest: 0.5, depthWrite: false }); cache.set(hex, m); }
  return m;
}
function glassMat(hex) {
  let m = _glassCache.get(hex);
  if (!m) { m = new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: 0.8, roughness: 0.4 }); _glassCache.set(hex, m); }
  return m;
}
function crackMat() {
  if (!_crackMat) _crackMat = new THREE.MeshBasicMaterial({ map: T.glassCracks(), transparent: true, depthWrite: false, opacity: 0.92 });
  return _crackMat;
}
function revealMat() {
  if (!_revealMat) _revealMat = new THREE.MeshStandardMaterial({ color: 0x14100b, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide });
  return _revealMat;
}

// a small irregular triangle for a flying glass shard
function shardGeo(s) {
  const g = new THREE.BufferGeometry();
  const a = s * (0.6 + Math.random() * 0.8);
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    0, a, 0, -s * 0.7, -a * 0.5, 0, s * 0.6, -a * 0.4, 0,
  ], 3));
  g.computeVertexNormals();
  return g;
}

// Controller attached to a window group (group.userData.breakable). Owns the
// intact/cracked/shattered state machine, shard particles, and the world-space
// hit target the player's punch tests against.
export class BreakableWindow {
  constructor(group, w, h, glowHex) {
    this.group = group;
    this.w = w; this.h = h; this.glow = glowHex;
    this.state = 'intact';      // intact -> cracked -> shattered
    this.glass = [];            // pane mesh(es), removed on shatter
    this.crackMesh = null;
    this.shards = [];
    this.shardMat = null;
    this.shardLife = 0; this.shardTTL = 1.7;
    // world-space punch target (center + vertical band); filled by refreshWorld()
    this.center = new THREE.Vector3(group.position.x, h / 2, group.position.z);
    this.loY = 0.15; this.hiY = h + 0.2;
  }

  // recompute the world hit target after the room builder positions the group
  // (a yaw-only rotation never moves a point on the group's own Y axis, so the
  // pane center is simply the group's x/z at pane-mid height)
  refreshWorld() { this.center.set(this.group.position.x, this.h / 2, this.group.position.z); }

  // returns true if this strike affected the window (so the caller can suppress
  // the empty-swing whoosh and add a solid-contact recoil). A jab cracks an intact
  // pane; a haymaker — or any strike on a cracked pane — shatters it.
  hit(heavy, audio) {
    if (this.state === 'shattered') return false;
    if (this.state === 'intact' && !heavy) this._crack(audio);
    else this._shatter(audio);
    return true;
  }

  _crack(audio) {
    this.state = 'cracked';
    const m = new THREE.Mesh(new THREE.PlaneGeometry(this.w, this.h), crackMat());
    m.position.set(0, this.h / 2, 0.012); // just in front of the pane (behind the muntins)
    this.group.add(m); this.crackMesh = m;
    if (audio) audio.glassCrack();
  }

  _shatter(audio) {
    this.state = 'shattered';
    if (this.crackMesh) { this.group.remove(this.crackMesh); this.crackMesh.geometry.dispose(); this.crackMesh = null; }
    // drop the glass -> the night scene behind it is now exposed
    for (const g of this.glass) { this.group.remove(g); g.geometry.dispose(); }
    this.glass.length = 0;
    // scatter shards: emissive so they glint, and transparent so the batch can
    // fade out together once it has settled on the floor
    this.shardMat = new THREE.MeshStandardMaterial({
      color: this.glow, emissive: this.glow, emissiveIntensity: 0.6,
      roughness: 0.2, metalness: 0.1, transparent: true, opacity: 1, side: THREE.DoubleSide,
    });
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(shardGeo(0.05 + Math.random() * 0.12), this.shardMat);
      // spawn across the pane, at the glass plane, tumbling outward into the room
      m.position.set((Math.random() - 0.5) * this.w * 0.9, 0.3 + Math.random() * (this.h - 0.4), 0.02);
      m.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
      this.group.add(m);
      this.shards.push({
        m, vx: (Math.random() - 0.5) * 0.8, vy: 0.4 + Math.random() * 1.4, vz: 0.5 + Math.random() * 1.3,
        rx: (Math.random() - 0.5) * 8, ry: (Math.random() - 0.5) * 8, rz: (Math.random() - 0.5) * 8, rest: false,
      });
    }
    this.shardLife = 0;
    if (audio) audio.glassShatter();
  }

  // the group is yaw-only, so local Y == world Y and local +Z points into the
  // room: gravity along -Y and outward motion along +Z both read correctly here.
  update(dt) {
    if (!this.shards.length) return;
    this.shardLife += dt;
    for (const sh of this.shards) {
      if (sh.rest) continue;
      sh.vy -= 9 * dt;
      sh.m.position.x += sh.vx * dt; sh.m.position.y += sh.vy * dt; sh.m.position.z += sh.vz * dt;
      sh.m.rotation.x += sh.rx * dt; sh.m.rotation.y += sh.ry * dt; sh.m.rotation.z += sh.rz * dt;
      if (sh.m.position.y <= 0.02) { sh.m.position.y = 0.02; sh.rest = true; sh.vx *= 0.3; sh.vz *= 0.3; }
    }
    const fadeStart = this.shardTTL - 0.5;
    if (this.shardLife > fadeStart && this.shardMat) this.shardMat.opacity = Math.max(0, 1 - (this.shardLife - fadeStart) / 0.5);
    if (this.shardLife >= this.shardTTL) this._clearShards();
  }

  _clearShards() {
    for (const sh of this.shards) { this.group.remove(sh.m); sh.m.geometry.dispose(); }
    this.shards.length = 0;
    if (this.shardMat) { this.shardMat.dispose(); this.shardMat = null; }
  }

  dispose() { this._clearShards(); } // shared glass/exterior/crack materials persist
}

// Depth of the shadow-box behind the glass (the window "well"). The group is
// stood off the wall by a hair more than this (see roombuilder) so the whole box
// sits in front of the solid wall face, which would otherwise occlude it.
export const WINDOW_WELL = 0.18;

export function windowArch(w = 1.4, h = 2.4, nightGlow = 0xffcf82) {
  const g = new THREE.Group();
  const frameMat = MAT.woodDark;
  const glass = glassMat(nightGlow);
  const D = WINDOW_WELL;

  // --- diorama: three planes at real, separate depths so they parallax. The back
  // sky is opaque; the two skyline layers are alpha-cutout silhouettes that let the
  // layer(s) behind show through their gaps.
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(w, h), skyMat(nightGlow));
  sky.position.set(0, h / 2, -D); g.add(sky);
  const far = new THREE.Mesh(new THREE.PlaneGeometry(w, h), skylineMat(_farCache, nightGlow, false));
  far.position.set(0, h / 2, -D * 0.58); g.add(far);
  const near = new THREE.Mesh(new THREE.PlaneGeometry(w, h), skylineMat(_nearCache, nightGlow, true));
  near.position.set(0, h / 2, -D * 0.22); g.add(near);

  // --- reveal sides: a dark box lining the opening, so it reads as a real, deep
  // recess (and hides the diorama's edges at glancing angles)
  const rev = revealMat();
  const revTop = new THREE.Mesh(new THREE.PlaneGeometry(w, D), rev); revTop.rotation.x = Math.PI / 2; revTop.position.set(0, h, -D / 2); g.add(revTop);
  const revBot = new THREE.Mesh(new THREE.PlaneGeometry(w, D), rev); revBot.rotation.x = -Math.PI / 2; revBot.position.set(0, 0, -D / 2); g.add(revBot);
  const revL = new THREE.Mesh(new THREE.PlaneGeometry(D, h), rev); revL.rotation.y = Math.PI / 2; revL.position.set(-w / 2, h / 2, -D / 2); g.add(revL);
  const revR = new THREE.Mesh(new THREE.PlaneGeometry(D, h), rev); revR.rotation.y = -Math.PI / 2; revR.position.set(w / 2, h / 2, -D / 2); g.add(revR);

  // --- the breakable glass: one glowing pane across the opening
  const pane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), glass);
  pane.position.set(0, h / 2, 0); g.add(pane);

  // --- muntins + outer casement — part of the fixed frame, so they survive a shatter
  for (const yy of [h * 0.33, h * 0.66]) g.add(put(box(w, 0.06, 0.06, frameMat, false), 0, yy, 0.02));
  g.add(put(box(0.06, h, 0.06, frameMat, false), 0, h / 2, 0.02));
  g.add(put(box(w + 0.22, 0.14, 0.1, frameMat, false), 0, h + 0.02, 0.03));  // head
  g.add(put(box(w + 0.22, 0.16, 0.12, frameMat, false), 0, -0.03, 0.03));    // sill
  g.add(put(box(0.12, h + 0.24, 0.1, frameMat, false), -w / 2 - 0.06, h / 2, 0.03)); // jamb
  g.add(put(box(0.12, h + 0.24, 0.1, frameMat, false), w / 2 + 0.06, h / 2, 0.03));  // jamb

  g.userData.glow = nightGlow;
  const bw = new BreakableWindow(g, w, h, nightGlow);
  bw.glass = [pane];
  g.userData.breakable = bw;
  return g;
}

// ---- Aron Kodesh (the Ark) — centerpiece of a shul room ----------------------
export function aronKodesh() {
  const g = new THREE.Group();
  const w = 2.6, h = 3.6, d = 0.9;
  const body = box(w, h, d, MAT.woodDark); body.position.y = h / 2; g.add(body);
  // stepped crown
  g.add(put(box(w + 0.3, 0.2, d + 0.2, MAT.woodMid), 0, h + 0.1, 0));
  g.add(put(box(w - 0.2, 0.3, d, MAT.woodMid), 0, h + 0.3, 0));
  // curtain (parochet) — velvet with gold
  const par = box(w - 0.5, h - 0.7, 0.05, MAT.velvet); par.position.set(0, (h - 0.7) / 2 + 0.35, d / 2 + 0.02); g.add(par);
  const trim = box(w - 0.5, 0.12, 0.06, MAT.gold); trim.position.set(0, h - 0.35, d / 2 + 0.03); g.add(trim);
  // two gold columns
  for (const sx of [-w / 2 + 0.18, w / 2 - 0.18]) {
    const col = cyl(0.1, 0.1, h - 0.2, MAT.gold, 10); col.position.set(sx, h / 2, d / 2 - 0.02); g.add(col);
  }
  // crown of tablets (luchos) shape on top
  const tab = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.12, 14, 1, false, 0, Math.PI), MAT.gold);
  tab.rotation.z = -Math.PI / 2; tab.position.set(0, h + 0.5, 0); g.add(tab);
  const tabBase = box(0.9, 0.5, 0.12, MAT.gold); tabBase.position.set(0, h + 0.35, 0); g.add(tabBase);
  // ner tamid (eternal light) hanging in front — a warm glow
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xff5a2a, emissive: 0xff6a2a, emissiveIntensity: 1.4, roughness: 0.5 });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 10), lampMat);
  lamp.position.set(0, h + 0.9, d / 2 + 0.5); g.add(lamp);
  g.userData.nerTamid = lamp;
  g.userData.footprint = { hx: w / 2, hz: d / 2 };
  return g;
}

// ---- Stone/wood pillar -------------------------------------------------------
export function pillar(h = 4.6) {
  const g = new THREE.Group();
  const shaft = cyl(0.32, 0.34, h - 0.4, MAT.stone, 14); shaft.position.y = h / 2; g.add(shaft);
  const cap = cyl(0.44, 0.36, 0.24, MAT.woodDark, 14); cap.position.y = h - 0.12; g.add(cap);
  const base = cyl(0.36, 0.46, 0.24, MAT.woodDark, 14); base.position.y = 0.12; g.add(base);
  g.userData.footprint = { hx: 0.4, hz: 0.4 };
  return g;
}

// ---- Hanging banner / sign ---------------------------------------------------
export function banner(w = 1.2, h = 1.8) {
  const g = new THREE.Group();
  const cloth = box(w, h, 0.04, MAT.parchment, false); cloth.position.y = -h / 2; g.add(cloth);
  const rod = cyl(0.03, 0.03, w + 0.2, MAT.brass, 6); rod.rotation.z = Math.PI / 2; g.add(rod);
  return g;
}

// ---- Simple wall sconce (visual glow) ---------------------------------------
export function sconce() {
  const g = new THREE.Group();
  const bracket = box(0.08, 0.3, 0.12, MAT.brassDark); bracket.position.y = -0.05; g.add(bracket);
  const cup = cyl(0.08, 0.05, 0.1, MAT.brass, 8); cup.position.y = 0.1; g.add(cup);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.18, 7), MAT.flame);
  flame.position.y = 0.24; g.add(flame);
  g.userData.flames = [flame];
  g.userData.isLightFixture = true;
  return g;
}
