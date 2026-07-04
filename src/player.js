// First-person player: camera rig, view-model fists, movement, combat, health.
import * as THREE from 'three';
import { buildFists } from './characters.js';
import { resolveCircle, surfaceHeight } from './collide.js';

const EYE = 1.66;
// How far above the feet a ledge may be to still count as walk-over / land-on. Small,
// so benches (0.55) and tables (0.96) each need a real jump, but landings are forgiving.
const STEP_CLEAR = 0.15;
// Backpedalling (holding S) is slower than moving forward or strafing: at a full
// straight retreat the speed is scaled to this fraction, blended for diagonal back-steps.
const BACKPEDAL = 0.55;
// A punch that lands in the enemy's head band (see Enemy.headY/headR) hits this much harder.
const HEADSHOT_MULT = 1.8;

export class Player {
  constructor() {
    this.camera = new THREE.PerspectiveCamera(76, 1, 0.04, 70);
    this.camera.rotation.order = 'YXZ';

    this.pos = { x: 0, z: 0 };
    this.yaw = 0; this.pitch = 0;
    this.radius = 0.4;
    this.speed = 4.4; this.sprintSpeed = 6.6;

    // vertical state: yOff is the feet height above the floor (0 = ground, 0.55 = on a
    // bench, 0.96 = on a table). vel is the horizontal velocity, preserved through jumps.
    this.yOff = 0; this.vy = 0; this.grounded = true;
    this.jumpVel = 5.8; this.gravity = 22;
    this.vel = { x: 0, z: 0 };

    this.maxHp = 100; this.hp = 100;
    this.dead = false;
    this.invuln = 0;
    this.sinceDamage = 99;

    this.bob = 0; this.bobActive = 0;
    this.shake = 0; this.pitchPunch = 0; this.recoil = 0;
    this._deadT = 0;

    // combat
    this.attack = null;             // {type, t, dur, strikeAt, hand, dealt}
    this.nextHand = 'right';
    this.combo = 0; this.comboTimer = 0;
    this.heavyCd = 0;               // haymaker is a committed swing — locked out after each one
    this.shoveCd = 0;
    this.shove = null;              // {t, dur, strikeAt, dealt} — two-handed push
    this.buffered = null;

    // fists view-model, rendered in a SEPARATE scene/pass so the detailed hands
    // self-occlude correctly (proper depth among their own parts) yet still draw
    // over the world. Own lights keep them lit consistently as the camera moves.
    const f = buildFists();
    this.fists = f.root; this.fistL = f.left; this.fistR = f.right;
    this.fists.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });

    this.viewScene = new THREE.Scene();
    this.viewRig = new THREE.Group();
    this.viewScene.add(this.viewRig);
    this.viewRig.add(this.fists);
    this.viewRig.add(new THREE.HemisphereLight(0xffe9c8, 0x2a2018, 0.9));
    const vKey = new THREE.DirectionalLight(0xfff0d2, 1.8);
    vKey.position.set(-0.6, 1.0, 0.3); vKey.target.position.set(0, -0.3, -0.6);
    this.viewRig.add(vKey, vKey.target);
    const vRim = new THREE.DirectionalLight(0xffb060, 0.55);
    vRim.position.set(0.8, 0.1, -1.0); vRim.target.position.set(0, -0.2, -0.5);
    this.viewRig.add(vRim, vRim.target);

    // rest transforms (both position AND rotation, so the baked pose survives animation)
    this._restL = this.fistL.position.clone();
    this._restR = this.fistR.position.clone();
    this._restRotL = this.fistL.rotation.clone();
    this._restRotR = this.fistR.rotation.clone();

    // a soft warm fill light following the player
    this.torch = new THREE.PointLight(0xffd9a0, 6, 9, 2);
    this.torch.position.set(0, -0.2, 0.4);
    this.camera.add(this.torch);

    // callbacks (wired by game)
    this.onHit = null;      // (info)
    this.onKill = null;     // (info)
    this.onDamage = null;   // (info)
    this.onCombo = null;    // (n)
    this.onDeath = null;
    this._footPhase = 0;   // continuous stride phase (wraps at 2π, seamless for sin/cos)
    this._stepPhase = 0;   // separate accumulator for footstep sfx (two steps per stride)
    this._moving = false;
  }

  spawn(x, z, yaw) {
    this.pos.x = x; this.pos.z = z; this.yaw = yaw; this.pitch = 0;
    this.hp = this.maxHp; this.dead = false; this.invuln = 0; this.sinceDamage = 99;
    this.combo = 0; this.attack = null; this.shove = null; this.shake = 0; this._deadT = 0;
    this.yOff = 0; this.vy = 0; this.grounded = true; this.vel.x = 0; this.vel.z = 0;
    this._sync();
  }

  _sync() {
    this.camera.position.set(this.pos.x, EYE, this.pos.z);
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
  }

  look(dx, dy, sens) {
    this.yaw -= dx * sens;
    this.pitch -= dy * sens;
    const lim = Math.PI / 2 - 0.08;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  forwardXZ() { return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) }; }
  rightXZ() { return { x: Math.cos(this.yaw), z: -Math.sin(this.yaw) }; }

  takeDamage(dmg, srcPos) {
    if (this.dead || this.invuln > 0) return;
    this.hp -= dmg;
    this.invuln = 0.45;
    this.sinceDamage = 0;
    this.shake = Math.min(1.2, this.shake + 0.6 + dmg * 0.02);
    if (srcPos) {
      const dx = this.pos.x - srcPos.x, dz = this.pos.z - srcPos.z, d = Math.hypot(dx, dz) || 1;
      this.pos.x += (dx / d) * 0.25; this.pos.z += (dz / d) * 0.25;
    }
    if (this.onDamage) this.onDamage({ dmg, hp: this.hp });
    if (this.hp <= 0) { this.hp = 0; this.dead = true; if (this.onDeath) this.onDeath(); }
  }

  heal(a) { this.hp = Math.min(this.maxHp, this.hp + a); }

  // A gabbai/mashgiach heaves the player off a perch: launch up and away from the
  // shover so they're thrown clear of the furniture and dumped back onto the floor,
  // plus a little damage. Airborne velocity is preserved by update() (no air control),
  // so the outward push carries them past the table edge before gravity lands them.
  knockOff(fromPos, force = 1, dmg = 0) {
    if (this.dead) return;
    this.grounded = false;
    this.vy = Math.max(this.vy, 3.8 * force);
    const dx = this.pos.x - fromPos.x, dz = this.pos.z - fromPos.z;
    const d = Math.hypot(dx, dz) || 1;
    const push = 6.8 * force;
    this.vel.x = (dx / d) * push; this.vel.z = (dz / d) * push;
    this.shake = Math.min(1.2, this.shake + 0.5);
    if (dmg > 0) this.takeDamage(dmg, fromPos);
  }

  startAttack(type) {
    if (this.dead) return;
    if (this.attack) {
      // buffer the next light attack for a combo
      if (type === 'light' && this.attack.t / this.attack.dur > 0.45) this.buffered = 'light';
      return;
    }
    const hand = this.nextHand;
    this.nextHand = hand === 'right' ? 'left' : 'right';
    if (type === 'heavy') {
      // slow, telegraphed hook: long to wind up and recover, then a real cooldown on top
      this.attack = { type, t: 0, dur: 0.68, strikeAt: 0.34, hand: 'right', dealt: false };
      this.heavyCd = 1.2;
    } else {
      this.attack = { type, t: 0, dur: 0.3, strikeAt: 0.11, hand, dealt: false };
    }
  }

  _resolveAttack(ctx) {
    const heavy = this.attack.type === 'heavy';
    // Haymaker: hits much harder but only in a tight cone dead ahead — one committed target.
    // Jab: quick and a touch wider, but light. Aim high: a hit up around the head does bonus damage.
    const reach = heavy ? 2.6 : 2.25;
    const cosCone = Math.cos(heavy ? 0.42 : 0.62);
    const baseDmg = heavy ? 34 : 11;
    const eyeY = EYE + this.yOff;
    const f = this.forwardXZ();
    let any = false, kills = 0, hitPos = null, anyHead = false, headPos = null;
    for (const e of ctx.enemies) {
      if (e.dead) continue;
      const dx = e.pos.x - this.pos.x, dz = e.pos.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > reach + e.radius) continue;
      const nd = dist || 1;
      const dot = (dx / nd) * f.x + (dz / nd) * f.z;
      if (dot < cosCone) continue;
      // trace where the aim ray passes through the enemy's vertical column: land it near
      // the head (crosshair kept high/level) for a headshot; a body hit is normal damage.
      const aimY = eyeY + dist * Math.tan(this.pitch);
      const head = Math.abs(aimY - e.headY) <= e.headR;
      const res = e.takeHit(head ? baseDmg * HEADSHOT_MULT : baseDmg, this.pos, heavy);
      any = true; hitPos = e.pos;
      if (head) { anyHead = true; headPos = e.pos; }
      ctx.audio.hit(heavy, head ? 1.5 : 1);
      if (res.killed) { kills++; if (this.onKill) this.onKill({ score: res.score, pos: e.pos, type: e.type }); }
    }
    // a punch that reaches a window's glass cracks it (jab) or shatters it (haymaker);
    // a strike on already-cracked glass always shatters. Purely cosmetic — the wall
    // behind stays solid — so it never feeds the combo, just its own contact feedback.
    let hitWindow = false;
    if (ctx.windows) {
      const wReach = reach + 0.3;
      for (const w of ctx.windows) {
        if (w.state === 'shattered') continue;
        const dx = w.center.x - this.pos.x, dz = w.center.z - this.pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist > wReach) continue;
        const nd = dist || 1;
        if ((dx / nd) * f.x + (dz / nd) * f.z < cosCone) continue;
        const aimY = eyeY + dist * Math.tan(this.pitch);
        if (aimY < w.loY - 0.4 || aimY > w.hiY + 0.3) continue;
        if (w.hit(heavy, ctx.audio)) hitWindow = true;
      }
    }
    if (any) {
      this.combo++; this.comboTimer = 2.2;
      ctx.audio.combo(this.combo);
      if (this.onHit) this.onHit({ combo: this.combo, heavy, kills, pos: hitPos, head: anyHead, headPos });
      if (this.onCombo) this.onCombo(this.combo);
      this.recoil = heavy ? 1 : 0.5;
      this.shake = Math.min(1, this.shake + (heavy ? 0.35 : 0.12));
    } else if (hitWindow) {
      // solid contact on glass: a jolt back through the arm, but no combo/whoosh
      this.recoil = Math.max(this.recoil, heavy ? 0.8 : 0.4);
      this.shake = Math.min(1, this.shake + (heavy ? 0.22 : 0.1));
    } else {
      ctx.audio.whoosh(heavy);
    }
  }

  _startShove() {
    if (this.dead || this.shove) return;
    // a slow, heavy heave — long two-handed thrust and a long cooldown
    this.shove = { t: 0, dur: 0.6, strikeAt: 0.38, dealt: false };
    this.shoveCd = 2.4;
  }

  _resolveShove(ctx) {
    ctx.audio.whoosh(true);
    const f = this.forwardXZ();
    let any = false;
    for (const e of ctx.enemies) {
      if (e.dead) continue;
      const dx = e.pos.x - this.pos.x, dz = e.pos.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 3.4 + e.radius) continue;                    // reaches further than a punch
      const nd = dist || 1;
      if ((dx / nd) * f.x + (dz / nd) * f.z < -0.4) continue; // wide arc — catches a whole crowd, not just dead ahead
      e.takeHit(4, this.pos, true);
      e.vel.x += (dx / nd) * 13 * e.arch.knockRes;            // launches them well back to open space
      e.vel.z += (dz / nd) * 13 * e.arch.knockRes;
      if (!e.dead && !e.boss) { e.state = 'stagger'; e.timer = 0.5; }
      any = true;
    }
    // camera nudge from the effort of the push (more when it connects)
    this.recoil = Math.max(this.recoil, any ? 0.6 : 0.35);
    if (any) {
      this.shake = Math.min(1, this.shake + 0.16);
      if (this.onHit) this.onHit({ combo: this.combo, shove: true });
    }
  }

  update(dt, ctx) {
    const inp = ctx.input;
    this.invuln = Math.max(0, this.invuln - dt);
    this.sinceDamage += dt;
    if (this.dead) this._deadT += dt;
    this.heavyCd = Math.max(0, this.heavyCd - dt);
    this.shoveCd = Math.max(0, this.shoveCd - dt);

    // regen slowly when out of combat
    if (!this.dead && this.sinceDamage > 6 && this.hp < this.maxHp) this.hp = Math.min(this.maxHp, this.hp + 3.2 * dt);

    // ---- look
    const md = inp.consumeMouse();
    if (!this.dead) this.look(md.dx, md.dy, inp.sensitivity);

    // ---- movement: on the ground the keys set velocity directly; in the air we keep
    // the take-off velocity (no air control) so a running jump carries its momentum.
    let moving = false;
    if (!this.dead) {
      if (this.grounded) {
        const mv = inp.moveVector();
        if (mv.x || mv.z) {
          const f = this.forwardXZ(), r = this.rightXZ();
          let wx = f.x * (-mv.z) + r.x * mv.x;
          let wz = f.z * (-mv.z) + r.z * mv.x;
          const l = Math.hypot(wx, wz) || 1; wx /= l; wz /= l;
          // slow the retreat: mv.z > 0 means pulling back (S / ArrowDown); scale by how
          // much of the intended direction points backward (1 = straight back, 0 = fwd/strafe)
          const ml = Math.hypot(mv.x, mv.z) || 1;
          const back = Math.max(0, mv.z / ml);
          const dirFactor = 1 - back * (1 - BACKPEDAL);
          const sp = (inp.sprinting() ? this.sprintSpeed : this.speed) * dirFactor;
          this.vel.x = wx * sp; this.vel.z = wz * sp;
          moving = true;
          this.bobActive = Math.min(1, this.bobActive + dt * 5);
          // advance a CONTINUOUS stride phase; wrap at 2π so sin/cos never jump
          const adv = dt * sp * 0.9;
          this._footPhase += adv;
          if (this._footPhase > Math.PI * 2) this._footPhase -= Math.PI * 2;
          this._stepPhase += adv;
          if (this._stepPhase > Math.PI) { this._stepPhase -= Math.PI; ctx.audio.footstep(); }
        } else {
          this.vel.x = 0; this.vel.z = 0;
        }
      }
      // integrate horizontal velocity (airborne keeps its preserved momentum)
      this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
    }
    if (!moving) this.bobActive = Math.max(0, this.bobActive - dt * 5);
    this._moving = moving;

    // horizontal collision — boxes at/under the feet (within STEP_CLEAR) don't block,
    // so once you clear a bench/table top you can move over it and land on it.
    resolveCircle(this.pos, this.radius, ctx.colliders, 3, this.yOff, STEP_CLEAR);

    // ---- vertical: jump, gravity, and resting on furniture surfaces
    if (!this.dead && inp.consumeJump() && this.grounded) {
      this.vy = this.jumpVel; this.grounded = false; ctx.audio.jump();
    }
    const support = surfaceHeight(this.pos.x, this.pos.z, ctx.colliders, this.yOff, STEP_CLEAR);
    if (this.grounded) {
      if (support >= this.yOff - 1e-3) this.yOff = support;        // glue to the surface (and small step-ups)
      else { this.grounded = false; this.vy = 0; }                 // walked off an edge → fall
    } else {
      this.vy -= this.gravity * dt;
      this.yOff += this.vy * dt;
      if (this.vy <= 0 && this.yOff <= support) {                  // fell onto the surface below
        this.yOff = support; this.vy = 0; this.grounded = true;
        if (!this.dead) ctx.audio.land();
      }
    }

    // ---- combat input
    if (!this.dead) {
      if (inp.consumeLight()) this.startAttack('light');
      if (inp.consumeHeavy() && this.heavyCd <= 0) this.startAttack('heavy');
      if (inp.consumeShove() && this.shoveCd <= 0) this._startShove();
    }

    // combo timer
    if (this.comboTimer > 0) { this.comboTimer -= dt; if (this.comboTimer <= 0 && this.combo > 0) { this.combo = 0; if (this.onCombo) this.onCombo(0); } }

    // ---- attack state
    if (this.attack) {
      const a = this.attack; a.t += dt;
      if (!a.dealt && a.t >= a.strikeAt) { a.dealt = true; this._resolveAttack(ctx); }
      if (a.t >= a.dur) {
        this.attack = null;
        if (this.buffered) { const b = this.buffered; this.buffered = null; this.startAttack(b); }
      }
    }

    // ---- shove state (two-handed push; knockback lands at the thrust peak)
    if (this.shove) {
      const s = this.shove; s.t += dt;
      if (!s.dealt && s.t >= s.strikeAt) { s.dealt = true; this._resolveShove(ctx); }
      if (s.t >= s.dur) this.shove = null;
    }

    // decay feedback
    this.shake = Math.max(0, this.shake - dt * 2.2);
    this.recoil = Math.max(0, this.recoil - dt * 5);
    this.pitchPunch = this.recoil * 0.05;

    this._animateView(dt, ctx.time);
    this._applyCamera(dt);
  }

  _applyCamera(dt) {
    // head bob
    const bobY = Math.sin(this._footPhase * 2) * 0.05 * this.bobActive;
    const bobX = Math.cos(this._footPhase) * 0.035 * this.bobActive;
    const r = this.rightXZ();
    let px = this.pos.x + r.x * bobX;
    let pz = this.pos.z + r.z * bobX;
    let py = EYE + bobY + this.yOff;
    // shake
    if (this.shake > 0.001) {
      const s = this.shake * 0.14;
      px += (Math.random() * 2 - 1) * s;
      py += (Math.random() * 2 - 1) * s;
      pz += (Math.random() * 2 - 1) * s;
    }
    this.camera.position.set(px, py, pz);
    this.camera.rotation.y = this.yaw + Math.cos(this._footPhase) * 0.006 * this.bobActive;
    this.camera.rotation.x = this.pitch - this.pitchPunch;
    this.camera.rotation.z = Math.sin(this._footPhase) * 0.01 * this.bobActive + (this.shake * (Math.random() * 2 - 1) * 0.04);
    if (this.dead) {
      // slump to the floor and tilt over
      const s = Math.min(1, this._deadT / 1.3);
      const e = s * s * (3 - 2 * s);
      this.camera.position.y = py * (1 - e) + 0.5 * e;
      this.camera.rotation.z += e * 0.65;
      this.camera.rotation.x = this.pitch - this.pitchPunch - e * 0.35;
    }
    // keep the view-model rig locked to the camera (setting rotation updates the quaternion)
    this.viewRig.position.copy(this.camera.position);
    this.viewRig.quaternion.copy(this.camera.quaternion);
  }

  _animateView(dt, time) {
    // idle sway + bob for both fists
    const swayY = Math.sin(time * 1.6) * 0.012 + Math.sin(this._footPhase * 2) * 0.03 * this.bobActive;
    const swayX = Math.cos(time * 1.1) * 0.01 + Math.cos(this._footPhase) * 0.02 * this.bobActive;

    // a shove drives BOTH hands, so it wins over any in-progress jab/hook
    const shove = this.shove ? shovePose(this.shove.t / this.shove.dur) : null;

    const arms = [
      [this.fistL, this._restL, this._restRotL, 'left', -1],
      [this.fistR, this._restR, this._restRotR, 'right', 1],
    ];
    for (const [fist, rest, restRot, hand, sign] of arms) {
      let dx = 0, dy = 0, dz = 0, rx = 0, ry = 0, rz = 0;
      if (shove) {
        // both fists thrust forward together and converge toward center,
        // heels of the hands leading the push
        dx = -sign * shove.dxIn; dy = shove.dy; dz = shove.dz;
        rx = shove.rx; rz = -sign * shove.rz;
      } else if (this.attack && this.attack.hand === hand) {
        const a = this.attack, p = a.t / a.dur;
        if (a.type === 'heavy') {
          // right hook: swing the fist across from the right; the elbow (back of the
          // forearm) leads in from the RIGHT. +ry sweeps fist to -X (left) and the
          // elbow to +X (right). Horizontal channels flip with `sign`.
          const k = hookPose(p);
          dx = k.dx * sign; dy = k.dy; dz = k.dz;
          rx = k.rx; ry = k.ry * sign; rz = k.rz * sign;
        } else {
          // straight jab
          const sp = a.strikeAt / a.dur;
          const c = p < sp ? p / sp : Math.max(0, 1 - (p - sp) / (1 - sp));
          const e = c * c * (3 - 2 * c);
          dz = -e * 0.5; dy = e * 0.1;
          rx = -e * 0.5; ry = -e * 0.11 * sign;
        }
      }
      fist.position.set(rest.x + swayX + dx, rest.y + swayY + dy, rest.z + dz);
      fist.rotation.x = restRot.x + rx;
      fist.rotation.y = restRot.y + ry;
      fist.rotation.z = restRot.z + rz;
    }
  }
}

