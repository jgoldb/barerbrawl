// The chavrusa cut-scene — plays once, after the SECOND boss hall is cleared.
//
// A tall book-lined study room, a large backlit stained-glass window on each wall but
// the door. Rabbi Zehnwirth and Chaim Barer sit across a small table, learning: both
// shuckle gently, and the rabbi punctuates his points with the "Gemara thumb" (a scoop
// of the air). The sugya is din rodef / "ha-ba l'horgecha, hashkem l'horgo" (Sanhedrin
// 72a) — a narrow law of self-defence that the rabbi twists into a doctrine of holy,
// pre-emptive violence, brainwashing Barer. Barer pushes back but is intellectually
// outmatched; the rabbi crushes him with a fiery takedown. Barer sits stunned — and then
// the door bursts open: a bachur cries that an intruder is going room to room beating the
// kugel out of every bochur. Both rise; Barer vows to meet the threat and gives his life
// to the Satan. Fade out into the game.
//
// Built as its OWN THREE.Scene like the dvar-torah set-piece. IMPORTANT: Barer's face is a
// camera-facing photo billboard, which only looks right seen from the front. So each frame
// we measure the camera against his facing: front-on → show the billboard (+ hide the
// sculpted head); side/behind → hide the billboard and show a sculpted head with blond hair
// and beard matching the photo, so his head never appears unnaturally spun toward the lens.
import * as THREE from 'three';
import { MAT, COAT_COLORS, SKIN_TONES, BEARD_TONES, BARER } from './assets.js';
import { WALL_T } from './mapgen.js';
import * as Props from './props.js';
import { buildCharacter, sitPose, SIT_HIP_Y } from './characters.js';

const lerp = (a, b, t) => a + (b - a) * t;
const damp = (cur, tgt, dt, rate) => cur + (tgt - cur) * Math.min(1, dt * rate);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
// scratch for the face-billboard roll calc (head vs camera orientation, per frame)
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _n1 = new THREE.Vector3(), _n2 = new THREE.Vector3(), _n3 = new THREE.Vector3();

// ---- layout ------------------------------------------------------------------
const HW = 5;                 // walls at x = ±HW
const HZ = 5;                 // walls at z = ±HZ
const H = 6.6;                // tall ceiling
const INNER_X = HW - WALL_T / 2, INNER_Z = HZ - WALL_T / 2;
const BARER_Z = 1.3, ZEHN_Z = -1.3;   // they sit across the table (Barer faces -Z, rabbi +Z)
const BLOND_HAIR = 0xd4b25e, BLOND_BEARD = 0xbf9a48;
const FACE_H = 0.94, FACE_ASPECT = BARER.aspect;
// the head (neck) joint sits ~this far below the face centre; the billboard anchors on the
// live head world position + this lift so it bobs with the shuckle yet stays above the collar
const FACE_Y_OFFSET = 0.20;

export class ChavrusaScene {
  constructor(ui, audio) {
    this.ui = ui; this.audio = audio;
    this.built = false;
    this.camera = null;
    this.gemara = 0;       // rabbi Gemara-thumb emphasis (0..1)
    this.phase = 'learn';  // learn | stunned | alarm | devote
    this.riseT = 0; this._riseGoal = 0;   // seated(0) -> standing(1)
    this.doorT = 0; this._doorGoal = 0;   // shut(0) -> flung open(1)
    this.bachurT = 0;                     // bachur run-in progress
    this.sway = 1;                        // global shuckle amplitude (drops when stunned/alarmed)
    this._barerHeadYaw = 0; this._zehnHeadYaw = 0; this._zehnBodyYaw = 0;
  }

