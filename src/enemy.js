// Enemy: a once-friendly bochur, now hostile. Handles AI, animation, combat.
import * as THREE from 'three';
import { buildCharacter } from './characters.js';
import { COAT_COLORS, SKIN_TONES, BEARD_TONES, BARER } from './assets.js';
import { resolveCircle, lineBlocked } from './collide.js';

// The rig's shoes bottom out ~0.105 below the root origin, so an enemy at y=0 has its
// feet buried in the floor. Lifting the root by this (scaled) amount plants them on it.
const FOOT_LIFT = 0.105;

const _navDir = { x: 0, z: 0 }; // scratch for flow-field sampling (avoids per-frame alloc)

// Barer face billboard: rig-local head anchor / sprite height, plus how far the
// depth-tested sprite is pushed toward the camera each frame so his own
// coat/shoulders can never clip through the photo (see _updateBarerFace).
const FACE_Y = 1.74;
const FACE_H = 0.9;
const FACE_PUSH = 0.35;
const _faceW = new THREE.Vector3(); // scratch: face anchor (world)
const _faceC = new THREE.Vector3(); // scratch: camera position (world)

// ---- Poise / guard -----------------------------------------------------------
// Every enemy holds a poise pool that a jab barely dents but a Haymaker / Shove
// chunks. When it empties the guard BREAKS: the enemy is knocked open and, for a
// short window, takes VULN_MULT bonus damage. That's the whole point — a jab alone
// can't stun-lock anymore, so the reward is to crack the guard with a heavy hit and
// then pile jabs into the opening. Poise refills after a lull, so a few stray jabs
// never accumulate into a free break across a long fight.
const VULN_MULT = 1.7;
const POISE_REGEN_DELAY = 1.3;  // seconds after the last guard hit before it refills
const POISE_REGEN = 16;         // poise per second once it starts refilling

// `ranged`: hurls a sefer at a player perched out of melee reach. `heaver`: the big
// ones can instead heave a nearby perched player clean off the furniture. Together
// these keep a table/bench from being a safe camping spot (see Enemy anti-perch AI).
export const ARCHETYPES = {
  bochur:    { hp: 32,  speed: 2.6, dmg: 8,  scale: 1.0,  reach: 1.5, cd: 1.25, windup: 0.42, poise: 20,  hat: 'fedora', knockRes: 1.0, score: 100, tint: 0x0e0e12, ranged: true },
  masmid:    { hp: 20,  speed: 3.8, dmg: 6,  scale: 0.94, reach: 1.4, cd: 0.95, windup: 0.30, poise: 13,  hat: 'fedora', knockRes: 1.3, score: 130, glasses: true, tint: 0x14140f, ranged: true },
  gabbai:    { hp: 78,  speed: 1.9, dmg: 17, scale: 1.22, reach: 1.7, cd: 1.6,  windup: 0.6,  poise: 54,  hat: 'big', bigBeard: true, knockRes: 0.55, score: 260, tint: 0x0d1210, ranged: true, heaver: true },
  // The Bulvan — a hulking, fur-hatted brute. His blows don't cut deep, but each landed
  // strike BODILY KNOCKS THE PLAYER BACK (`knockback`), shoving you out of position. Very
  // heavy build → low knockRes (he barely budges when hit), tanky HP, slow & telegraphed.
  bulvan:    { hp: 96,  speed: 2.0, dmg: 12, scale: 1.32, reach: 1.8, cd: 1.7,  windup: 0.6,  poise: 70,  hat: 'shtreimel', bigBeard: true, broad: true, beardHex: 0x241812, knockRes: 0.38, score: 300, tint: 0x1a1209, knockback: 3.2 },
  // The Mekubal — a gaunt, white-robed kabbalist with glowing eyes and a draped tallis.
  // His touch lays a binding on your legs: a landed strike SLOWS THE PLAYER'S MOVEMENT
  // (`slow`) for a spell. Little damage; the debuff is the threat.
  mekubal:   { hp: 46,  speed: 2.7, dmg: 7,  scale: 1.04, reach: 1.7, cd: 1.5,  windup: 0.55, poise: 30,  hat: 'kippah', bigBeard: true, tallis: true, eyeGlow: true, beardHex: 0x8a8073, knockRes: 1.0, score: 320, tint: 0xd8d0bd, slow: { factor: 0.5, dur: 2.6 } },
  mashgiach: { hp: 240, speed: 2.3, dmg: 24, scale: 1.38, reach: 2.0, cd: 1.5,  windup: 0.7,  poise: 155, hat: 'homburg', bigBeard: true, glasses: true, knockRes: 0.3, score: 900, boss: true, tint: 0x090b10, heaver: true },
  // Chaim Barer — the boss's lackey (every 9th hall). Invulnerable until the
  // Mashgiach falls, then a soft touch. No face is drawn: a photo billboards over him.
  barer:     { hp: 50,  speed: 2.4, dmg: 10, scale: 1.06, reach: 1.6, cd: 1.4,  windup: 0.5,  poise: 42,  hat: 'fedora', bigBeard: false, knockRes: 0.7, score: 500, tint: 0x101014 },
};

