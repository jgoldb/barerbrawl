// The dvar-torah cut-scene — plays once, after the first boss hall is cleared.
//
// A hand-authored beis medrash: rows of shulchan tables with benches, windows and
// gilt rabbi-portraits along the walls, candle chandeliers overhead, and a rebbe at
// his shtender rocking (shuckling) in deep concentration as he delivers a dvar torah.
// The benches are filled with chavrusa hanging on his every word. His teaching is
// real Torah twisted dark — the yetzer hara reframed as something to obey, the Satan
// as a faithful guide — so the scene reads as the moment the yeshiva began to turn.
//
// Built as its OWN THREE.Scene (fully isolated from the streamed gameplay world); the
// game reparents the shared player camera into it, runs the beat list through the
// generic Cutscene director, and calls update() each frame for the ambient life
// (flicker, shuckle, audience nods, the warm-hall-goes-ominous tint). Near the end we
// reveal that one of the seated bochurim has been Chaim Barer all along — his photo
// billboard snaps on for a slow push-in onto his face before we fade back to the game.
import * as THREE from 'three';
import { MAT, COAT_COLORS, SKIN_TONES, BEARD_TONES, BARER } from './assets.js';
import { WALL_H, WALL_T } from './mapgen.js';
import * as Props from './props.js';
import { buildCharacter, sitPose } from './characters.js';

const lerp = (a, b, t) => a + (b - a) * t;
const _red = new THREE.Color(0xff2a12);
const _darkRed = new THREE.Color(0x2a0604);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

// ---- layout (all in the dvar scene's local space) ---------------------------
const HW = 7;                 // half-width (walls at x = ±HW)
const MINZ = -11, MAXZ = 11;  // front wall (behind the rebbe) / back wall
const INNER_X = HW - WALL_T / 2;
const RABBI_Z = -8.8;         // the rebbe stands here, facing the hall (+Z)
const BARER_POS = { x: 1.74, y: 1.52, z: -5.0 }; // front-row seat + where the reveal looks
const BARER_FACE_Y = 1.62;    // his billboard head rides a little above the look point,
                              // so his coat collar sits under his chin rather than over it

export class DvarTorah {
  constructor(ui, audio) {
    this.ui = ui; this.audio = audio;
    this.built = false;
    this.fervor = 0.2;   // how animated the audience is (0..1)
    this.dread = 0;      // warm -> ominous-red tint (0..1)
    this.gesture = 0;    // how emphatically the rebbe is gesturing (0..1)
  }