  // ---------------------------------------------------------------- build
  build() {
    if (this.built) return;
    this.scene = new THREE.Scene();
    this.group = new THREE.Group(); this.scene.add(this.group);
    this._disposables = []; this._charMats = [];
    this.lights = []; this.flames = [];

    this.scene.background = new THREE.Color(0x0a0806);
    this.scene.fog = new THREE.FogExp2(0x1a130a, 0.018);
    this.ambient = new THREE.AmbientLight(0x4a3a26, 0.5); this.scene.add(this.ambient);
    this.hemi = new THREE.HemisphereLight(0x6a5a3a, 0x120c06, 0.45); this.scene.add(this.hemi);

    const wide = HW * 2, deep = HZ * 2;
    // floor + ceiling
    const floor = this._planeXZ(wide, deep, this._surf(MAT.floor, wide / 3.6, deep / 3.6), true);
    floor.position.set(0, 0, 0); this.group.add(floor);
    const ceil = this._planeXZ(wide, deep, this._surf(MAT.ceiling, wide / 3.6, deep / 3.6), false);
    ceil.position.set(0, H, 0); this.group.add(ceil);
    // walls
    this._wall(wide + WALL_T * 2, H, WALL_T, 0, H / 2, -HZ, this._surf(MAT.wallWarm, wide / 3.6, H / 3.4));
    this._wall(wide + WALL_T * 2, H, WALL_T, 0, H / 2, HZ, this._surf(MAT.wallWarm, wide / 3.6, H / 3.4));
    this._wall(WALL_T, H, deep, -HW, H / 2, 0, this._surf(MAT.wallWarm, deep / 3.6, H / 3.4));
    this._wall(WALL_T, H, deep, HW, H / 2, 0, this._surf(MAT.wallWarm, deep / 3.6, H / 3.4));

    // stained-glass windows on three walls (not the +X door wall); each with a soft
    // coloured backlight spilling into the room
    const winW = 2.6, winH = 4.2;
    const placeWindow = (x, z, rotY, lightX, lightZ) => {
      const win = Props.stainedGlassWindow(winW, winH);
      win.position.set(x, 1.0, z); win.rotation.y = rotY; this.group.add(win);
      this._disposables.push(win.userData._mat, win.userData._tex);
      this._addLight(0x9fb0e0, 3.2, 7, lightX, 3.0, lightZ, false);   // cool daylight spill
      return win;
    };
    placeWindow(-INNER_X + 0.02, 0, Math.PI / 2, -INNER_X + 0.6, 0);     // -X wall
    placeWindow(0, -INNER_Z + 0.02, 0, 0, -INNER_Z + 0.6);              // -Z wall
    placeWindow(0, INNER_Z - 0.02, Math.PI, 0, INNER_Z - 0.6);          // +Z wall

    // the door on the +X (entrance) wall — dim light leaks around it
    const door = Props.studyDoor(1.6, 3.4);
    door.position.set(INNER_X - 0.02, 0, 0.4); door.rotation.y = -Math.PI / 2; // faces into the room (-X)
    this.group.add(door);
    this.door = door.userData.pivot;
    this._doorLight = this._addLight(0xffcaa0, 0.6, 5, INNER_X - 0.8, 2.4, 0.4, false);

    // bookshelves flanking the walls
    const shelf = (x, z, rotY) => {
      const bs = Props.bookshelf(2.2, 5.0);
      bs.position.set(x, 0, z); bs.rotation.y = rotY; this.group.add(bs);
    };
    for (const z of [-3.2, 3.2]) { shelf(-INNER_X + 0.26, z, Math.PI / 2); shelf(INNER_X - 0.26, z, -Math.PI / 2); }
    for (const x of [-3.2, 3.2]) { shelf(x, -INNER_Z + 0.26, 0); shelf(x, INNER_Z - 0.26, Math.PI); }

    // chandelier + warm key over the table
    const ch = Props.chandelier(8, 0.95); ch.position.set(0, H - 1.2, 0); this.group.add(ch);
    this.flames.push(...ch.userData.flames);
    this._addLight(0xffcf82, 13, 20, 0, H - 1.5, 0);
    this._addLight(0xffdca0, 6, 8, 0, 2.4, 0);          // warm glow right over the table

    // ---- the table they learn at (books + candles baked into studyTable) ----
    const table = Props.studyTable(1.9, 1.15);
    table.position.set(0, 0, 0); this.group.add(table);
    table.traverse((o) => { if (o.userData && o.userData.flames) this.flames.push(...o.userData.flames); });

    // ---- Rabbi Zehnwirth (faces +Z toward Barer) ----
    const chairZ = Props.chair(); chairZ.position.set(0, 0, ZEHN_Z - 0.35); chairZ.rotation.y = 0; this.group.add(chairZ);
    this.zehn = this._seat({ coat: 0x0b0b12, skin: 0xbe9068, beard: 0xd7cfbe, hat: 'homburg', bigBeard: true, glasses: true }, 0, ZEHN_Z, 0, false);
    this._addGemaraThumb(this.zehn);

    // ---- Chaim Barer (faces -Z toward the rabbi) — blond, with the head-swap rig ----
    const chairB = Props.chair(); chairB.position.set(0, 0, BARER_Z + 0.35); chairB.rotation.y = Math.PI; this.group.add(chairB);
    this.barer = this._seat({ coat: 0x101018, skin: 0xd8b48a, beard: BLOND_BEARD, hat: 'none', bigBeard: false, glasses: true }, 0, BARER_Z, Math.PI, true);

    // ---- the bachur who bursts in (hidden at the door until the alarm) ----
    this.bachur = { ...this._char({ coat: pick(COAT_COLORS), skin: pick(SKIN_TONES), beard: pick(BEARD_TONES), hat: 'fedora', bigBeard: false, glasses: false }) };
    this.bachur.root.position.set(INNER_X - 0.5, 0, 0.4);
    this.bachur.root.rotation.y = -Math.PI / 2;   // faces -X, into the room
    this.bachur.root.visible = false;
    this.group.add(this.bachur.root);
    this._charMats.push(...Object.values(this.bachur.root.userData.mats));

    this.built = true;
  }