let _hpBar = null; // shared geometry cache
function barGeo() {
  if (!_hpBar) _hpBar = new THREE.PlaneGeometry(1, 1);
  return _hpBar;
}

export class Enemy {
  constructor(type, depthScale, rng) {
    const A = ARCHETYPES[type] || ARCHETYPES.bochur;
    this.type = type;
    this.arch = A;
    this.boss = !!A.boss;

    const built = buildCharacter({
      coat: A.tint ?? rng.pick(COAT_COLORS),
      skin: rng.pick(SKIN_TONES),
      beard: A.beardHex ?? (A.bigBeard ? rng.pick(BEARD_TONES) : rng.pick(BEARD_TONES.slice(0, 4))),
      hat: A.hat, bigBeard: A.bigBeard, glasses: A.glasses,
      tallis: A.tallis, eyeGlow: A.eyeGlow, broad: A.broad,
    });
    this.root = built.root;
    this.joints = built.joints;
    this.mats = built.root.userData.mats;
    this.root.scale.setScalar(A.scale);
    this.height = 1.75 * A.scale;
    this.radius = 0.42 * A.scale;
    this.groundY = FOOT_LIFT * A.scale; // resting root height so the feet sit on the floor
    // headshot band (world Y): center of the head sphere in the rig is ~1.69 up (plus
    // the foot-lift, since the whole rig now rides on groundY); the radius is generous
    // enough to cover neck-through-hat so aiming at the face pays off.
    this.headY = 1.69 * A.scale + this.groundY;
    this.headR = 0.34 * A.scale;

    this.maxHp = A.hp * depthScale.hp;
    this.hp = this.maxHp;
    this.speed = A.speed * depthScale.speed;
    this.dmg = A.dmg * depthScale.dmg;

    // poise / guard (see VULN_MULT etc.). Scales gently with depth so a hardier late-game
    // bochur still guards a little longer, but far slower than its HP grows — cracking a
    // guard stays achievable all run, it's chipping the fat HP bar behind it that's the work.
    this.maxPoise = (A.poise ?? 20) * (depthScale.poise ?? 1);
    this.poise = this.maxPoise;
    this.poiseRegenT = 99;  // start rested (nothing mid-refill on spawn)
    this.vulnT = 0;         // >0 while the guard-broken punish window is open
    this._glow = false;     // whether the vulnerable emissive tint is currently applied

    this.pos = { x: 0, z: 0 };
    this.vel = { x: 0, z: 0 };     // knockback velocity
    this.facing = 0;
    this.animPhase = rng.range(0, 6.28);
    this.state = 'idle';           // idle | approach | windup | strike | recover | stagger | knockdown | dead
    this.timer = 0;
    this.cooldown = rng.range(0.2, 1.0);
    this.throwCd = rng.range(0.4, 1.4);   // stagger the first sefer throws so they don't volley in unison
    this.flash = 0;
    this.dead = false;
    this.removeMe = false;
    this.deathT = 0;
    this.hasDealt = false;
    this.spawnAnim = 1;            // rise-from-seat / fade-in on spawn

    this.isBarer = (type === 'barer');
    this.invulnerable = this.isBarer; // Barer shrugs off all damage until the boss dies
    this.mini = false;                // a mini-boss that keeps its floating bar shown

    this._buildBar();
    if (this.isBarer) this._buildBarerFace(built);
  }

  // Replace the drawn head with a photographic billboard that always faces the camera.
  // Uses a THREE.Sprite (inherently camera-facing) parented to the rig root so it rides
  // along with position/scale but never rotates with the body.
  _buildBarerFace(built) {
    built.joints.head.visible = false;      // hide the sculpted head/hat/beard
    // Depth-tested, so walls, furniture and other bochurim occlude the face like any
    // solid object. Keeping it clear of his OWN torso/shoulders (never half-swallowed
    // by the coat) is handled by _updateBarerFace, which pushes the sprite toward the
    // camera each frame. renderOrder still keeps it under his floating bar (10/11).
    const mat = new THREE.SpriteMaterial({ map: BARER.def, transparent: true, depthWrite: false });
    const spr = new THREE.Sprite(mat);
    spr.renderOrder = 5;
    spr.scale.set(FACE_H * BARER.aspect, FACE_H, 1);
    spr.position.set(0, FACE_Y, 0);         // where the head used to sit (rig-local)
    this.root.add(spr);
    this.faceSprite = spr; this.faceMat = mat;
    this.faceState = 'default';
    this.mini = true;
    this.specialCd = 3 + Math.random() * 3; // next telegraphed special attack
    // a distinct green bar so his pool reads separately from the boss's
    this.barFill.material.color.setHex(0x46c46e);
  }

