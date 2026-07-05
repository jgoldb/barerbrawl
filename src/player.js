// First-person player: camera rig, view-model fists, movement, combat, health.
import * as THREE from 'three';
import { buildFists } from './characters.js';
import { MAT } from './assets.js';
import { resolveCircle, surfaceHeight } from './collide.js';

const EYE = 1.66;

// ---- Sitting on chairs/benches ---------------------------------------------
// The player can sit on a seat they're looking at within reach (WoW-style). Detection
// is aim + range + free-seat availability; the reticle shows enabled/disabled. Any
// movement (or an action, or taking a hit) stands them back up.
const SIT_HOVER_MAX = 4.2;    // start showing the sit cursor within this look-range
const SIT_RANGE = 2.6;        // must be at least this close for the seat to be usable
const SIT_AIM_DOT = 0.55;     // crosshair must fall roughly on the seat (cos of the cone)
const SIT_EYE_ABOVE_SEAT = 0.82; // seated eye height above the seat surface
// How far above the feet a ledge may be to still count as walk-over / land-on. Small,
// so benches (0.55) and tables (0.96) each need a real jump, but landings are forgiving.
const STEP_CLEAR = 0.15;
// Backpedalling (holding S) is slower than moving forward or strafing: at a full
// straight retreat the speed is scaled to this fraction, blended for diagonal back-steps.
const BACKPEDAL = 0.55;
// A punch that lands in the enemy's head band (see Enemy.headY/headR) hits this much harder.
const HEADSHOT_MULT = 1.8;

// ---- Poise damage (guard-breaking) -----------------------------------------
// How much of an enemy's guard each strike chips (see Enemy poise / VULN_MULT). A jab
// barely dents it, so jab-spam alone won't crack a guard before poise refills — the
// Haymaker and Shove are the openers, and a headshot chips extra so aim pays twice.
const JAB_POISE = 7;
const HEAVY_POISE = 46;   // a haymaker breaks a rank-and-file bochur in one, chunks the big ones
const SHOVE_POISE = 38;   // the two-handed shove cracks a whole crowd's guard at once

// ---- Back-strike penalty ---------------------------------------------------
// A hit landing behind you catches you flat-footed — you can't roll with a blow you
// never saw, so it lands 30% harder. Judged from the attacker's position vs. your
// facing in takeDamage; stacks on top of the wall-pinned multiplier (B).
const BEHIND_MULT = 1.3;

// ---- Rapid-jab throttle -----------------------------------------------------
// A jab that starts within JAB_CHAIN_WINDOW of the previous one counts as "back-to-back"
// (the buffered auto-combo fires ~0.3s apart, well inside this). After the 2nd such jab a
// short recovery (JAB_PAIR_CD) locks the next one out — enough to break the machine-gun
// rhythm and invite a heavy/shove, but small enough that a paced jab is never throttled.
const JAB_CHAIN_WINDOW = 0.42;
const JAB_PAIR_CD = 0.5;