  // ---------------------------------------------------------------- build
  build() {
    if (this.built) return;
    this.scene = new THREE.Scene();
    this.group = new THREE.Group(); this.scene.add(this.group);
    this._disposables = [];   // materials + textures cloned/created here
    this._charMats = [];      // per-character material clones
    this.lights = []; this.flames = []; this.audience = [];
    this.rabbi = null; this.barer = null;

    this.scene.background = new THREE.Color(0x080503);
    this._baseFog = new THREE.Color(0x241206);
    this.scene.fog = new THREE.FogExp2(this._baseFog.getHex(), 0.021);
    this.ambient = new THREE.AmbientLight(0x4a3826, 0.5); this.scene.add(this.ambient);
    this.hemi = new THREE.HemisphereLight(0x6a5236, 0x140a04, 0.5); this.scene.add(this.hemi);
    this._ambBase = 0.5; this._hemiBase = 0.5;

    const width = HW * 2, depth = MAXZ - MINZ, H = WALL_H, T = WALL_T;

    // floor + ceiling
    const floor = this._planeXZ(width, depth, this._surf(MAT.floor, width / 3.6, depth / 3.6), true);
    floor.position.set(0, 0, 0); this.group.add(floor);
    const ceil = this._planeXZ(width, depth, this._surf(MAT.ceiling, width / 3.6, depth / 3.6), false);
    ceil.position.set(0, H, 0); this.group.add(ceil);

    // walls
    this._wall(width + T * 2, H, T, 0, H / 2, MINZ, this._surf(MAT.wallWarm, width / 3.6, H / 3.4));
    this._wall(width + T * 2, H, T, 0, H / 2, MAXZ, this._surf(MAT.wallWarm, width / 3.6, H / 3.4));
    this._wall(T, H, depth, -HW, H / 2, 0, this._surf(MAT.wallWarm, depth / 3.6, H / 3.4));
    this._wall(T, H, depth, HW, H / 2, 0, this._surf(MAT.wallWarm, depth / 3.6, H / 3.4));

    // windows + rabbi-portraits alternating down each side wall
    const glow = 0xffcf82;
    const windowsZ = [-6, -1, 4, 9];
    const portraitsZ = [-8.3, -3.5, 1.5, 6.5];
    for (const sx of [-1, 1]) {
      const wallX = sx < 0 ? -INNER_X : INNER_X;
      const rotY = sx < 0 ? Math.PI / 2 : -Math.PI / 2;
      const off = Props.WINDOW_WELL + 0.02;
      for (const z of windowsZ) {
        const win = Props.windowArch(1.4, 2.4, glow);
        win.position.set(wallX - sx * off, 0, z); win.rotation.y = rotY;
        this.group.add(win);
        this._addLight(glow, 3, 6, wallX - sx * 0.4, 1.4, z, false);
      }
      for (const z of portraitsZ) {
        const pt = Props.portrait(1.0, 1.36);
        pt.position.set(wallX - sx * 0.05, 2.35, z); pt.rotation.y = rotY;
        this.group.add(pt);
        this._disposables.push(pt.userData._picMat, pt.userData._tex);
      }
    }

    // chandeliers down the center line
    for (const cz of [-5, 1, 7]) {
      const ch = Props.chandelier(8, 0.95);
      ch.position.set(0, H - 1.1, cz); this.group.add(ch);
      this.flames.push(...ch.userData.flames);
      this._addLight(glow, 14, 26, 0, H - 1.4, cz);
    }
    // warm key on the rebbe + a low candle up-wash off his shtender
    this._addLight(0xffd8a0, 7, 12, 0, 3.2, -7.2);
    this._addLight(0xff8a3a, 4, 8, 0, 1.5, -8.3);

    // ---- the rebbe + his shtender ------------------------------------------
    const rb = buildCharacter({ coat: 0x0b0b10, skin: 0xc09668, beard: 0xc4bcac, hat: 'homburg', bigBeard: true, glasses: true });
    rb.root.position.set(0, 0, RABBI_Z); rb.root.rotation.y = 0; // faces the hall
    this.group.add(rb.root);
    this._charMats.push(...Object.values(rb.root.userData.mats));
    this.rabbi = { root: rb.root, joints: rb.joints };
    const sh = Props.shtender(); sh.position.set(0, 0, -8.2); sh.rotation.y = Math.PI; // slope toward the rebbe
    this.group.add(sh);

    // ---- rows of tables + benches, every seat taken ------------------------
    const benchLen = 6.6, tableLen = 7.5, nSeat = 6, span = benchLen - 0.8;
    const rows = [
      { z: -5.0, table: false },   // front row: open floor to the rebbe, no table
      { z: -2.4, table: true },
      { z: 0.2, table: true },
      { z: 2.8, table: true },
      { z: 5.4, table: true },
    ];
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      if (row.table) {
        const tb = Props.studyTable(tableLen, 1.2);
        tb.position.set(0, 0, row.z - 1.2); this.group.add(tb);  // table in front (toward the rebbe)
        tb.traverse((o) => { if (o.userData && o.userData.flames) this.flames.push(...o.userData.flames); });
      }
      const bn = Props.bench(benchLen); bn.position.set(0, 0, row.z); bn.rotation.y = Math.PI; this.group.add(bn);
      for (let i = 0; i < nSeat; i++) {
        const seatX = -span / 2 + (i / (nSeat - 1)) * span;
        const isBarer = (ri === 0 && i === 4); // front row, right of center
        this._seatBochur(seatX, row.z, isBarer);
      }
    }