  // Swap the billboard between default / winding-up / mid-attack.
  setFace(state) {
    if (!this.faceMat || this.faceState === state) return;
    this.faceState = state;
    this.faceMat.map = state === 'attack1' ? BARER.atk1 : (state === 'attack2' ? BARER.atk2 : BARER.def);
    this.faceMat.needsUpdate = true;
  }

  // Slide the face sprite FACE_PUSH toward the camera so the depth test can't let his
  // own torso/arms cut into the photo, and shrink it by the same near/far ratio so the
  // push never reads as the face growing. Runs every frame, including downed/death.
  _updateBarerFace(camera) {
    if (!this.faceSprite || !camera) return;
    this.root.updateWorldMatrix(true, false);
    _faceW.set(0, FACE_Y, 0).applyMatrix4(this.root.matrixWorld);
    camera.getWorldPosition(_faceC);
    const dist = _faceC.distanceTo(_faceW);
    if (dist < 1e-3) return;
    const push = Math.min(FACE_PUSH, dist * 0.5); // never shove it past the camera
    _faceW.addScaledVector(_faceC.sub(_faceW).divideScalar(dist), push);
    this.faceSprite.position.copy(this.root.worldToLocal(_faceW));
    const k = (dist - push) / dist;
    this.faceSprite.scale.set(FACE_H * BARER.aspect * k, FACE_H * k, 1);
  }

  _buildBar() {
    const g = new THREE.Group();
    const bg = new THREE.Mesh(barGeo(), new THREE.MeshBasicMaterial({ color: 0x1a0a08, transparent: true, depthTest: false }));
    bg.scale.set(this.boss ? 1.1 : 0.7, this.boss ? 0.11 : 0.08, 1);
    const fill = new THREE.Mesh(barGeo(), new THREE.MeshBasicMaterial({ color: this.boss ? 0xd84a2e : 0xd23a24, transparent: true, depthTest: false }));
    fill.scale.set(this.boss ? 1.06 : 0.66, this.boss ? 0.08 : 0.055, 1);
    fill.position.z = 0.01;
    // renderOrder isn't inherited from the group, and both planes are transparent
    // with depthTest off — so draw order is decided purely by these values. Give the
    // fill a strictly higher order than the bg so it always paints on top, regardless
    // of camera angle. (Relying on the z-offset alone lets the painter's-sort flip at
    // certain angles, drawing the dark bg last and making the bar look empty.)
    bg.renderOrder = 10;
    fill.renderOrder = 11;
    g.add(bg); g.add(fill);
    g.position.y = this.height + 0.35;
    g.visible = false;
    g.renderOrder = 10;
    this.bar = g; this.barFill = fill; this.barBg = bg;
    this.root.add(g);
    this.barShow = 0;
  }

  setPos(x, z) { this.pos.x = x; this.pos.z = z; this.root.position.set(x, 0, z); }

  // Called by player combat. `poiseDmg` chips the guard; jabs deal little and NEVER stun
  // on their own, so mashing jab at a winding-up enemy just eats the strike. A Haymaker /
  // Shove chunks poise, and when it empties the guard breaks: a knockdown/stagger plus a
  // punish window (this.vulnT) during which hits land for VULN_MULT extra — that's the
  // reward for opening with a heavy instead of spamming jab.
  takeHit(dmg, fromPos, heavy, poiseDmg = 0) {
    if (this.dead || this.state === 'downed') return { killed: false };
    const dx = this.pos.x - fromPos.x, dz = this.pos.z - fromPos.z;
    const d = Math.hypot(dx, dz) || 1;

    // Chaim Barer while shielded: no damage sticks, but a Haymaker or Shove (heavy)
    // still throws him back. A jab just bounces off.
    if (this.invulnerable) {
      this.flash = 1; this.barShow = 2.2;
      if (heavy) {
        const kb = 6.5 * this.arch.knockRes;
        this.vel.x += (dx / d) * kb; this.vel.z += (dz / d) * kb;
        this.state = 'stagger'; this.timer = 0.3; this.hasDealt = false; this.setFace('default');
      }
      return { killed: false, invuln: true };
    }

    // a guard-broken enemy is wide open — everything bites harder in the punish window
    if (this.vulnT > 0) dmg *= VULN_MULT;

    this.hp -= dmg;
    this.flash = 1;
    this.barShow = 2.2;
    const kb = (heavy ? 7.5 : 3.2) * this.arch.knockRes;
    this.vel.x += (dx / d) * kb; this.vel.z += (dz / d) * kb;

    // chip the guard; emptying it breaks it open (and resets the pool)
    let broke = false;
    if (poiseDmg > 0) {
      this.poise -= poiseDmg;
      this.poiseRegenT = 0;
      if (this.poise <= 0) { this.poise = this.maxPoise; broke = true; }
    }

    // Barer never "dies" the normal way — at 0 HP he drops into a downed grab pose and
    // the director takes over for the interactive finisher.
    if (this.isBarer && this.hp <= 0) {
      this.hp = 0; this.state = 'downed'; this.timer = 0; this.hasDealt = false;
      this.setFace('attack2'); this.vel.x *= 0.3; this.vel.z *= 0.3;
      return { killed: false, barerDown: true };
    }
    if (this.hp <= 0) { this._die(dx / d, dz / d); return { killed: true, score: this.arch.score }; }

    // Reaction:
    //   guard break     -> knockdown (heavy) / hard stagger, and open the punish window
    //   heavy, no break  -> a brief flinch (a committed blow still rocks them)
    //   jab, no break    -> NOTHING: they keep advancing and keep attacking — the risk
    if (broke) {
      this.state = (heavy && !this.boss) ? 'knockdown' : 'stagger';
      this.timer = (this.state === 'knockdown') ? 1.15 : 0.75;
      this.vulnT = this.timer + 0.45;   // window outlasts the stun a touch, so follow-ups land
      this.hasDealt = false;
      if (this.isBarer) this.setFace('default');
      return { killed: false, poiseBreak: true };
    }
    if (heavy) {
      this.state = 'stagger'; this.timer = 0.3; this.hasDealt = false;
      if (this.isBarer) this.setFace('default');
    }
    return { killed: false };
  }