// ---- Wall-hugging penalty --------------------------------------------------
// Backing your flank against something solid removes the threat of being surrounded,
// so cornering yourself must cost you instead. We sample "enclosure" by probing 8
// compass points this far out; a point inside anything that would actually block your
// movement counts. ANY solid obstacle shields your back — a wall, a bookshelf, a
// window's wall, the aron kodesh, a pillar, a table, a bench — so all of them count
// (see _enclosure, which uses the same step-over test as collision). Open floor ~0,
// a flat obstacle behind you ~3/8, a corner 5+/8.
const CORNER_PROBE = 0.85;
// The meter only builds above this blocked-fraction — a flat wall at your back is
// enough, but you must also be STUCK (see below), so a wall to your side while you
// run a hall never triggers it.
const CORNER_ENCLOSE_MIN = 0.30;      // ~3 of 8 dirs
// You're "stuck" once you've lingered within CORNER_PROGRESS of an anchor point for
// longer than the grace; getting this far from it re-anchors and clears the timer.
// This is what separates camping a corner (net-zero wiggling) from traversing a
// corridor (you keep covering ground), so hallways don't get punished.
const CORNER_PROGRESS = 0.9;
const CORNER_STUCK_GRACE = 0.4;       // seconds pinned-in-place before it counts
// Seconds of solid cornering to fill the meter at a flat wall (corners fill faster).
const CORNER_FILL = 1.5;
// The meter bleeds off this fast in the open — far quicker than it builds, so
// committing to a move clears the danger almost at once.
const CORNER_DECAY = 2.8;
// (A) Chip drain: HP/second at a full meter. Only bites past CORNER_HURT_AT, giving
// a grace window where the telegraph plays but no damage lands yet.
const CORNER_DPS = 11;
const CORNER_HURT_AT = 0.5;
// (B) Pinned: with your back to the wall you can't give ground, so incoming hits
// scale up to this multiplier at a full meter.
const CORNER_PIN_MULT = 1.6;

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

    // a scripted glide (e.g. the shove inward when combat trips) — eased over its
    // duration and layered on top of normal movement so it reads as a quick step,
    // not a teleport. Null when idle. See nudgeBy().
    this.nudge = null;

    // sitting: null when standing, else { seat, seatX, seatZ, eyeY }. sitState/sitSeat
    // drive the reticle each frame while standing (none | enabled | disabled); sitReturn
    // is the standing spot to drop back to when they get up.
    this.sitting = null;
    this.sitState = 'none';
    this.sitSeat = null;
    this.sitReturn = null;

    this.maxHp = 100; this.hp = 100;
    this.dead = false;
    this.invuln = 0;
    this.sinceDamage = 99;
    // brief window after an NPC flings the player (knockBack/knockOff) during which
    // slamming into a bookshelf counts as "knocked into it" and rains sefarim down.
    this.knockedT = 0;

    // leg-binding slow debuff (a mekubal's strike): while slowT > 0 the movement speed
    // is scaled by slowFactor. Refreshes rather than stacks (see applySlow).
    this.slowT = 0; this.slowFactor = 1;

    // wall-hug pressure: 0..1 meter that ramps while you're wedged against a wall
    // with nowhere to retreat, and drains fast in the open. Drives chip damage (A),
    // the pinned damage-taken multiplier (B), and the HUD/heartbeat telegraph.
    this.cornered = 0;
    this.pinnedMult = 1;
    this._anchor = { x: 0, z: 0 };  // where we last "made progress" from
    this._anchorStuck = 0;          // time lingering near that anchor
    this._heartT = 0;               // heartbeat SFX countdown
    this._crushT = 0;               // wall-crush beat countdown (SFX + flash + shake)

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
    // rapid-jab throttle: two jabs thrown back-to-back earn a short recovery, so you
    // can't machine-gun them. jabChain counts jabs inside jabChainT's rolling window;
    // pausing (window lapses) resets it, so deliberately-spaced jabs are never penalized.
    this.jabCd = 0;
    this.jabChain = 0;
    this.jabChainT = 0;

    // shekels: a pocketful of coins (max 3). One drops off each fallen boss; with at least
    // one in hand the player can toss it (Q) as a lure that pulls the whole room off them.
    this.shekels = 0;
    this.maxShekels = 3;
    this.toss = null;          // {t, dur, strikeAt, released} — the wind-up-and-throw animation
    this.onToss = null;        // (info) fired at the release frame so the world spawns the coin

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

    // a shekel that materialises in the throwing (right) hand during a toss, then vanishes
    // the instant it leaves the fingers (the world takes over the airborne coin). Parented
    // to the right fist so it rides the hand through the whole wind-up. Hidden at rest.
    const coin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075, 0.075, 0.02, 18),
      [MAT.shekelEdge, MAT.shekelFace, MAT.shekelFace],   // struck Hebrew face on the caps
    );
    coin.rotation.set(0.5, 0, 0.5);           // tilt so the minted face angles toward the eye
    coin.position.set(0.0, 0.17, -0.26);      // held up and forward of the fingertips, clear of the knuckles
    coin.visible = false;
    this.throwCoin = coin;
    this.fistR.add(coin);

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
    this.onKnockback = null; // (info) — a bulvan shoved the player back
    this.onSlow = null;      // (info) — a mekubal's binding took hold (rising edge)
    this.onCornerCrush = null; // (sev) — a wall-crush beat while cornered chip damage lands
    this._footPhase = 0;   // continuous stride phase (wraps at 2π, seamless for sin/cos)
    this._stepPhase = 0;   // separate accumulator for footstep sfx (two steps per stride)
    this._moving = false;
  }

  spawn(x, z, yaw) {
    this.pos.x = x; this.pos.z = z; this.yaw = yaw; this.pitch = 0;
    this.hp = this.maxHp; this.dead = false; this.invuln = 0; this.sinceDamage = 99;
    this.combo = 0; this.attack = null; this.shove = null; this.shake = 0; this._deadT = 0;
    this.buffered = null; this.jabCd = 0; this.jabChain = 0; this.jabChainT = 0;
    this.knockedT = 0;
    this.shekels = 0; this.toss = null; if (this.throwCoin) this.throwCoin.visible = false;
    this.yOff = 0; this.vy = 0; this.grounded = true; this.vel.x = 0; this.vel.z = 0;
    this.nudge = null;
    this.slowT = 0; this.slowFactor = 1;
    if (this.sitting && this.sitting.seat) this.sitting.seat.occupant = null;
    this.sitting = null; this.sitState = 'none'; this.sitSeat = null; this.sitReturn = null;
    this.cornered = 0; this.pinnedMult = 1; this._anchorStuck = 0; this._heartT = 0;
    this._anchor.x = x; this._anchor.z = z;
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
    if (this.sitting) this._standUp();   // a struck bochur springs to his feet
    // (B) pinned against a wall — you can't roll with the hit, so it lands harder
    dmg *= this.pinnedMult;
    // Struck from behind — caught flat-footed, the blow lands 30% harder. `toSrc`
    // is the direction to the attacker; a negative dot with your facing means the
    // hit came from behind you.
    if (srcPos) {
      const f = this.forwardXZ();
      const tx = srcPos.x - this.pos.x, tz = srcPos.z - this.pos.z;
      if (tx * f.x + tz * f.z < 0) dmg *= BEHIND_MULT;
    }
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

  // A sefer knocked off a shelf lands on the player: a little damage plus a jolt and a
  // small shove out from under the falling books. Deliberately BYPASSES the combat i-frames
  // so a cascade of several books each chips a bit (each book strikes only once — see
  // Bookshelf.update), and flags the hit (info.book) so the HUD flashes without the usual
  // hurt grunt (the book's own thump SFX covers it).
  hurtByFallingBook(dmg, srcPos) {
    if (this.dead) return;
    if (this.sitting) this._standUp();
    this.hp -= dmg;
    this.sinceDamage = 0;
    this.shake = Math.min(1.4, this.shake + 0.3);
    if (srcPos) {
      const dx = this.pos.x - srcPos.x, dz = this.pos.z - srcPos.z, d = Math.hypot(dx, dz) || 1;
      this.pos.x += (dx / d) * 0.12; this.pos.z += (dz / d) * 0.12;
    }
    if (this.onDamage) this.onDamage({ dmg, hp: this.hp, book: true });
    if (this.hp <= 0) { this.hp = 0; this.dead = true; if (this.onDeath) this.onDeath(); }
  }

  heal(a) { this.hp = Math.min(this.maxHp, this.hp + a); }

  // Pocket a shekel; returns false (no-op) when already carrying the max of three.
  addShekel() {
    if (this.shekels >= this.maxShekels) return false;
    this.shekels++;
    return true;
  }

  // Begin a toss: consume one shekel and start the wind-up-and-throw arm animation. The
  // coin appears in the hand now and is released (spawned into the world) at strikeAt.
  _startToss(ctx) {
    if (this.dead || this.toss || this.shekels <= 0 || this.attack || this.shove || this.sitting) return;
    this.shekels--;
    this.toss = { t: 0, dur: 0.5, strikeAt: 0.26, released: false };
    if (this.throwCoin) this.throwCoin.visible = true;
    ctx.audio.coinToss();
  }

  // The release frame: hide the held coin and hand off a launch spec (origin + aim) to the
  // world so the director can spawn the airborne, wall-bouncing lure.
  _releaseToss(ctx) {
    if (this.throwCoin) this.throwCoin.visible = false;
    const f = this.forwardXZ();
    const originY = EYE + this.yOff - 0.1;   // roughly the throwing hand's height
    if (this.onToss) this.onToss({
      x: this.pos.x, z: this.pos.z, y: originY,
      dirX: f.x, dirZ: f.z, pitch: this.pitch,
    });
  }

  // Slide the player by (dx,dz) smoothly over `dur` seconds instead of snapping.
  // Applied in update() before collision, so the glide still respects walls; kept
  // short so it clears the doorway well before the closing portcullis turns solid.
  nudgeBy(dx, dz, dur = 0.2) {
    this.nudge = { dx, dz, dur, t: 0, done: 0 };
  }

  // Fraction (0..1) of 8 probe directions that land inside something that would block
  // movement at the player's feet. Cheap point-in-box test at CORNER_PROBE out — flush
  // against an obstacle you're held ~radius off, so a point 0.85 out lands well inside it.
  // Uses the SAME step-over rule as resolveCircle (a box whose top is within STEP_CLEAR
  // of your feet is passable), so anything genuinely solid at your back — wall, bookshelf,
  // window's wall, aron kodesh, pillar, table, bench — counts, while a surface you're
  // standing on does not.
  _enclosure(colliders, feetY) {
    let blocked = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const x = this.pos.x + Math.cos(a) * CORNER_PROBE;
      const z = this.pos.z + Math.sin(a) * CORNER_PROBE;
      for (let j = 0; j < colliders.length; j++) {
        const b = colliders[j];
        // skip anything you can step over or are standing on — it isn't shielding your back
        if (b.top !== undefined && b.top - feetY <= STEP_CLEAR) continue;
        if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) { blocked++; break; }
      }
    }
    return blocked / 8;
  }

  // Ramp the wall-hug meter, then cash it out as chip damage (A) and a damage-taken
  // multiplier (B). Building requires BOTH enclosure and being stuck-in-place, so a
  // corridor (walls beside you, but you keep advancing) never triggers it. Only a
  // live fight (ctx.inCombat) can build it — cornering is a threat only when there's
  // a flank to give up, so exploring/parking against a wall between rooms is free.
  _updateCornered(dt, ctx) {
    // net-progress tracking: getting far enough from the anchor = you're moving on
    const dax = this.pos.x - this._anchor.x, daz = this.pos.z - this._anchor.z;
    if (Math.hypot(dax, daz) > CORNER_PROGRESS) {
      this._anchor.x = this.pos.x; this._anchor.z = this.pos.z; this._anchorStuck = 0;
    } else {
      this._anchorStuck += dt;
    }
    const stuck = this._anchorStuck > CORNER_STUCK_GRACE;
    // Skip the 8-point probe entirely out of combat; the meter just decays below.
    const enc = ctx.inCombat ? this._enclosure(ctx.colliders, this.yOff) : 0;

    if (!this.dead && ctx.inCombat && stuck && enc >= CORNER_ENCLOSE_MIN) {
      const over = (enc - CORNER_ENCLOSE_MIN) / (1 - CORNER_ENCLOSE_MIN); // 0..1, corner > wall
      const rate = (0.7 + 0.9 * over) / CORNER_FILL;
      this.cornered = Math.min(1, this.cornered + rate * dt);
    } else {
      this.cornered = Math.max(0, this.cornered - CORNER_DECAY * dt);
    }

    // (B) how much a hit is amplified right now — read by takeDamage
    this.pinnedMult = 1 + (CORNER_PIN_MULT - 1) * this.cornered;

    // (A) past the grace, the walls crush: chip damage applied straight to hp
    // (bypasses i-frames), scaled from the threshold up.
    if (!this.dead && this.cornered > CORNER_HURT_AT) {
      const sev = (this.cornered - CORNER_HURT_AT) / (1 - CORNER_HURT_AT);
      this.hp -= CORNER_DPS * sev * dt;
      this.sinceDamage = 0;
      // the drain never lands silently: on a beat (quickening as it worsens) the walls
      // grind in — a crush SFX + red squeeze-flash (via onCornerCrush) and a camera jolt.
      this._crushT -= dt;
      if (this._crushT <= 0) {
        this.shake = Math.min(1, this.shake + 0.12 + 0.3 * sev);
        if (this.onCornerCrush) this.onCornerCrush(sev);
        this._crushT = 0.52 - 0.24 * sev;   // 0.52s → 0.28s
      }
      if (this.hp <= 0) { this.hp = 0; this.dead = true; if (this.onDeath) this.onDeath(); }
    } else {
      this._crushT = 0;   // next time damage begins, the first crush lands at once
    }

    // heartbeat telegraph, quickening as it worsens; starts inside the grace window
    if (!this.dead && this.cornered > 0.2) {
      this._heartT -= dt;
      if (this._heartT <= 0) {
        ctx.audio.heartbeat(this.cornered);
        this._heartT = 1.15 - 0.6 * this.cornered;   // 1.15s → 0.55s
      }
    } else {
      this._heartT = 0;
    }
  }

  // A slam into a bookshelf spills its sefarim. We only trip it on a real slam — sprinting
  // into the shelf, or still reeling from an NPC's fling (knockedT) — so brushing past one
  // at a walk does nothing. The shelf owns the cooldown, so one slam yields one cascade.
  _checkShelfBump(ctx) {
    if (this.dead) return;
    const shelves = ctx.bookshelves;
    if (!shelves || !shelves.length) return;
    const slamming = (this._moving && ctx.input.sprinting()) || this.knockedT > 0;
    if (!slamming) return;
    for (const sh of shelves) {
      if (sh.touched(this.pos.x, this.pos.z, this.radius + 0.08)) sh.bump(this.pos.x, this.pos.z, ctx.audio);
    }
  }

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
    this.knockedT = 0.5;   // flung by an NPC — a shelf we crash into now spills its sefarim
    if (dmg > 0) this.takeDamage(dmg, fromPos);
  }

  // A bulvan's blow that knocks the player bodily backward: a hard positional shove away
  // from the attacker, eased via the scripted glide (see nudgeBy) so it slides — respecting
  // walls — instead of teleporting, plus a camera jolt. Distinct from knockOff, which
  // launches you off a perch into the air; this stays grounded and just puts you out of
  // position. If the player is sitting, the strike already stood them up via takeDamage.
  knockBack(fromPos, dist = 2.6) {
    if (this.dead) return;
    const dx = this.pos.x - fromPos.x, dz = this.pos.z - fromPos.z;
    const d = Math.hypot(dx, dz) || 1;
    this.nudgeBy((dx / d) * dist, (dz / d) * dist, 0.26);
    this.shake = Math.min(1.4, this.shake + 0.7);
    this.knockedT = 0.5;   // flung by an NPC — a shelf we crash into now spills its sefarim
    if (this.onKnockback) this.onKnockback({ dist });
  }

  // A mekubal's binding that leaves the legs heavy: movement speed is scaled by `factor`
  // for `dur` seconds. Refreshes the timer rather than stacking the slow deeper, and fires
  // onSlow only on the rising edge (fresh binding) so the cue/telegraph plays once.
  applySlow(factor = 0.5, dur = 2.6) {
    if (this.dead) return;
    const wasFree = this.slowT <= 0;
    this.slowFactor = factor;
    this.slowT = Math.max(this.slowT, dur);
    if (wasFree && this.onSlow) this.onSlow({ dur });
  }

  // ---- Sitting --------------------------------------------------------------
  // Find the seat the crosshair is on and classify the interaction: 'enabled' (a free
  // seat in reach), 'disabled' (looking at a seat that's out of reach or taken), or
  // 'none'. Sitting is gated to out-of-combat (ctx.canSit) so a fight is never paused
  // by parking on a bench. Sets sitState/sitSeat for the reticle + the sit trigger.
  _updateSitTarget(ctx) {
    this.sitState = 'none'; this.sitSeat = null;
    const seats = ctx.seats;
    if (this.dead || !ctx.canSit || !seats || !seats.length) return;
    const f = this.forwardXZ();
    const eyeY = EYE + this.yOff;
    let freeSeat = null, freeDist = Infinity, hoverAny = false;
    for (const s of seats) {
      const dx = s.x - this.pos.x, dz = s.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > SIT_HOVER_MAX) continue;
      const nd = dist || 1;
      if ((dx / nd) * f.x + (dz / nd) * f.z < SIT_AIM_DOT) continue;   // crosshair off the seat
      // the aim ray must pass near the seat (empty) / the occupant's lap-to-head band
      const aimY = eyeY + dist * Math.tan(this.pitch);
      if (aimY < s.y - 0.5 || aimY > s.y + 1.35) continue;
      hoverAny = true;
      if (!s.occupant && dist < freeDist) { freeDist = dist; freeSeat = s; }
    }
    if (freeSeat && freeDist <= SIT_RANGE) { this.sitState = 'enabled'; this.sitSeat = freeSeat; }
    else if (hoverAny) { this.sitState = 'disabled'; }
  }

  _sitDown(seat) {
    if (this.sitting || this.dead || seat.occupant) return;
    seat.occupant = this;
    this.sitReturn = { x: this.pos.x, z: this.pos.z };   // valid standing spot to return to
    this.pos.x = seat.x; this.pos.z = seat.z;
    this.yaw = seat.ry + Math.PI;   // face out of the seat (forwardXZ is the yaw's opposite)
    this.yOff = 0; this.vy = 0; this.grounded = true; this.vel.x = 0; this.vel.z = 0;
    this.attack = null; this.shove = null; this.buffered = null; this.nudge = null;
    this.bobActive = 0;
    this.sitting = { seat, seatX: seat.x, seatZ: seat.z, eyeY: seat.y + SIT_EYE_ABOVE_SEAT };
    this.sitState = 'none'; this.sitSeat = null;
  }

  _standUp() {
    const s = this.sitting;
    if (!s) return;
    if (s.seat && s.seat.occupant === this) s.seat.occupant = null;
    if (this.sitReturn) { this.pos.x = this.sitReturn.x; this.pos.z = this.sitReturn.z; }
    this.sitting = null; this.sitReturn = null;
  }

  _updateSitting(dt, ctx) {
    const inp = ctx.input;
    // still free to look around while seated
    const md = inp.consumeMouse();
    if (!this.dead) this.look(md.dx, md.dy, inp.sensitivity);
    // any of these stands you up (consume them all so nothing leaks into the next frame)
    const mv = inp.moveVector();
    const moved = mv.x !== 0 || mv.z !== 0;
    const acted = inp.consumeJump() | inp.consumeLight() | inp.consumeHeavy() | inp.consumeShove() | inp.consumeSit();
    if (this.dead || moved || acted) {
      this._standUp();
    } else {
      // hold the seat: pin the body and keep the camera at the seated height
      this.pos.x = this.sitting.seatX; this.pos.z = this.sitting.seatZ;
      this.bobActive = 0;
    }
    this.shake = Math.max(0, this.shake - dt * 2.2);
    this.recoil = Math.max(0, this.recoil - dt * 5);
    this.pitchPunch = this.recoil * 0.05;
    this._animateView(dt, ctx.time);
    this._applyCamera(dt);
  }

  startAttack(type) {
    if (this.dead || this.toss) return;   // committed to a throw — no jab/hook until it lands
    if (this.attack) {
      // buffer the next light attack for a combo
      if (type === 'light' && this.attack.t / this.attack.dur > 0.45) this.buffered = 'light';
      return;
    }
    // jab held off by the post-pair recovery: remember the intent so it fires the instant
    // the lockout clears (spam stays responsive) rather than dropping the input.
    if (type === 'light' && this.jabCd > 0) { this.buffered = 'light'; return; }
    const hand = this.nextHand;
    this.nextHand = hand === 'right' ? 'left' : 'right';
    if (type === 'heavy') {
      // slow, telegraphed hook: long to wind up and recover, then a real cooldown on top
      this.attack = { type, t: 0, dur: 0.68, strikeAt: 0.34, hand: 'right', dealt: false };
      this.heavyCd = 1.2;
    } else {
      // count this jab into the rapid chain (fresh chain if the window has lapsed)
      this.jabChain = this.jabChainT > 0 ? this.jabChain + 1 : 1;
      this.jabChainT = JAB_CHAIN_WINDOW;
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
    const basePoise = heavy ? HEAVY_POISE : JAB_POISE;
    const f = this.forwardXZ();
    let any = false, kills = 0, hitPos = null, anyHead = false, headPos = null, anyBreak = false, breakPos = null;
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
      // a clean shot to the kop chips extra guard too — aim breaks poise faster
      const poise = head ? basePoise * HEADSHOT_MULT : basePoise;
      const res = e.takeHit(head ? baseDmg * HEADSHOT_MULT : baseDmg, this.pos, heavy, poise);
      any = true; hitPos = e.pos;
      if (head) { anyHead = true; headPos = e.pos; }
      if (res.poiseBreak) { anyBreak = true; breakPos = e.pos; }
      ctx.audio.hit(heavy, head ? 1.5 : 1);
      if (e.isBarer) ctx.audio.barerSquawk();   // Chaim Barer squawks like a struck ostrich
      if (res.killed) { kills++; if (this.onKill) this.onKill({ score: res.score, pos: e.pos, type: e.type }); }
    }
    if (anyBreak) ctx.audio.guardBreak();
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
    // a punch into a bookshelf rattles its loose sefarim off the top shelves (see Bookshelf).
    // Like the glass it never feeds the combo — it's a solid contact with its own recoil.
    let hitShelf = false;
    if (ctx.bookshelves) {
      const bReach = reach + 0.3;
      for (const sh of ctx.bookshelves) {
        if (!sh.inStrike(this.pos.x, this.pos.z, f, bReach, cosCone)) continue;
        hitShelf = true;
        sh.bump(this.pos.x, this.pos.z, ctx.audio);
      }
    }
    if (any) {
      this.combo++; this.comboTimer = 2.2;
      ctx.audio.combo(this.combo);
      if (this.onHit) this.onHit({ combo: this.combo, heavy, kills, pos: hitPos, head: anyHead, headPos, poiseBreak: anyBreak, breakPos });
      if (this.onCombo) this.onCombo(this.combo);
      this.recoil = heavy ? 1 : 0.5;
      this.shake = Math.min(1, this.shake + (heavy ? 0.35 : 0.12) + (anyBreak ? 0.18 : 0));
    } else if (hitWindow || hitShelf) {
      // solid contact on glass or a shelf: a jolt back through the arm, but no combo/whoosh
      this.recoil = Math.max(this.recoil, heavy ? 0.8 : 0.4);
      this.shake = Math.min(1, this.shake + (heavy ? 0.22 : 0.1));
    } else {
      ctx.audio.whoosh(heavy);
    }
  }

  _startShove() {
    if (this.dead || this.shove || this.toss) return;
    // a slow, heavy heave — long two-handed thrust and a long cooldown
    this.shove = { t: 0, dur: 0.6, strikeAt: 0.38, dealt: false };
    this.shoveCd = 2.4;
  }

  _resolveShove(ctx) {
    ctx.audio.whoosh(true);
    const f = this.forwardXZ();
    let any = false, anyBreak = false, breakPos = null;
    for (const e of ctx.enemies) {
      if (e.dead) continue;
      const dx = e.pos.x - this.pos.x, dz = e.pos.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 3.4 + e.radius) continue;                    // reaches further than a punch
      const nd = dist || 1;
      if ((dx / nd) * f.x + (dz / nd) * f.z < -0.4) continue; // wide arc — catches a whole crowd, not just dead ahead
      // little direct damage, but a big chunk of guard: the shove is the crowd opener —
      // one heave cracks a whole rank open (takeHit owns the resulting stagger/knockdown).
      const res = e.takeHit(4, this.pos, true, SHOVE_POISE);
      if (e.isBarer) ctx.audio.barerSquawk();                 // Chaim Barer squawks like a struck ostrich
      e.vel.x += (dx / nd) * 13 * e.arch.knockRes;            // launches them well back to open space
      e.vel.z += (dz / nd) * 13 * e.arch.knockRes;
      if (res.poiseBreak) { anyBreak = true; breakPos = e.pos; }
      any = true;
    }
    if (anyBreak) ctx.audio.guardBreak();
    // a two-handed heave into a shelf spills its sefarim too. Tighter than the enemy arc:
    // you must be close and roughly facing it (no rattling a shelf across the room).
    let hitShelf = false;
    if (ctx.bookshelves) {
      for (const sh of ctx.bookshelves) {
        if (!sh.inStrike(this.pos.x, this.pos.z, f, 2.2, 0.3)) continue;
        hitShelf = true;
        sh.bump(this.pos.x, this.pos.z, ctx.audio);
      }
    }
    // camera nudge from the effort of the push (more when it connects)
    this.recoil = Math.max(this.recoil, (any || hitShelf) ? 0.6 : 0.35);
    if (any) {
      this.shake = Math.min(1, this.shake + 0.16 + (anyBreak ? 0.12 : 0));
      if (this.onHit) this.onHit({ combo: this.combo, shove: true, poiseBreak: anyBreak, breakPos });
    } else if (hitShelf) {
      this.shake = Math.min(1, this.shake + 0.12);
    }
  }

  update(dt, ctx) {
    const inp = ctx.input;
    this.invuln = Math.max(0, this.invuln - dt);
    this.sinceDamage += dt;
    if (this.dead) this._deadT += dt;
    this.heavyCd = Math.max(0, this.heavyCd - dt);
    this.shoveCd = Math.max(0, this.shoveCd - dt);
    this.jabCd = Math.max(0, this.jabCd - dt);
    if (this.jabChainT > 0) this.jabChainT = Math.max(0, this.jabChainT - dt);
    this.slowT = Math.max(0, this.slowT - dt);
    this.knockedT = Math.max(0, this.knockedT - dt);

    // seated: a self-contained branch — look around freely, but any move/action gets up
    if (this.sitting) { this._updateSitting(dt, ctx); return; }

    // no passive regen — only pickups (kugel) restore HP

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
          // a mekubal's binding drags the legs: cut speed while the slow debuff is active
          const slowMul = this.slowT > 0 ? this.slowFactor : 1;
          const sp = (inp.sprinting() ? this.sprintSpeed : this.speed) * dirFactor * slowMul;
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

    // scripted glide (combat-trip shove inward): apply the eased delta since last
    // frame on top of movement, then let collision below clamp it against walls.
    if (this.nudge) {
      const n = this.nudge;
      n.t += dt;
      const p = Math.min(1, n.t / n.dur);
      const eased = p * p * (3 - 2 * p);   // smoothstep — ease in and out
      const f = eased - n.done; n.done = eased;
      this.pos.x += n.dx * f; this.pos.z += n.dz * f;
      if (p >= 1) this.nudge = null;
    }

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

    // ---- wall-hug penalty (position is now final for the frame)
    this._updateCornered(dt, ctx);

    // ---- bookshelf slam: sprinting into a shelf (or being flung into one) knocks its
    // loose sefarim off the top shelves to rain down (see Bookshelf / hurtByFallingBook)
    this._checkShelfBump(ctx);

    // ---- combat input
    if (!this.dead) {
      if (inp.consumeLight()) this.startAttack('light');
      if (inp.consumeHeavy() && this.heavyCd <= 0) this.startAttack('heavy');
      if (inp.consumeShove() && this.shoveCd <= 0) this._startShove();
      if (inp.consumeThrow()) this._startToss(ctx);   // toss a shekel (guards on count/state inside)
      // a jab queued during the post-pair recovery fires the moment the lockout clears
      if (this.jabCd <= 0 && this.buffered && !this.attack) { const b = this.buffered; this.buffered = null; this.startAttack(b); }
    }

    // combo timer
    if (this.comboTimer > 0) { this.comboTimer -= dt; if (this.comboTimer <= 0 && this.combo > 0) { this.combo = 0; if (this.onCombo) this.onCombo(0); } }

    // ---- attack state
    if (this.attack) {
      const a = this.attack; a.t += dt;
      if (!a.dealt && a.t >= a.strikeAt) { a.dealt = true; this._resolveAttack(ctx); }
      if (a.t >= a.dur) {
        const wasJab = a.type === 'light';
        this.attack = null;
        // a rapid pair of jabs earns a short recovery — no instant third (weave a heavy/shove).
        // Clearing the window too guarantees the jab after the lockout starts a fresh chain.
        if (wasJab && this.jabChain >= 2) { this.jabCd = JAB_PAIR_CD; this.jabChain = 0; this.jabChainT = 0; }
        if (this.buffered && this.jabCd <= 0) { const b = this.buffered; this.buffered = null; this.startAttack(b); }
      }
    }

    // ---- shove state (two-handed push; knockback lands at the thrust peak)
    if (this.shove) {
      const s = this.shove; s.t += dt;
      if (!s.dealt && s.t >= s.strikeAt) { s.dealt = true; this._resolveShove(ctx); }
      if (s.t >= s.dur) this.shove = null;
    }

    // ---- toss state (shekel throw; the coin leaves the hand at the release frame)
    if (this.toss) {
      const s = this.toss; s.t += dt;
      if (!s.released && s.t >= s.strikeAt) { s.released = true; this._releaseToss(ctx); }
      if (s.t >= s.dur) this.toss = null;
    }

    // decay feedback
    this.shake = Math.max(0, this.shake - dt * 2.2);
    this.recoil = Math.max(0, this.recoil - dt * 5);
    this.pitchPunch = this.recoil * 0.05;

    // ---- sit interaction: find the seat under the crosshair, and sit if asked
    this._updateSitTarget(ctx);
    if (inp.consumeSit() && this.sitState === 'enabled' && this.sitSeat) this._sitDown(this.sitSeat);

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
    // seated: fixed low eye at the seat, no bob
    if (this.sitting) { px = this.pos.x; pz = this.pos.z; py = this.sitting.eyeY; }
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
    // a toss drives only the throwing (right) hand: it reaches up, then whips the coin out
    const toss = this.toss ? tossPose(this.toss.t / this.toss.dur) : null;

    const arms = [
      [this.fistL, this._restL, this._restRotL, 'left', -1],
      [this.fistR, this._restR, this._restRotR, 'right', 1],
    ];
    for (const [fist, rest, restRot, hand, sign] of arms) {
      let dx = 0, dy = 0, dz = 0, rx = 0, ry = 0, rz = 0;
      if (toss && hand === 'right') {
        dx = toss.dx; dy = toss.dy; dz = toss.dz;
        rx = toss.rx; ry = toss.ry; rz = toss.rz;
      } else if (shove) {
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
      } else if (this.sitting) {
        // hands relax down onto the lap while seated
        dx = -sign * 0.04; dy = -0.22; dz = 0.1;
        rx = 0.55;
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

// Keyframed shekel toss for the right hand (offsets on top of the rest transform). The
// hand lifts up and cocks back by the ear, then whips up-and-forward to fling the coin
// out over the crowd. dz<0 is forward (the throw direction), dy>0 lifts the hand.
const TOSS_KEYS = [
  // p     dx     dy     dz     rx     ry     rz
  [0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00],   // rest
  [0.24, 0.00, 0.20, 0.06, -0.40, 0.08, 0.08],   // wind-up: coin raised by the shoulder, held open & in view
  [0.40, 0.07, 0.24, -0.50, -1.05, 0.00, -0.05], // release: whip up-and-forward, arm extended out
  [0.60, 0.10, 0.08, -0.44, -0.80, 0.00, -0.05], // follow-through
  [1.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00],    // recover
];
function tossPose(p) {
  let a = TOSS_KEYS[0], b = TOSS_KEYS[TOSS_KEYS.length - 1];
  for (let i = 0; i < TOSS_KEYS.length - 1; i++) {
    if (p >= TOSS_KEYS[i][0] && p <= TOSS_KEYS[i + 1][0]) { a = TOSS_KEYS[i]; b = TOSS_KEYS[i + 1]; break; }
  }
  const span = b[0] - a[0] || 1;
  let t = (p - a[0]) / span;
  t = t * t * (3 - 2 * t); // smoothstep between keys
  return {
    dx: a[1] + (b[1] - a[1]) * t, dy: a[2] + (b[2] - a[2]) * t, dz: a[3] + (b[3] - a[3]) * t,
    rx: a[4] + (b[4] - a[4]) * t, ry: a[5] + (b[5] - a[5]) * t, rz: a[6] + (b[6] - a[6]) * t,
  };
}