// Keyframed right-hook pose (offsets added on top of the rest transform).
// Channels are for the right hand; the caller mirrors horizontal channels via `sign`.
const HOOK_KEYS = [
  // p     dx      dy      dz      rx      ry      rz
  [0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00],   // rest
  [0.30, 0.06, 0.06, 0.12, -0.05, 0.16, -0.10],  // small wind-up, begin rotating
  [0.52, -0.22, 0.12, -0.34, -0.05, 1.10, 0.32], // swing across; elbow in from the right; contact
  [0.68, -0.26, 0.07, -0.28, -0.02, 1.28, 0.42], // follow-through
  [1.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00],    // recover
];
function hookPose(p) {
  let a = HOOK_KEYS[0], b = HOOK_KEYS[HOOK_KEYS.length - 1];
  for (let i = 0; i < HOOK_KEYS.length - 1; i++) {
    if (p >= HOOK_KEYS[i][0] && p <= HOOK_KEYS[i + 1][0]) { a = HOOK_KEYS[i]; b = HOOK_KEYS[i + 1]; break; }
  }
  const span = b[0] - a[0] || 1;
  let t = (p - a[0]) / span;
  t = t * t * (3 - 2 * t); // smoothstep between keys
  return {
    dx: a[1] + (b[1] - a[1]) * t, dy: a[2] + (b[2] - a[2]) * t, dz: a[3] + (b[3] - a[3]) * t,
    rx: a[4] + (b[4] - a[4]) * t, ry: a[5] + (b[5] - a[5]) * t, rz: a[6] + (b[6] - a[6]) * t,
  };
}