  _die(nx, nz) {
    this.dead = true;
    this.state = 'dead';
    this.deathT = 0;
    this.fallDir = { x: nx, z: nz };
    this.vel.x += nx * 4; this.vel.z += nz * 4;
    this.bar.visible = false;
  }

  faceTo(tx, tz, dt, rate = 10) {
    const want = Math.atan2(tx - this.pos.x, tz - this.pos.z);
    let diff = want - this.facing;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.facing += diff * Math.min(1, dt * rate);
    this.root.rotation.y = this.facing;
  }

  update(dt, ctx) {
    const time = ctx.time;
    if (this.faceSprite) this._updateBarerFace(ctx.camera);
    // flash decay
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 4);
      const e = this.flash * 0.9;
      this.mats.coat.emissive.setRGB(e, e * 0.2, e * 0.15);
      this.mats.skin.emissive.setRGB(e, e * 0.3, e * 0.2);
      // the billboard has no emissive — pulse its tint red instead
      if (this.faceMat) this.faceMat.color.setRGB(1, 1 - this.flash * 0.55, 1 - this.flash * 0.55);
    }

    if (this.dead) { this._updateDeath(dt); return; }

    // downed Barer: frozen in a terrified quiver, awaiting the finisher takeover
    if (this.state === 'downed') {
      const q = Math.sin(time * 30) * 0.02;
      this._poseStagger(dt);
      this.root.rotation.y = this.facing + q;
      this.root.position.set(this.pos.x, this.groundY, this.pos.z);
      return;
    }

    // guard state: run down the punish window, and refill poise after a lull so stray
    // jabs never bank a free break
    if (this.vulnT > 0) this.vulnT = Math.max(0, this.vulnT - dt);
    this.poiseRegenT += dt;
    if (this.poise < this.maxPoise && this.poiseRegenT > POISE_REGEN_DELAY) {
      this.poise = Math.min(this.maxPoise, this.poise + POISE_REGEN * dt);
    }
    // vulnerable glow: a warm pulse marking the opening. The red hit-flash owns the
    // emissive while it's active, so only paint (and clear) the tint once flash is spent.
    if (this.flash <= 0) {
      if (this.vulnT > 0) {
        const pulse = 0.3 + 0.22 * Math.sin(time * 14);
        this.mats.coat.emissive.setRGB(pulse, pulse * 0.82, pulse * 0.2);
        this.mats.skin.emissive.setRGB(pulse * 0.8, pulse * 0.66, pulse * 0.16);
        this._glow = true;
      } else if (this._glow) {
        this.mats.coat.emissive.setRGB(0, 0, 0);
        this.mats.skin.emissive.setRGB(0, 0, 0);
        this._glow = false;
      }
    }

    // apply knockback velocity
    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
    this.vel.x *= Math.pow(0.02, dt); this.vel.z *= Math.pow(0.02, dt);

    const P = ctx.player.pos;
    const dx = P.x - this.pos.x, dz = P.z - this.pos.z;
    const dist = Math.hypot(dx, dz);

    // ---- shekel lure: a tossed coin pulls the whole room off the player. Target the
    // nearest active lure this frame; the director decides who actually snatches it up.
    let lure = null;
    if (ctx.lures) {
      let best = Infinity;
      for (const L of ctx.lures) {
        const lx = L.x - this.pos.x, lz = L.z - this.pos.z, d2 = lx * lx + lz * lz;
        if (d2 < best) { best = d2; lure = L; }
      }
    }
    // a coin appearing mid-swing breaks the enemy's concentration — drop any attack in
    // progress and go for the money (hit-reactions stagger/knockdown still play out)
    if (lure) {
      const st = this.state;
      if (st === 'windup' || st === 'strike' || st === 'recover' || st === 'throwWind' ||
          st === 'throw' || st === 'heaveWind' || st === 'heave' || st === 'barerWind' || st === 'barerStrike') {
        this.state = 'approach'; this.hasDealt = true;
        if (this.isBarer) this.setFace('default');
      }
    }

    // separation from other enemies
    let sepx = 0, sepz = 0;
    for (const o of ctx.enemies) {
      if (o === this || o.dead) continue;
      const ox = this.pos.x - o.pos.x, oz = this.pos.z - o.pos.z;
      const od = Math.hypot(ox, oz);
      const want = this.radius + o.radius + 0.15;
      if (od < want && od > 0.001) { const f = (want - od) / want; sepx += (ox / od) * f; sepz += (oz / od) * f; }
    }

    if (this.spawnAnim > 0) this.spawnAnim = Math.max(0, this.spawnAnim - dt * 1.6);

    // Only a knockdown tilts the whole body toward the floor; every other on-foot state
    // stands upright. If a knockdown is cut short — e.g. a shove lands mid-rise and bumps
    // the enemy into 'stagger' — nothing else clears that tilt, so the body would stay
    // slanted and drift off its (un-rotated) circular hitbox. Ease the root back to
    // vertical whenever we're not knocked down (dead/downed already returned above).
    if (this.state !== 'knockdown') {
      const k = Math.min(1, dt * 12);
      this.root.rotation.x += (0 - this.root.rotation.x) * k;
      this.root.rotation.z += (0 - this.root.rotation.z) * k;
      if (Math.abs(this.root.rotation.x) < 1e-3) this.root.rotation.x = 0;
      if (Math.abs(this.root.rotation.z) < 1e-3) this.root.rotation.z = 0;
    }

    switch (this.state) {
      case 'stagger':
        this.timer -= dt; this._poseStagger(dt);
        if (this.timer <= 0) this.state = 'approach';
        break;
      case 'knockdown':
        this.timer -= dt; this._poseKnockdown(this.timer);
        if (this.timer <= 0) this.state = 'approach';
        break;
      case 'windup': {
        this.timer -= dt;
        this.faceTo(P.x, P.z, dt, 6);
        this._poseWindup(1 - Math.max(0, this.timer) / this.arch.windup);
        if (this.timer <= 0) { this.state = 'strike'; this.timer = 0.14; this.hasDealt = false; }
        break;
      }
      case 'strike': {
        this.timer -= dt;
        this._poseStrike();
        if (!this.hasDealt) {
          this.hasDealt = true;
          ctx.audio.whoosh(this.boss);
          if (dist < this.arch.reach + ctx.player.radius + 0.3) {
            const inFront = (dx * Math.sin(this.facing) + dz * Math.cos(this.facing)) > 0;
            if (inFront) {
              // capture hittability BEFORE the hit (takeDamage raises i-frames) so a blow
              // that lands during invulnerability doesn't also knock/slow the player
              const landed = !ctx.player.dead && (ctx.player.invuln || 0) <= 0;
              ctx.player.takeDamage(this.dmg, this.pos); ctx.audio.hit(this.boss, 0.8);
              // on-hit riders: the bulvan shoves you back, the mekubal binds your legs
              if (landed && this.arch.knockback && ctx.player.knockBack) ctx.player.knockBack(this.pos, this.arch.knockback);
              if (landed && this.arch.slow && ctx.player.applySlow) ctx.player.applySlow(this.arch.slow.factor, this.arch.slow.dur);
            }
          }
        }
        if (this.timer <= 0) { this.state = 'recover'; this.timer = 0.32; }
        break;
      }
      case 'recover':
        this.timer -= dt; this.faceTo(P.x, P.z, dt, 5);
        this._poseIdle(time, 0.5);
        // back off slightly
        this.pos.x -= (dx / (dist || 1)) * this.speed * 0.3 * dt;
        this.pos.z -= (dz / (dist || 1)) * this.speed * 0.3 * dt;
        if (this.timer <= 0) { this.state = 'approach'; this.cooldown = this.arch.cd * (0.8 + Math.random() * 0.5); }
        break;
      case 'throwWind': {
        this.timer -= dt;
        this.faceTo(P.x, P.z, dt, 6);
        this._poseThrowWind(1 - Math.max(0, this.timer) / 0.45);
        if (this.timer <= 0) { this.state = 'throw'; this.timer = 0.16; this.hasDealt = false; }
        break;
      }
      case 'throw': {
        this.timer -= dt;
        this._poseThrow();
        if (!this.hasDealt) {
          this.hasDealt = true;
          ctx.audio.whoosh(false);
          if (ctx.spawnSefer) ctx.spawnSefer(this.pos, this.groundY, P, ctx.perchY || 0, this.dmg * 0.7);
          // the longer the player camps, the faster the sefarim come
          const camp = ctx.campT || 0;
          this.throwCd = Math.max(1.1, 2.6 - camp * 0.25) * (0.85 + Math.random() * 0.3);
        }
        if (this.timer <= 0) this.state = 'approach';
        break;
      }
      case 'heaveWind': {
        this.timer -= dt;
        this.faceTo(P.x, P.z, dt, 6);
        this._poseWindup(1 - Math.max(0, this.timer) / 0.55); // reuse the melee telegraph
        if (this.timer <= 0) { this.state = 'heave'; this.timer = 0.18; this.hasDealt = false; }
        break;
      }
      case 'heave': {
        this.timer -= dt;
        this._poseStrike();
        if (!this.hasDealt) {
          this.hasDealt = true;
          ctx.audio.whoosh(true);
          if (dist < this.arch.reach + 1.9 && ctx.player.eject) {
            ctx.audio.hit(true, 0.7);
            ctx.player.eject(this.pos, 1, this.dmg * 0.5);
          }
        }
        if (this.timer <= 0) { this.state = 'recover'; this.timer = 0.4; }
        break;
      }
      case 'barerWind': {
        // Chaim Barer's telegraphed special: a long wind-up, face morphed to attack1
        this.timer -= dt;
        this.faceTo(P.x, P.z, dt, 5);
        this._poseWindup(1 - Math.max(0, this.timer) / 0.7);
        if (this.timer <= 0) { this.state = 'barerStrike'; this.timer = 0.2; this.hasDealt = false; this.setFace('attack2'); }
        break;
      }
      case 'barerStrike': {
        this.timer -= dt;
        this._poseStrike();
        if (!this.hasDealt) {
          this.hasDealt = true;
          ctx.audio.whoosh(true);
          if (dist < this.arch.reach + ctx.player.radius + 0.4) {
            const inFront = (dx * Math.sin(this.facing) + dz * Math.cos(this.facing)) > 0;
            if (inFront) { ctx.player.takeDamage(this.dmg * 1.8, this.pos); ctx.audio.hit(true, 0.7); }
          }
        }
        if (this.timer <= 0) {
          this.state = 'recover'; this.timer = 0.45;
          this.specialCd = 4 + Math.random() * 3; this.setFace('default');
        }
        break;
      }
      default: { // idle / approach — or, when a coin's in play, chase the lure instead
        this.cooldown -= dt;
        this.throwCd = Math.max(0, this.throwCd - dt);
        if (this.isBarer) this.specialCd -= dt;

        // when lured, the coin is the target and the enemy throws no punches; otherwise
        // it's the usual hunt-the-player behaviour (with the anti-perch harassment)
        const TX = lure ? lure.x : P.x, TZ = lure ? lure.z : P.z;
        const tdx = TX - this.pos.x, tdz = TZ - this.pos.z;
        const tdist = Math.hypot(tdx, tdz);

        // ---- anti-perch (player-only): the player is safely elevated and out of reach.
        // Rather than mill uselessly, throw a sefer or, for the heavies, heave them off.
        if (!lure && ctx.antiPerch) {
          if (this.arch.heaver && dist < this.arch.reach + 1.6) {
            this.faceTo(P.x, P.z, dt);
            this.state = 'heaveWind'; this.timer = 0.55; this.hasDealt = false;
            break;
          }
          if (this.arch.ranged && this.throwCd <= 0 && dist < 11 && this._canThrow(ctx, P)) {
            this.faceTo(P.x, P.z, dt);
            this.state = 'throwWind'; this.timer = 0.45; this.hasDealt = false;
            break;
          }
          // not able to act yet → keep repositioning toward the player (below).
        }

        const stopDist = lure ? (this.radius + 0.4) : (this.arch.reach + ctx.player.radius);
        if (tdist > stopDist) {
          // Desired heading: make a beeline when the target is in the clear, otherwise
          // follow the flow field around the furniture (only when hunting the player — the
          // field points at the player, so a lure just gets a beeline + collision slide).
          const inv = 1 / (tdist || 1);
          let dirx = tdx * inv, dirz = tdz * inv, routing = false;
          if (!lure && ctx.nav && lineBlocked(this.pos.x, this.pos.z, P.x, P.z, ctx.colliders, this.radius + 0.05)) {
            const fl = ctx.nav.dirAt(this.pos.x, this.pos.z, _navDir);
            if (fl.x !== 0 || fl.z !== 0) { dirx = fl.x; dirz = fl.z; routing = true; }
          }
          let mx = dirx + sepx * 1.4, mz = dirz + sepz * 1.4;
          const ml = Math.hypot(mx, mz) || 1;
          const sp = this.speed * (this.spawnAnim > 0 ? 0.5 : 1);
          this.pos.x += (mx / ml) * sp * dt; this.pos.z += (mz / ml) * sp * dt;
          // face where they're actually walking while routing, else square up on the target
          if (routing) this.faceTo(this.pos.x + mx, this.pos.z + mz, dt);
          else this.faceTo(TX, TZ, dt);
          this._poseWalk(dt, sp);
          this.state = 'approach';
        } else if (lure) {
          // reached the coin — mill over it, the director resolves who grabs it
          this.faceTo(TX, TZ, dt);
          this._poseIdle(time, 1);
          this.pos.x += sepx * this.speed * dt; this.pos.z += sepz * this.speed * dt;
        } else {
          this.faceTo(P.x, P.z, dt);
          this._poseIdle(time, 1);
          // in range: attack if ready
          if (this.cooldown <= 0 && this.spawnAnim <= 0) {
            if (this.isBarer && this.specialCd <= 0) {
              this.state = 'barerWind'; this.timer = 0.7; this.hasDealt = false; this.setFace('attack1');
            } else {
              this.state = 'windup'; this.timer = this.arch.windup;
            }
          } else {
            // shuffle with separation so they don't stack
            this.pos.x += sepx * this.speed * dt; this.pos.z += sepz * this.speed * dt;
          }
        }
      }
    }

    // collide with world + clamp to room
    resolveCircle(this.pos, this.radius, ctx.colliders, 2);
    if (ctx.bounds) {
      this.pos.x = Math.max(ctx.bounds.minX, Math.min(ctx.bounds.maxX, this.pos.x));
      this.pos.z = Math.max(ctx.bounds.minZ, Math.min(ctx.bounds.maxZ, this.pos.z));
    }
    // Plant the feet on the floor (this.groundY), never below it. The spawn "rise"
    // now reads as a quick grow-into-place instead of sinking the body through the
    // floorboards, so no feet ever poke through.
    this.root.position.set(this.pos.x, this.groundY, this.pos.z);
    const grow = this.spawnAnim > 0 ? (0.82 + 0.18 * (1 - this.spawnAnim)) : 1;
    this.root.scale.setScalar(this.arch.scale * grow);

    // health bar
    this.barShow = Math.max(0, this.barShow - dt);
    const showBar = this.boss || this.mini || this.barShow > 0 || this.hp < this.maxHp - 0.01;
    this.bar.visible = showBar && !this.dead;
    if (this.bar.visible) {
      const frac = Math.max(0, this.hp / this.maxHp);
      const full = this.boss ? 1.06 : 0.66;
      this.barFill.scale.x = full * frac;
      this.barFill.position.x = -full * (1 - frac) / 2;
      if (ctx.camera) this.bar.lookAt(ctx.camera.position.x, this.bar.getWorldPosition(new THREE.Vector3()).y, ctx.camera.position.z);
    }
  }

  _updateDeath(dt) {
    this.deathT += dt;
    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
    this.vel.x *= Math.pow(0.01, dt); this.vel.z *= Math.pow(0.01, dt);
    const t = this.deathT;
    // fall backward over 0.5s
    const fall = Math.min(1, t / 0.5);
    this.root.rotation.x = -fall * Math.PI * 0.5 * (this.fallDir.z >= 0 ? 1 : 1);
    // then sink + shrink and remove
    let y = this.groundY;
    if (t > 1.0) {
      const s = Math.min(1, (t - 1.0) / 0.6);
      y = this.groundY - s * 1.2;
      this.root.scale.setScalar(this.arch.scale * (1 - s * 0.5));
      if (s >= 1) this.removeMe = true;
    }
    this.root.position.set(this.pos.x, y, this.pos.z);
  }

  // ---------------- poses ----------------
  _poseWalk(dt, sp) {
    this.animPhase += dt * (4 + sp * 1.6);
    const s = Math.sin(this.animPhase), c = Math.cos(this.animPhase);
    const j = this.joints;
    j.thighL.rotation.x = s * 0.7; j.thighR.rotation.x = -s * 0.7;
    j.kneeL.rotation.x = Math.max(0, -c) * 0.7; j.kneeR.rotation.x = Math.max(0, c) * 0.7;
    j.shoulderL.rotation.x = -s * 0.5; j.shoulderR.rotation.x = s * 0.5;
    j.shoulderL.rotation.z = 0.18; j.shoulderR.rotation.z = -0.18;
    j.elbowL.rotation.x = 0.2; j.elbowR.rotation.x = 0.2;
    j.torso.rotation.z = s * 0.05; j.torso.rotation.x = 0.08;
    j.hips.position.y = 0.82 + Math.abs(s) * 0.04;
    j.head.rotation.x = 0.05;
  }
  _poseIdle(time, k) {
    const j = this.joints, s = Math.sin(time * 2 + this.animPhase);
    j.thighL.rotation.x *= 0.8; j.thighR.rotation.x *= 0.8;
    j.kneeL.rotation.x *= 0.8; j.kneeR.rotation.x *= 0.8;
    j.shoulderL.rotation.x = s * 0.05; j.shoulderR.rotation.x = -s * 0.05;
    j.shoulderL.rotation.z = 0.22; j.shoulderR.rotation.z = -0.22;
    j.torso.rotation.z = s * 0.03; j.torso.rotation.x = 0.02;
    j.hips.position.y = 0.82 + s * 0.01;
  }
  _poseWindup(p) {
    const j = this.joints;
    // raise right arm back, lean back — telegraph
    j.shoulderR.rotation.x = -1.6 * p; j.shoulderR.rotation.z = -0.6 * p;
    j.elbowR.rotation.x = 1.2 * p;
    j.torso.rotation.x = -0.25 * p;
    j.torso.rotation.y = -0.3 * p;
    j.shoulderL.rotation.x = 0.4 * p;
  }
  _poseStrike() {
    const j = this.joints;
    // thrust forward
    j.shoulderR.rotation.x = 1.1; j.shoulderR.rotation.z = -0.1;
    j.elbowR.rotation.x = 0.1;
    j.torso.rotation.x = 0.28; j.torso.rotation.y = 0.35;
  }
  _poseStagger(dt) {
    const j = this.joints;
    j.torso.rotation.x = -0.4; j.head.rotation.x = -0.3;
    j.shoulderL.rotation.x = 0.6; j.shoulderR.rotation.x = 0.6;
  }
  // Chaim Barer sinking to his knees during the finisher transition. `p` ramps 0→1: he
  // buckles forward, his head hangs, arms go limp, and a terrified tremble grows. Driven
  // straight from the game (not update) during the frozen "time stops" beat.
  crumple(p, time) {
    const j = this.joints;
    const e = p * p * (3 - 2 * p);
    j.hips.position.y = 0.82 - e * 0.34;
    j.torso.rotation.x = 0.2 + e * 0.55; j.torso.rotation.y = 0; j.torso.rotation.z = 0;
    j.head.rotation.x = 0.1 + e * 0.5;
    j.thighL.rotation.x = -e * 0.9; j.thighR.rotation.x = -e * 0.9;
    j.kneeL.rotation.x = e * 1.3; j.kneeR.rotation.x = e * 1.3;
    j.shoulderL.rotation.x = 0.3 + e * 0.7; j.shoulderR.rotation.x = 0.3 + e * 0.7;
    j.shoulderL.rotation.z = 0.22; j.shoulderR.rotation.z = -0.22;
    j.elbowL.rotation.x = -0.6; j.elbowR.rotation.x = -0.6;
    const tremble = (0.4 + p) * 0.02;
    this.root.rotation.x = 0;
    this.root.rotation.z = Math.sin(time * 19) * tremble * 0.7;
    this.root.rotation.y = this.facing + Math.sin(time * 26) * tremble;
    this.root.position.set(this.pos.x, this.groundY, this.pos.z);
  }
  // clear line-of-sight for a throw: only full-height walls block (the sefer arcs over
  // tables and benches), so test the segment against tall colliders only.
  _canThrow(ctx, P) {
    return !lineBlocked(this.pos.x, this.pos.z, P.x, P.z, ctx.colliders, 0.1, 2.0);
  }
  _poseThrowWind(p) {
    const j = this.joints;
    // cock the right arm up and back behind the head, lean back — a clear wind-up tell
    j.shoulderR.rotation.x = -2.2 * p; j.shoulderR.rotation.z = -0.4 * p;
    j.elbowR.rotation.x = 1.6 * p;
    j.torso.rotation.x = -0.2 * p; j.torso.rotation.y = -0.35 * p;
    j.shoulderL.rotation.x = 0.5 * p;
    j.head.rotation.x = -0.15 * p;
  }
  _poseThrow() {
    const j = this.joints;
    // whip the arm over the top and down — the release
    j.shoulderR.rotation.x = 1.4; j.shoulderR.rotation.z = -0.1;
    j.elbowR.rotation.x = 0.15;
    j.torso.rotation.x = 0.3; j.torso.rotation.y = 0.3;
    j.head.rotation.x = 0.1;
  }
  _poseKnockdown(timeLeft) {
    const j = this.joints;
    const p = Math.min(1, (1.1 - timeLeft) / 0.3);
    const up = Math.max(0, (0.4 - timeLeft) / 0.4);
    // Clamp so the pose is monotonic (upright → fall back → upright): p can start
    // negative and up can overshoot 1 at the tail, which would otherwise leave a small
    // wrong-direction tilt lingering after the knockdown finishes.
    const lie = Math.max(0, p - up);
    this.root.rotation.x = -lie * Math.PI * 0.42;
    this.root.position.y = this.groundY;
    j.torso.rotation.x = 0.1;
  }

  dispose() {
    this.root.traverse((o) => { if (o.isMesh && o.geometry && o.geometry !== _hpBar && !o.geometry.userData.shared) o.geometry.dispose(); });
    for (const k in this.mats) this.mats[k].dispose();
    this.barFill.material.dispose(); this.barBg.material.dispose();
    if (this.faceMat) this.faceMat.dispose(); // shared BARER textures are NOT disposed
  }
}