  _char(opts) { const b = buildCharacter(opts); return { root: b.root, joints: b.joints }; }

  // seat a learner at (x,z) facing yaw; `isBarer` adds the blond hair + photo-billboard swap
  _seat(opts, x, z, yaw, isBarer) {
    const b = buildCharacter(opts);
    b.root.position.set(x, 0, z); b.root.rotation.y = yaw;
    sitPose(b.joints);
    this.group.add(b.root);
    this._charMats.push(...Object.values(b.root.userData.mats));
    const actor = { root: b.root, joints: b.joints, headAnchor: b.joints.head, phase: Math.random() * 6.28 };
    if (isBarer) {
      // blond hair so the back/side of his head matches the photo
      this._addHair(b.joints.head, b.root.userData.mats.skin);
      // camera-facing photo billboard (front only). Kept depth-tested + pushed toward the
      // camera each frame (like the in-game Barer) so the table/rabbi still occlude it but
      // his own coat collar can't clip the bottom of his face.
      const mat = new THREE.SpriteMaterial({ map: BARER.def, transparent: true, depthWrite: false });
      const spr = new THREE.Sprite(mat); spr.scale.set(FACE_H * FACE_ASPECT, FACE_H, 1);
      spr.position.set(0, 1.6, 0); spr.renderOrder = 6; spr.visible = false;
      b.root.add(spr);
      this._disposables.push(mat);
      actor.faceSprite = spr; actor.showFace = false;
    }
    return actor;
  }