    this.built = true;
  }

  _seatBochur(x, z, isBarer) {
    const opts = isBarer
      ? { coat: 0x0d0d12, skin: 0xc99c72, beard: 0x3a2818, hat: 'fedora', bigBeard: false, glasses: false }
      : { coat: pick(COAT_COLORS), skin: pick(SKIN_TONES), beard: pick(BEARD_TONES),
          hat: Math.random() < 0.6 ? 'fedora' : 'homburg', bigBeard: Math.random() < 0.3, glasses: Math.random() < 0.3 };
    const b = buildCharacter(opts);
    b.root.position.set(x, 0, z); b.root.rotation.y = Math.PI; // face the rebbe (-Z)
    sitPose(b.joints);
    this.group.add(b.root);
    this._charMats.push(...Object.values(b.root.userData.mats));
    const actor = { root: b.root, joints: b.joints, phase: Math.random() * 6.28, isBarer };
    this.audience.push(actor);
    if (isBarer) {
      // he sits dead still, leaning in, drinking it in — no idle sway (see update)
      b.joints.torso.rotation.x = 0.12; b.joints.head.rotation.x = -0.02;
      // a hidden photo billboard where his head is; revealBarer() swaps it in. It draws
      // ON TOP of his body (depthTest off + high renderOrder) so his own coat collar can
      // never win the depth test and clip the bottom of his face — the reveal shot has a
      // clear line to him, so nothing legitimately sits in front of the face to hide.
      const mat = new THREE.SpriteMaterial({ map: BARER.def, transparent: true, depthTest: false, depthWrite: false });
      const spr = new THREE.Sprite(mat);
      spr.scale.set(1.02 * BARER.aspect, 1.02, 1); spr.position.set(0, BARER_FACE_Y, 0);
      spr.renderOrder = 20; spr.visible = false;
      b.root.add(spr);
      this._disposables.push(mat);
      actor.faceSprite = spr; actor.head = b.joints.head;
      this.barer = actor;
    }
  }

  // flip the seated bochur's sculpted head for Chaim Barer's photographic mug
  revealBarer() {
    if (!this.barer || this.barer.revealed) return;
    this.barer.revealed = true;
    this.barer.head.visible = false;
    this.barer.faceSprite.visible = true;
  }

  setFervor(v) { this.fervor = v; }
  setDread(v) { this.dread = v; }
  setGesture(v) { this.gesture = v; }

  // ---------------------------------------------------------------- per-frame
  update(dt, time) {
    if (!this.built) return;
    const h = this.dread;

    // candle flicker + the warm-to-ominous tint, folded into one light pass
    for (const e of this.lights) {
      const f = 0.82 + 0.18 * Math.sin(time * e.speed + e.phase) + 0.06 * Math.sin(time * e.speed * 2.7 + e.phase);
      e.light.color.copy(e.color).lerp(_red, h * 0.85);
      e.light.intensity = e.base * f * (1 - 0.25 * h) * (1 + 0.4 * h * (0.5 + 0.5 * Math.sin(time * 10)));
    }
    for (const fl of this.flames) fl.scale.y = 0.85 + 0.3 * Math.sin(time * 11 + fl.position.x * 3);
    this.ambient.intensity = this._ambBase * (1 - h) + 0.22 * h;
    this.hemi.intensity = this._hemiBase * (1 - h) + 0.2 * h;
    this.scene.fog.color.copy(this._baseFog).lerp(_darkRed, h);

    this._animRabbi(time);

    // the audience: a quiet, davening sway, leaning in and nodding harder as the fervor climbs
    const fv = this.fervor;
    for (const a of this.audience) {
      if (a.isBarer) continue;
      const j = a.joints, p = a.phase, s = Math.sin(time * 1.7 + p);
      j.torso.rotation.x = 0.12 + s * 0.03 * (0.5 + fv);
      j.head.rotation.x = 0.06 + s * 0.03 + Math.max(0, Math.sin(time * 2.3 + p * 3)) * 0.06 * fv;
      j.head.rotation.y = Math.sin(time * 0.9 + p) * 0.05;
    }
  }

  // the rebbe rocking over his shtender, one hand rising to drive the point home
  _animRabbi(time) {
    const j = this.rabbi.joints, g = this.gesture;
    const sway = Math.sin(time * 2.3) * 0.16 + Math.sin(time * 1.1 + 0.5) * 0.05;
    j.torso.rotation.x = 0.1 + sway * (0.7 + 0.5 * g);
    j.torso.rotation.z = Math.sin(time * 1.6) * 0.03;
    j.head.rotation.x = 0.12 + Math.sin(time * 2.3 + 0.4) * 0.08;
    // right hand lifts and shakes as he makes his point; left grips the shtender
    j.shoulderR.rotation.x = 0.3 + g * (1.05 + 0.18 * Math.sin(time * 6));
    j.shoulderR.rotation.z = -0.22;
    j.elbowR.rotation.x = -0.5 - g * 0.8;
    j.shoulderL.rotation.x = 0.5; j.shoulderL.rotation.z = 0.2; j.elbowL.rotation.x = -1.0;
    this.rabbi.root.position.z = RABBI_Z + Math.sin(time * 2.3) * 0.05; // whole-body shuckle
  }

  // ---------------------------------------------------------------- beats
  // The camera beats + the scripted dvar torah. `camera` is the shared player camera
  // (already reparented into this scene). Positions/looks are absolute in dvar space.
  beats(camera) {
    const D = this, A = this.audio;
    const fov = (p, from, to) => { camera.fov = lerp(from, to, p); camera.updateProjectionMatrix(); };
    return [
      { // establish: down the length of the packed hall toward the distant rebbe
        duration: 6.5, fade: 'in', vo: 'dvar-1',
        subtitle: 'Long before the halls rose against you… there was a voice they all came to hear.',
        cam: { from: { pos: [0, 3.2, 8.6], look: [0, 1.7, -8.4] }, to: { pos: [0, 2.5, 4.6], look: [0, 1.62, -8.5] } },
        onEnter: () => { D.setFervor(0.25); D.setDread(0); D.setGesture(0.2); A.ambient(true); },
      },
      { // the rebbe at his shtender, gently shuckling
        duration: 7.6, vo: 'dvar-2',
        subtitle: 'Chazal teach: <b>da lifnei mi atah omed</b> — know before Whom you stand.',
        cam: { from: { pos: [-1.7, 1.78, -6.4], look: [0, 1.62, -8.6] }, to: { pos: [1.7, 1.72, -6.4], look: [0, 1.62, -8.6] } },
        onEnter: () => D.setGesture(0.35),
      },
      { // push in — the question turns inward
        duration: 6.8, vo: 'dvar-3',
        subtitle: 'But tonight I ask you a deeper question. Do you know <span class="em">what</span> it is that stands within <b>you</b>?',
        cam: { from: { pos: [0, 1.8, -6.0], look: [0, 1.68, -8.6] }, to: { pos: [0.3, 1.72, -6.7], look: [0, 1.68, -8.6] } },
        onEnter: () => D.setGesture(0.55),
      },
      { // truck across the rapt front-row faces
        duration: 9.6, vo: 'dvar-4',
        subtitle: 'The <b>yetzer hara</b>, they name it — the evil within. Yet the Torah itself calls it <span class="em">tov me’od</span>. Very good.',
        cam: { from: { pos: [-3.3, 1.62, -6.7], look: [-1.0, 1.4, -4.4] }, to: { pos: [3.3, 1.62, -6.7], look: [1.0, 1.4, -4.4] } },
        onEnter: () => D.setFervor(0.45),
      },
      { // close on the rebbe, hand rising — the fire beneath creation
        duration: 9.7, vo: 'dvar-5',
        subtitle: 'Without it no man builds a home, takes a wife, lays a single stone. It is the fire beneath all of creation.',
        cam: { from: { pos: [-0.5, 1.7, -6.1], look: [0, 1.72, -8.6] }, to: { pos: [0.5, 1.8, -6.5], look: [0, 1.72, -8.6] } },
        onEnter: () => D.setGesture(0.85),
      },
      { // a reaction — a bochur leaning in, nodding
        duration: 7.0, vo: 'dvar-6',
        subtitle: 'Your rebbeim taught you to <i>break</i> it. To starve it. To beg it into silence.',
        cam: { from: { pos: [-2.6, 1.6, -6.6], look: [-1.74, 1.4, -5.0] }, to: { pos: [-2.0, 1.55, -6.0], look: [-1.74, 1.4, -5.0] } },
        onEnter: () => D.setFervor(0.62),
      },
      { // low, looming angle on the rebbe as the dread creeps in
        duration: 10.0, vo: 'dvar-7',
        subtitle: 'They were <b>afraid</b> of it. But a flame like this is not made to be smothered — it is made to be <b>obeyed</b>.',
        cam: { from: { pos: [0, 1.15, -6.2], look: [0, 1.92, -8.6] }, to: { pos: [0, 1.08, -6.7], look: [0, 1.96, -8.6] } },
        onEnter: () => { A.hit(true, 0.5); },
        onUpdate: (bt, p) => D.setDread(0.15 + p * 0.3),
      },
      { // dynamic sweep flying in over the crowd
        duration: 7.0, vo: 'dvar-8',
        subtitle: 'Aizehu gibbor? Who is the true <b>gibbor</b>? Not the one who conquers his nature —',
        cam: { from: { pos: [-4.6, 2.4, 3.2], look: [0, 1.5, -6.6] }, to: { pos: [-1.4, 1.85, -0.6], look: [0, 1.6, -7.6] } },
        onEnter: () => { D.setFervor(0.82); D.setGesture(0.9); },
        onUpdate: (bt, p) => D.setDread(0.45 + p * 0.12),
      },
      { // the rebbe looming over the shtender — the twist named outright
        duration: 7.0, vo: 'dvar-9',
        subtitle: '— but the one who <span class="em">unleashes</span> it, and dares to call it <b>avodah</b>. Holy service.',
        cam: { from: { pos: [0, 1.72, -6.3], look: [0, 1.72, -8.7] }, to: { pos: [0, 1.64, -7.0], look: [0, 1.74, -8.7] } },
        onEnter: () => { D.setGesture(1.0); A.shofar(); },
      },
      { // hushed — the Satan, dressed as a faithful guide — dolly through the crowd
        duration: 10.9, vo: 'dvar-10',
        subtitle: 'There is one who has waited at your shoulder since the day you were born. Patient. Faithful. He asks only that you <b>listen</b>.',
        cam: { from: { pos: [0, 1.66, 2.2], look: [0, 1.55, -8.0] }, to: { pos: [0, 1.66, -1.4], look: [0, 1.58, -8.4] } },
        onEnter: () => { A.finisherSting(); },
        onUpdate: (bt, p) => D.setDread(0.6 + p * 0.25),
      },
      { // the final point — open the door
        duration: 12.0, vo: 'dvar-11',
        subtitle: 'So tonight, my talmidim — <b>open the door</b>. Let him in. And become at last <span class="em">what you were made to be</span>.',
        cam: { from: { pos: [0, 1.72, -6.0], look: [0, 1.78, -8.7] }, to: { pos: [0.2, 1.74, -6.7], look: [0, 1.78, -8.7] } },
        onEnter: () => { D.setDread(1.0); A.shofar(); },
      },
      { // a wordless breath after the climax — let it hang. The camera drifts, uneasy,
        // over the rapt red-lit crowd before we find the one who mattered.
        duration: 2.8,
        subtitle: '',
        cam: { from: { pos: [3.4, 2.0, 2.2], look: [0.2, 1.42, -3.2] }, to: { pos: [2.1, 1.72, -1.6], look: [0.6, 1.45, -4.4] } },
      },
      { // THE REVEAL — one of the boys has been Chaim Barer all along. The line lands
        // early; the rest of the beat is a silent slow push-in onto his newly-shown face.
        duration: 6.8, vo: 'dvar-12',
        subtitle: 'And in the front row, one talmid drank in every word.',
        cam: { from: { pos: [0.6, 2.0, -7.8], look: [BARER_POS.x, BARER_POS.y, BARER_POS.z] },
               to: { pos: [1.3, 1.66, -6.35], look: [BARER_POS.x, BARER_POS.y, BARER_POS.z] } },
        onEnter: () => { D.revealBarer(); A.finisherSting(); },
        onUpdate: (bt, p) => fov(p, 76, 50),
      },
      { // hold on his face and name him — the clip is short, so most of this beat is a
        // silent stare into his eyes as the twisted ideas turn over behind them
        duration: 4.4, vo: 'dvar-13',
        subtitle: '<b>Chaim Barer.</b>',
        cam: { from: { pos: [1.3, 1.66, -6.35], look: [BARER_POS.x, BARER_POS.y, BARER_POS.z] },
               to: { pos: [1.44, 1.6, -6.02], look: [BARER_POS.x, BARER_POS.y, BARER_POS.z] } },
        onUpdate: () => { camera.fov = 50; camera.updateProjectionMatrix(); },
      },
      { // final silent beat: keep holding on his face (name still up) and fade to black,
        // then _endDvarTorah hands control back to the game. Fading HERE (not at the start
        // of the name beat) means we linger on him before the dip, not over dead air.
        duration: 2.2, fade: 'out', fadeDur: 1.2,
        cam: { from: { pos: [1.44, 1.6, -6.02], look: [BARER_POS.x, BARER_POS.y, BARER_POS.z] },
               to: { pos: [1.5, 1.58, -5.85], look: [BARER_POS.x, BARER_POS.y, BARER_POS.z] } },
        onUpdate: () => { camera.fov = 50; camera.updateProjectionMatrix(); },
      },
    ];
  }

  // ---------------------------------------------------------------- helpers
  _surf(baseMat, rx, ry) {
    const m = baseMat.clone();
    if (baseMat.map) {
      m.map = baseMat.map.clone(); m.map.needsUpdate = true;
      m.map.wrapS = m.map.wrapT = THREE.RepeatWrapping; m.map.repeat.set(rx, ry);
      this._disposables.push(m.map);
    }
    this._disposables.push(m);
    return m;
  }
  _planeXZ(w, d, mat, up) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    m.rotation.x = up ? -Math.PI / 2 : Math.PI / 2; m.receiveShadow = true;
    return m;
  }
  _wall(w, h, d, x, y, z, mat) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.receiveShadow = true; m.castShadow = false;
    this.group.add(m); return m;
  }
  _addLight(color, intensity, dist, x, y, z, flicker = true) {
    const L = new THREE.PointLight(color, intensity, dist, 2);
    L.position.set(x, y, z); this.scene.add(L);
    this.lights.push({ light: L, base: intensity, phase: Math.random() * 6.28, speed: flicker ? 6 + Math.random() * 4 : 0, color: L.color.clone() });
  }

  dispose() {
    if (!this.built) return;
    this.group.traverse((o) => { if (o.isMesh && o.geometry && !o.geometry.userData.shared) o.geometry.dispose(); });
    for (const m of this._disposables) { if (m) m.dispose(); }
    for (const m of this._charMats) { if (m) m.dispose(); }
    this.scene = null; this.group = null;
    this.audience = []; this.lights = []; this.flames = [];
    this.rabbi = null; this.barer = null;
    this.built = false;
  }
}
