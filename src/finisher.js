// The Barer finisher — an interactive close-up that plays after Chaim Barer is
// beaten down. The player holds him by the collar with one hand; the other is free.
//   Left-click  → Jab: punch him in the face (repeatable).
//   Right-click → "Baruch dayan haemet": grab both ears, "LOUIE BALLEWIE!", pull them
//                 apart until his face explodes.
//
// It renders inside the player's view-scene (the same overlay pass that draws the FPS
// fists), locked to the camera, so the whole tableau stays framed no matter where the
// camera happens to be pointing when Barer drops. The frozen world behind is hidden by
// an opaque backdrop for a clean, cinematic focus.
import * as THREE from 'three';
import { buildFists } from './characters.js';
import { BARER } from './assets.js';

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

export class BarerFinisher {
  constructor(player, ui, audio) {
    this.player = player; this.ui = ui; this.audio = audio;
    this.active = false;
    this.state = 'idle';
    this.t = 0;
    this.onDone = null;
    this.jabs = 0;
    this.shards = [];
    this._built = false;
    this._shardGeo = new THREE.PlaneGeometry(0.11, 0.11);
  }

  _build() {
    if (this._built) return;
    const rig = new THREE.Group();
    this.rig = rig;

    // opaque dark void behind Barer (renderOrder first, ignores depth)
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 9),
      new THREE.MeshBasicMaterial({ color: 0x0a0604, depthTest: false, depthWrite: false }),
    );
    back.position.set(0, 0, -2.4); back.renderOrder = -100;
    rig.add(back); this.backdrop = back;

    // the face billboard — an opaque alpha cutout so it depth-sorts against the hands
    const faceMat = new THREE.MeshBasicMaterial({ map: BARER.def, transparent: false, alphaTest: 0.5 });
    const fh = 1.24;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(fh * BARER.aspect, fh), faceMat);
    face.position.set(0, 0.06, -1.16);
    rig.add(face); this.face = face; this.faceMat = faceMat; this._faceBaseScale = face.scale.clone();

    // the collar he's held by: dark coat wedge + a white shirt collar
    const coat = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.5, 0.2),
      new THREE.MeshStandardMaterial({ color: 0x111116, roughness: 0.7 }));
    coat.position.set(0, -0.7, -1.2); coat.rotation.x = 0.18;
    rig.add(coat); this.coat = coat;
    const shirt = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.3, 0.06),
      new THREE.MeshStandardMaterial({ color: 0xe6e2d4, roughness: 0.8 }));
    shirt.position.set(0, -0.5, -1.08); shirt.rotation.x = 0.18;
    rig.add(shirt); this.shirt = shirt;

    // two fists — left grips the collar, right is free to punch. Fresh pair so we don't
    // disturb the player's own view-model rest transforms.
    const f = buildFists();
    this.hands = f.root; this.grip = f.left; this.free = f.right;
    rig.add(this.hands);

    this.player.viewRig.add(rig);
    this._built = true;
  }

  _setArm(arm, p, r, s = 1) {
    arm.position.set(p[0], p[1], p[2]);
    arm.rotation.set(r[0], r[1], r[2]);
    arm.scale.setScalar(s);
  }

  // ---- rest poses ----------------------------------------------------------
  _poseGrip(shake = 0) {
    // clenched around the collar, low-center, knuckles up
    this._setArm(this.grip,
      [-0.06 + shake, -0.5 + shake * 0.6, -0.9],
      [-0.9, 0.35, 0.35]);
  }
  _poseFreeRest() {
    // cocked low and to the right, ready to jab
    this._setArm(this.free, [0.5, -0.62, -0.66], [0.15, -0.35, -0.2]);
  }

  begin(barer, opts = {}) {
    this._build();
    this.onDone = opts.onDone || null;
    this.active = true;
    this.state = 'in'; this.t = 0; this.jabs = 0; this._jabHit = false;
    this._clearShards();
    // Fully reset everything a prior run's explosion / stretch left behind — this rig
    // is built once and reused, so nothing carries over between finishers.
    this.rig.visible = true;
    this.face.visible = true; this.coat.visible = true; this.shirt.visible = true;
    this.hands.visible = true; this.grip.visible = true; this.free.visible = true; // (boom hid these)
    this.face.position.set(0, 0.06, -1.6);
    this.face.rotation.set(0, 0, 0);
    this.face.scale.copy(this._faceBaseScale);
    this.coat.position.set(0, -0.7, -1.2); this.shirt.position.set(0, -0.5, -1.08);
    this.faceMat.map = BARER.def; this.faceMat.needsUpdate = true;
    this.faceMat.color.setRGB(1, 1, 1);
    this._poseGrip(); this._poseFreeRest();

    // input: read raw clicks off the document so we don't depend on pointer-lock state
    this._onClick = (e) => {
      if (!this.active) return;
      if (e.button === 0) this._jab();
      else if (e.button === 2) { this._finish(); e.preventDefault(); }
    };
    this._onCtx = (e) => { if (this.active) e.preventDefault(); };
    document.addEventListener('mousedown', this._onClick, true);
    document.addEventListener('contextmenu', this._onCtx, true);
  }

  end() {
    this.active = false;
    if (this.rig) this.rig.visible = false;
    this._clearShards();
    if (this._onClick) document.removeEventListener('mousedown', this._onClick, true);
    if (this._onCtx) document.removeEventListener('contextmenu', this._onCtx, true);
    this._onClick = this._onCtx = null;
  }

  _jab() {
    if (this.state !== 'idle') return;
    this.state = 'jab'; this.t = 0; this.jabs++;
  }

  _finish() {
    if (this.state !== 'idle' && this.state !== 'jab') return;
    this.state = 'grab'; this.t = 0;
    this.faceMat.map = BARER.def; this.faceMat.needsUpdate = true;
    if (this.ui.louieBanner) this.ui.louieBanner();
    if (this.ui.showFinisherPrompt) this.ui.showFinisherPrompt(false);
    this.audio.whoosh(true);
  }

  update(dt) {
    if (!this.active) return;
    this.t += dt;
    const time = performance.now() / 1000;

    // a constant terrified quiver on the whole held figure
    const qx = Math.sin(time * 34) * 0.006 + (Math.random() - 0.5) * 0.004;
    const qy = Math.cos(time * 41) * 0.006 + (Math.random() - 0.5) * 0.004;

    switch (this.state) {
      case 'in': {
        const p = smooth(Math.min(1, this.t / 0.45));
        this.face.position.z = lerp(-1.6, -1.16, p);   // quick push-in
        this._poseGrip(); this._poseFreeRest();
        if (this.t >= 0.45) { this.state = 'idle'; this.t = 0; if (this.ui.showFinisherPrompt) this.ui.showFinisherPrompt(true); }
        break;
      }
      case 'idle': {
        this.face.position.x = qx; this.face.position.y = 0.06 + qy;
        this.coat.position.x = qx; this.shirt.position.x = qx;
        this._poseGrip(Math.sin(time * 20) * 0.01);
        this._poseFreeRest();
        break;
      }
      case 'jab': {
        const dur = 0.34, p = this.t / dur;
        const sp = 0.42; // strike point
        const e = p < sp ? smooth(p / sp) : smooth(Math.max(0, 1 - (p - sp) / (1 - sp)));
        // free hand drives forward into the face and back
        this._setArm(this.free,
          [lerp(0.5, 0.06, e), lerp(-0.62, 0.0, e), lerp(-0.66, -1.02, e)],
          [lerp(0.15, -0.3, e), lerp(-0.35, 0.0, e), lerp(-0.2, 0.0, e)]);
        this._poseGrip(Math.sin(time * 20) * 0.01);
        // impact at the strike point: snap to the pain face, flash, recoil, thud
        if (!this._jabHit && p >= sp) {
          this._jabHit = true;
          this.faceMat.map = BARER.atk2; this.faceMat.needsUpdate = true;
          this.faceMat.color.setRGB(1, 0.5, 0.5);
          this.face.position.z = -1.02;                 // knocked back a hair
          this.player.shake = Math.min(1, this.player.shake + 0.4);
          this.audio.hit(true, 0.85); this.audio.enemyHurt(1.2);
        }
        // face recovers toward the end
        if (p > 0.7) { this.faceMat.color.setRGB(1, 1, 1); this.face.position.z = -1.16; }
        if (this.t >= dur) {
          this.state = 'idle'; this.t = 0; this._jabHit = false;
          this.faceMat.map = BARER.def; this.faceMat.needsUpdate = true;
        }
        break;
      }
      case 'grab': {
        // both hands sweep up to seize the ears
        const p = smooth(Math.min(1, this.t / 0.5));
        this._setArm(this.grip,
          [lerp(-0.06, -0.5, p), lerp(-0.5, 0.1, p), lerp(-0.9, -1.0, p)],
          [lerp(-0.9, 0.1, p), 0.5, lerp(0.35, 0.7, p)]);
        this._setArm(this.free,
          [lerp(0.5, 0.5, p), lerp(-0.62, 0.1, p), lerp(-0.66, -1.0, p)],
          [lerp(0.15, 0.1, p), -0.5, lerp(-0.2, -0.7, p)]);
        this.face.position.set(0, 0.06, -1.16);
        if (this.t >= 0.5) { this.state = 'pull'; this.t = 0; this.faceMat.map = BARER.atk1; this.faceMat.needsUpdate = true; }
        break;
      }
      case 'pull': {
        // wrench the ears apart — the face stretches horizontally, wobbling, until it goes
        const dur = 0.8, p = Math.min(1, this.t / dur);
        const e = p * p; // accelerate
        const wob = Math.sin(time * 40) * 0.03 * p;
        this._setArm(this.grip, [lerp(-0.5, -1.25, e), 0.1 + wob, -1.0], [0.1, 0.5, 0.7]);
        this._setArm(this.free, [lerp(0.5, 1.25, e), 0.1 - wob, -1.0], [0.1, -0.5, -0.7]);
        this.face.scale.set(this._faceBaseScale.x * (1 + e * 2.4), this._faceBaseScale.y * (1 - e * 0.25), 1);
        this.face.position.y = 0.06 + wob;
        this.face.rotation.z = Math.sin(time * 30) * 0.05 * p;
        if (p > 0.55) { this.faceMat.map = BARER.atk2; this.faceMat.needsUpdate = true; }
        this.faceMat.color.setRGB(1, lerp(1, 0.5, e), lerp(1, 0.5, e));
        if (this.t >= dur) { this.state = 'boom'; this.t = 0; this._boom(); }
        break;
      }
      case 'boom': {
        this._updateShards(dt);
        if (this.t >= 0.95) { this.state = 'done'; if (this.onDone) this.onDone(); }
        break;
      }
      default: break;
    }
  }

  // ---- the explosion -------------------------------------------------------
  _boom() {
    this.face.visible = false;
    // hands fling outward and vanish
    this.grip.visible = false; this.free.visible = false;
    this.player.shake = Math.min(1.4, this.player.shake + 1.0);
    this.audio.splat();
    this.audio.enemyDie(0.7);
    if (this.ui.damageFlash) this.ui.damageFlash(0.55);

    // gib shower: pink/red flesh bits + a couple dark specks (glasses/beard)
    const colors = [0xd98b6a, 0xc25a4a, 0xe0a58a, 0xb03a2e, 0xf0c4a8, 0x201a16];
    const cx = this.face.position.x, cy = this.face.position.y, cz = this.face.position.z;
    for (let i = 0; i < 30; i++) {
      const c = colors[(Math.random() * colors.length) | 0];
      const m = new THREE.Mesh(this._shardGeo,
        new THREE.MeshBasicMaterial({ color: c, transparent: true, side: THREE.DoubleSide }));
      const s = 0.5 + Math.random() * 1.3;
      m.scale.setScalar(s);
      m.position.set(cx + (Math.random() - 0.5) * 0.3, cy + (Math.random() - 0.5) * 0.4, cz);
      this.rig.add(m);
      const ang = Math.random() * Math.PI * 2, spd = 1.6 + Math.random() * 3.2;
      this.shards.push({
        mesh: m, mat: m.material,
        vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd + 1.4, vz: 1.0 + Math.random() * 2.0,
        spin: (Math.random() - 0.5) * 20, life: 0.7 + Math.random() * 0.4, age: 0,
      });
    }
  }

  _updateShards(dt) {
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i];
      s.age += dt;
      s.vy -= 6.5 * dt;
      s.mesh.position.x += s.vx * dt; s.mesh.position.y += s.vy * dt; s.mesh.position.z += s.vz * dt;
      s.mesh.rotation.z += s.spin * dt; s.mesh.rotation.x += s.spin * 0.5 * dt;
      s.mat.opacity = Math.max(0, 1 - s.age / s.life);
      if (s.age >= s.life) { this.rig.remove(s.mesh); s.mat.dispose(); this.shards.splice(i, 1); }
    }
  }

  _clearShards() {
    for (const s of this.shards) { if (this.rig) this.rig.remove(s.mesh); s.mat.dispose(); }
    this.shards.length = 0;
  }
}