  // a blond hair cap + back-of-head fill on the sculpted head (front features stay bare)
  _addHair(headGroup, skinMat) {
    const mat = new THREE.MeshStandardMaterial({ color: BLOND_HAIR, roughness: 0.9 });
    this._charMats.push(mat);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.205, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.6), mat);
    cap.scale.set(1.06, 1.0, 1.1); cap.position.set(0, 0.14, -0.02); headGroup.add(cap);
    const back = new THREE.Mesh(new THREE.SphereGeometry(0.185, 12, 12), mat);
    back.scale.set(1.0, 0.92, 0.72); back.position.set(0, 0.12, -0.085); headGroup.add(back);
  }

  // a stubby thumb on the rabbi's right hand so the "Gemara thumb" reads
  _addGemaraThumb(actor) {
    const skinMat = actor.root.userData.mats.skin;
    const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.028, 0.07, 4, 8), skinMat);
    thumb.position.set(0.05, 0.05, 0.03); thumb.rotation.z = -0.4;
    actor.joints.handR.add(thumb);
  }

  // ---------------------------------------------------------------- animation
  setGemara(v) { this._gemaraGoal = v; }
  setStunned() { this.phase = 'stunned'; this._swayGoal = 0.25; }
  alarm() {
    this.phase = 'alarm';
    this._riseGoal = 1; this._doorGoal = 1; this._swayGoal = 0.2;
    this._barerHeadTgt = -0.55; this._zehnBodyTgt = 1.0;   // both snap toward the door (+X)
    this.audio.gate && this.audio.gate(false);
    this.audio.hit && this.audio.hit(true, 0.5);           // the door slamming open
  }
  devote() {
    this.phase = 'devote';
    this._barerHeadTgt = 0.0;      // Barer turns back to face the rabbi
    this._zehnBodyTgt = 0.4; this._zehnHeadTgt = -0.4;   // rabbi half-turns back to Barer
  }

  update(dt, time) {
    if (!this.built) return;
    // candle flicker
    for (const e of this.lights) { const f = 0.84 + 0.16 * Math.sin(time * e.speed + e.phase); e.light.intensity = e.base * f; }
    for (const fl of this.flames) fl.scale.y = 0.85 + 0.3 * Math.sin(time * 11 + fl.position.x * 3);

    // ease the driven values
    this.gemara = damp(this.gemara, this._gemaraGoal ?? 0, dt, 6);
    this.sway = damp(this.sway, this._swayGoal ?? 1, dt, 4);
    this.riseT = damp(this.riseT, this._riseGoal, dt, 7);
    this.doorT = damp(this.doorT, this._doorGoal, dt, 6);
    this._barerHeadYaw = damp(this._barerHeadYaw, this._barerHeadTgt ?? 0, dt, 7);
    this._zehnBodyYaw = damp(this._zehnBodyYaw, this._zehnBodyTgt ?? 0, dt, 6);
    this._zehnHeadYaw = damp(this._zehnHeadYaw, this._zehnHeadTgt ?? 0, dt, 6);
    if (this.phase === 'alarm' || this.phase === 'devote') this.bachurT = Math.min(1, this.bachurT + dt * 1.1);

    // door + its light
    if (this.door) this.door.rotation.y = -1.95 * this.doorT;
    if (this._doorLight) this._doorLight.light.intensity = 0.6 + 2.4 * this.doorT;

    this._poseLearner(this.zehn, time, false);
    this._poseLearner(this.barer, time, true);
    this._zehn = this.zehn; // (readability)
    // the rabbi turns his whole body toward the door on the alarm
    this.zehn.root.rotation.y = this._zehnBodyYaw;
    this.barer.joints.head.rotation.y = this._barerHeadYaw + Math.sin(time * 1.6 + 1.0) * 0.03 * this.sway;

    if (this.bachur.root.visible || this.bachurT > 0) this._runBachur(time);
    this._updateBarerHead();
  }

  // shared shuckle + arm pose; the rabbi additionally does the Gemara-thumb scoop
  _poseLearner(a, time, isBarer) {
    const j = a.joints, t = this.riseT, s = this.sway;
    // legs/hips: seated -> standing
    j.hips.position.y = lerp(SIT_HIP_Y, 0.82, t);
    j.thighL.rotation.set(lerp(-1.15, -0.05, t), 0, 0.06 * (1 - t));
    j.thighR.rotation.set(lerp(-1.15, -0.05, t), 0, -0.06 * (1 - t));
    j.kneeL.rotation.x = lerp(1.4, 0.1, t); j.kneeR.rotation.x = lerp(1.4, 0.1, t);
    // torso shuckle (davening sway), calmer as they stand/are stunned
    const sway = (Math.sin(time * 2.1 + a.phase) * 0.13 + Math.sin(time * 1.1 + a.phase) * 0.05) * s;
    j.torso.rotation.x = 0.14 * (1 - t) + sway * (1 - 0.4 * t);
    j.torso.rotation.z = Math.sin(time * 1.5 + a.phase) * 0.03 * s;
    if (!isBarer) j.head.rotation.x = 0.1 + Math.sin(time * 2.1 + a.phase + 0.4) * 0.07 * s;
    else j.head.rotation.x = 0.06 + Math.sin(time * 2.1 + a.phase) * 0.05 * s;

    // arms: hands resting forward on the table when seated, dropping to the sides standing
    const shX = lerp(0.55, 0.12, t), elX = lerp(-1.0, -0.35, t);
    j.shoulderL.rotation.set(shX, 0, 0.2); j.elbowL.rotation.x = elX;
    j.shoulderR.rotation.set(shX, 0, -0.2); j.elbowR.rotation.x = elX;

    if (!isBarer && this.gemara > 0.01) {
      // the right hand lifts to chest height, thumb up, and scoops the air on the beat
      const g = this.gemara, scoop = 0.5 + 0.5 * Math.sin(time * 3.4);
      j.shoulderR.rotation.x = lerp(shX, 0.98, g);          // raise the upper arm forward
      j.shoulderR.rotation.z = lerp(-0.2, -0.5, g);         // and inward
      j.shoulderR.rotation.y = 0.3 * g * Math.sin(time * 3.4);
      j.elbowR.rotation.x = lerp(elX, -1.95 - 0.35 * scoop, g);   // fold the forearm up, scooping
    }
  }

  _runBachur(time) {
    const b = this.bachur; b.root.visible = true;
    const t = this.bachurT;
    // run from the door to just short of the table
    b.root.position.set(lerp(INNER_X - 0.5, 2.3, t), 0, lerp(0.4, 0.1, t));
    if (t < 0.98) {
      const sw = Math.sin(time * 14) * 0.7;   // pumping legs
      b.joints.thighL.rotation.x = sw; b.joints.thighR.rotation.x = -sw;
      b.joints.shoulderL.rotation.x = -sw * 0.6; b.joints.shoulderR.rotation.x = sw * 0.6;
      b.joints.torso.rotation.x = 0.2;
    } else {
      // skids to a halt, breathless, arms out in alarm
      b.joints.thighL.rotation.x = 0.1; b.joints.thighR.rotation.x = -0.1;
      b.joints.shoulderL.rotation.set(-0.5, 0, 0.5); b.joints.shoulderR.rotation.set(-0.5, 0, -0.5);
      b.joints.elbowL.rotation.x = -0.9; b.joints.elbowR.rotation.x = -0.9;
      b.joints.torso.rotation.x = 0.12 + Math.sin(time * 8) * 0.04;   // panting
    }
  }

  // front-on → photo billboard; side/behind → sculpted blond head (with hysteresis)
  _updateBarerHead() {
    const b = this.barer, cam = this.camera;
    if (!b || !cam) return;
    b.headAnchor.getWorldPosition(_v1);
    cam.getWorldPosition(_v2);
    const faceYaw = b.root.rotation.y + b.joints.head.rotation.y;
    const fx = Math.sin(faceYaw), fz = Math.cos(faceYaw);
    const dx = _v2.x - _v1.x, dz = _v2.z - _v1.z, len = Math.hypot(dx, dz) || 1;
    const dot = (dx / len) * fx + (dz / len) * fz;   // >0 → camera is in front of his face
    if (b.showFace) { if (dot < 0.4) b.showFace = false; }
    else if (dot > 0.62) b.showFace = true;
    b.joints.head.visible = !b.showFace;
    b.faceSprite.visible = b.showFace;
    if (b.showFace) this._placeFace(b, cam);
  }

  // push the billboard well toward the camera so his own coat collar can't clip his chin,
  // while staying depth-tested so the rabbi / table still occlude it in over-shoulder shots.
  // Anchored to the head joint's LIVE world transform so the face bobs and tilts with the
  // shuckle — otherwise the flat billboard hangs rigid while the sculpted body sways beneath.
  _placeFace(b, cam) {
    // live head (neck-joint) world position, lifted to the face centre; it already carries
    // the torso shuckle (forward/back bob) and the seated→standing rise, so no manual faceY.
    b.headAnchor.getWorldPosition(_v1);
    _v1.y += FACE_Y_OFFSET;
    cam.getWorldPosition(_v2);
    const dx = _v2.x - _v1.x, dy = _v2.y - _v1.y, dz = _v2.z - _v1.z;
    const dist = Math.hypot(dx, dy, dz) || 1, push = Math.min(0.4, dist * 0.5), k = (dist - push) / dist;
    _v3.set(_v1.x + dx / dist * push, _v1.y + dy / dist * push, _v1.z + dz / dist * push);
    b.faceSprite.position.copy(b.root.worldToLocal(_v3));
    b.faceSprite.scale.set(FACE_H * FACE_ASPECT * k, FACE_H * k, 1);
    // Roll the flat sprite to match the head's tilt: measure the head's up-axis against the
    // camera's screen axes so the face rocks side-to-side on the same axis as the upper body,
    // rather than staying stubbornly upright while he shuckles.
    b.headAnchor.getWorldQuaternion(_q1);
    _n1.set(0, 1, 0).applyQuaternion(_q1);          // head up-axis, in world
    cam.getWorldQuaternion(_q2);
    _n2.set(0, 1, 0).applyQuaternion(_q2);          // camera up
    _n3.set(1, 0, 0).applyQuaternion(_q2);          // camera right
    b.faceSprite.material.rotation = -Math.atan2(_n1.dot(_n3), _n1.dot(_n2));
  }

  // ---------------------------------------------------------------- beats
  // NOTE: beat durations are sized from word-count ESTIMATES (the VO clips don't exist yet).
  // Re-check them against the generated clips (npm run gen-vo) — see the beat-duration rule
  // in the project memory.
  beats(camera) {
    this.camera = camera;
    const D = this;
    const bZ = BARER_Z, zZ = ZEHN_Z;
    return [
      { // 1. slow fade in on the stained glass; the rabbi's voice drifts in over it
        duration: 6.0, fade: 'in', vo: 'zehn-1',
        subtitle: 'The Gemara could not be clearer, Chaim.',
        cam: { from: { pos: [-2.3, 2.5, 0.2], look: [-INNER_X, 2.5, 0] }, to: { pos: [-2.7, 2.3, 0.5], look: [-INNER_X, 2.3, -0.2] } },
        onEnter: () => { D.setGemara(0.0); },
      },
      { // 2. sweep off the window to reveal the two of them at the table
        duration: 11.0, vo: 'zehn-2',
        subtitle: 'Ha-ba l’horgecha, hashkem l’horgo — if a man comes to kill you, rise early and kill him first.',
        cam: { from: { pos: [-2.7, 2.3, 0.5], look: [-INNER_X, 2.3, -0.2] }, to: { pos: [3.0, 2.4, 3.2], look: [0, 1.35, -0.2] } },
        onEnter: () => { D.setGemara(0.35); },
      },
      { // 3. settle into a two-shot over Barer's shoulder — both shuckling, learning
        duration: 9.5, vo: 'zehn-3',
        subtitle: 'The Torah does not ask you to wait for the knife. It commands you to see it coming.',
        cam: { from: { pos: [2.2, 1.95, 2.8], look: [0, 1.4, -0.6] }, to: { pos: [1.7, 1.9, 2.4], look: [0, 1.4, -0.8] } },
        onEnter: () => { D.setGemara(0.5); },
      },
      { // 4. frontal on Barer — he questions (billboard face)
        duration: 10.5, vo: 'zehn-4',
        subtitle: 'But Rebbe — the halacha is <i>narrow</i>. A rodef, caught in the very act. There must be certainty. A warning.',
        cam: { from: { pos: [-1.4, 1.62, -0.5], look: [0, 1.4, bZ] }, to: { pos: [-1.0, 1.56, 0.0], look: [0.05, 1.38, bZ] } },
        onEnter: () => { D.setGemara(0.0); },
      },
      { // 5. the rabbi, dismissive — Gemara thumb
        duration: 6.0, vo: 'zehn-5',
        subtitle: 'A warning. You would offer the <i>wolf</i> a warning?',
        cam: { from: { pos: [0.9, 1.62, 1.1], look: [0, 1.5, zZ] }, to: { pos: [0.5, 1.56, 0.7], look: [0, 1.5, zZ] } },
        onEnter: () => { D.setGemara(0.8); },
      },
      { // 6. Barer presses — the poskim, the limits
        duration: 8.5, vo: 'zehn-6',
        subtitle: 'The poskim limit it. Chazal themselves feared the zealot — too eager to spill blood.',
        cam: { from: { pos: [-1.1, 1.6, -0.3], look: [0, 1.4, bZ] }, to: { pos: [-0.7, 1.55, 0.1], look: [0, 1.4, bZ] } },
        onEnter: () => { D.setGemara(0.0); },
      },
      { // 7. the rabbi's big point — Pinchas — a slow push, thumb driving
        duration: 17.0, vo: 'zehn-7',
        subtitle: 'Chazal feared the <b>lazy</b>, Chaim — not the zealous. Pinchas convened no beis din. He saw the desecration, and he <b>struck</b>. And the Ribono shel Olam called it a covenant of peace.',
        cam: { from: { pos: [1.0, 1.7, 1.0], look: [0, 1.5, zZ] }, to: { pos: [0.4, 1.55, -0.1], look: [0, 1.52, zZ - 0.05] } },
        onEnter: () => { D.setGemara(1.0); },
      },
      { // 8. Barer falters — who am I?
        duration: 7.5, vo: 'zehn-8',
        subtitle: 'But that was Pinchas. One man, one moment. Who am <i>I</i> to decide?',
        cam: { from: { pos: [-1.7, 1.7, -0.6], look: [0, 1.4, bZ] }, to: { pos: [-1.4, 1.62, -0.3], look: [0, 1.38, bZ] } },
        onEnter: () => { D.setGemara(0.0); },
      },
      { // 9. the takedown begins — push hard on the rabbi
        duration: 11.5, vo: 'zehn-9',
        subtitle: 'Who are <b>you</b>? A soldier who dresses his cowardice as piety! While you weigh the limits, the rodef already walks these halls.',
        cam: { from: { pos: [0.7, 1.45, 0.5], look: [0, 1.55, zZ] }, to: { pos: [0.25, 1.42, -0.2], look: [0, 1.58, zZ] } },
        onEnter: () => { D.setGemara(0.9); },
      },
      { // 10. the fiery climax — close on the rabbi
        duration: 16.5, vo: 'zehn-10',
        subtitle: 'He wears his hunger like a talis — and you would beg him for a <i>warning</i>?! There is no warning. There is the one who <b>strikes</b>, and the one who is struck. Choose what you are.',
        cam: { from: { pos: [0.25, 1.55, -0.35], look: [0, 1.55, zZ] }, to: { pos: [0.12, 1.53, -0.65], look: [0, 1.55, zZ - 0.05] } },
        onEnter: () => { D.setGemara(1.0); },
      },
      { // 11. land on Barer — stunned into silence, digesting; then hold
        duration: 8.5, vo: 'zehn-11',
        subtitle: '…I understand, Rebbe.',
        cam: { from: { pos: [-0.9, 1.5, 0.2], look: [0, 1.4, bZ] }, to: { pos: [-0.7, 1.48, 0.45], look: [0, 1.4, bZ] } },
        onEnter: () => { D.setGemara(0.0); D.setStunned(); },
      },
      { // 12. the door bursts open — the bachur runs in; both rise, startled
        duration: 13.5, vo: 'zehn-12',
        subtitle: 'Rebbe Zehnwirth! Come quick — a madman in the yeshiva! Room to room, he’s beating the kugel out of every bachur — no one can stop him!',
        cam: { from: { pos: [-2.7, 2.5, 2.6], look: [1.6, 1.7, 0] }, to: { pos: [-2.3, 2.3, 1.9], look: [2.4, 1.6, -0.1] } },
        onEnter: () => { D.alarm(); },
      },
      { // 13. Barer turns to the rabbi and gives himself to the Satan. Over the rabbi's
        // shoulder so Zehnwirth is in frame while Barer's photo face addresses him.
        duration: 12.5, vo: 'zehn-13',
        subtitle: 'Stay, Rebbe. I will meet him myself. My life, my soul — I give them to the <b>Satan</b>. Let him move my hands.',
        cam: { from: { pos: [1.5, 1.95, -2.7], look: [0.1, 1.8, bZ] }, to: { pos: [1.12, 1.9, -2.0], look: [0.1, 1.78, bZ] } },
        onEnter: () => { D.devote(); },
      },
      { // 14. hold, then fade to black — hand back to the game
        duration: 2.6, fade: 'out', fadeDur: 1.3,
        cam: { from: { pos: [1.12, 1.9, -2.0], look: [0.1, 1.78, bZ] }, to: { pos: [1.0, 1.9, -1.75], look: [0.1, 1.78, bZ] } },
      },
    ];
  }

  // ---------------------------------------------------------------- helpers
  _surf(baseMat, rx, ry) {
    const m = baseMat.clone();
    if (baseMat.map) { m.map = baseMat.map.clone(); m.map.needsUpdate = true; m.map.wrapS = m.map.wrapT = THREE.RepeatWrapping; m.map.repeat.set(rx, ry); this._disposables.push(m.map); }
    this._disposables.push(m); return m;
  }
  _planeXZ(w, d, mat, up) { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat); m.rotation.x = up ? -Math.PI / 2 : Math.PI / 2; m.receiveShadow = true; return m; }
  _wall(w, h, d, x, y, z, mat) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.receiveShadow = true; this.group.add(m); return m; }
  _addLight(color, intensity, dist, x, y, z, flicker = true) {
    const L = new THREE.PointLight(color, intensity, dist, 2); L.position.set(x, y, z); this.scene.add(L);
    const e = { light: L, base: intensity, phase: Math.random() * 6.28, speed: flicker ? 6 + Math.random() * 4 : 0 };
    this.lights.push(e); return e;
  }

  dispose() {
    if (!this.built) return;
    this.group.traverse((o) => { if (o.isMesh && o.geometry && !o.geometry.userData.shared) o.geometry.dispose(); });
    for (const m of this._disposables) { if (m) m.dispose(); }
    for (const m of this._charMats) { if (m) m.dispose(); }
    this.scene = null; this.group = null; this.built = false;
    this.lights = []; this.flames = []; this.camera = null;
    this.barer = this.zehn = this.bachur = this.door = null;
  }
}