// Keyframed two-handed shove (offsets added on top of the rest transform).
// Symmetric across hands: dxIn (convergence toward center) and rz (roll) are
// mirrored by the caller via `sign`; dz/dy/rx apply to both hands equally.
// Fast wind-up, explosive thrust, brief contact, cushioned recover.
const SHOVE_KEYS = [
  // p     dz      dy     dxIn    rx      rz
  [0.00, 0.00, 0.00, 0.00, 0.00, 0.00],   // rest
  [0.16, 0.14, -0.02, -0.05, 0.32, 0.00],   // wind-up: cock fists back and apart
  [0.30, -0.60, 0.06, 0.16, -0.55, 0.18],   // thrust: punch forward, converge, heels lead
  [0.48, -0.50, 0.05, 0.15, -0.48, 0.16],   // contact hold
  [1.00, 0.00, 0.00, 0.00, 0.00, 0.00],   // recover
];
function shovePose(p) {
  let a = SHOVE_KEYS[0], b = SHOVE_KEYS[SHOVE_KEYS.length - 1];
  for (let i = 0; i < SHOVE_KEYS.length - 1; i++) {
    if (p >= SHOVE_KEYS[i][0] && p <= SHOVE_KEYS[i + 1][0]) { a = SHOVE_KEYS[i]; b = SHOVE_KEYS[i + 1]; break; }
  }
  const span = b[0] - a[0] || 1;
  let t = (p - a[0]) / span;
  t = t * t * (3 - 2 * t); // smoothstep between keys
  return {
    dz: a[1] + (b[1] - a[1]) * t, dy: a[2] + (b[2] - a[2]) * t, dxIn: a[3] + (b[3] - a[3]) * t,
    rx: a[4] + (b[4] - a[4]) * t, rz: a[5] + (b[5] - a[5]) * t,
  };
}
