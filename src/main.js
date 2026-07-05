// Barer Brawl — entry point. Owns the renderer, scene, state machine, and loop.
import * as THREE from 'three';
import { initAssets, MAT, COAT_COLORS, SKIN_TONES, BEARD_TONES } from './assets.js';
import { THEMES, WALL_H } from './mapgen.js';
import { buildRoom } from './roombuilder.js';
import * as Props from './props.js';
import { buildCharacter } from './characters.js';
import { AudioEngine } from './audio.js';
import { Input } from './input.js';
import { TouchControls } from './touch.js';
import { UI } from './ui.js';
import { Player } from './player.js';
import { Director } from './director.js';
import { Cutscene } from './cutscene.js';
import { BarerFinisher } from './finisher.js';
import { RNG, newSeed } from './rng.js';

const DEATH_FLAVORS = [
  'The chevra dragged you under a mountain of sefarim.',
  'Buried beneath black hats and righteous fury.',
  'They learned you a lesson you won\'t forget.',
  'Overwhelmed in the endless halls of the yeshiva.',
  'You gave out. The bochurim did not.',
];

// Fixed seed for the title/intro backdrop so it is the SAME grand hall every time
// (gameplay reseeds per run; only this hand-authored set-piece is pinned).
const TITLE_SEED = 0x6265697320 & 0xffffffff; // "beis" — any constant; just must be stable

class Game {
  constructor() {
    this.canvas = document.getElementById('game-canvas');
    this.quality = { shadows: true, shadowSize: 1024 };

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.baseFog = new THREE.Color(0x1d1207);
    this.scene.fog = new THREE.FogExp2(this.baseFog.getHex(), 0.03);
    this.scene.background = new THREE.Color(0x0a0704);

    this.ambient = new THREE.AmbientLight(0x4a3826, 0.55);
    this.hemi = new THREE.HemisphereLight(0x6a5236, 0x140a04, 0.5);
    this.scene.add(this.ambient, this.hemi);

    initAssets();

    this.audio = new AudioEngine();
    this.input = new Input(this.canvas);
    // touch devices (phone/tablet) drive an on-screen control layer instead of
    // mouse-look + pointer lock; the primary pointer being "coarse" is the signal.
    this.isTouch = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
      || (('ontouchstart' in window) && (navigator.maxTouchPoints || 0) > 0
          && !(window.matchMedia && window.matchMedia('(pointer: fine)').matches));
    if (this.isTouch) document.body.classList.add('touch');
    this.touch = this.isTouch
      ? new TouchControls(this.input, {
          onPause: () => this._pause(),
          onOrientation: (portrait) => { if (portrait && this.state === 'playing') this._pause(); },
        })
      : null;
    this.ui = new UI(this.audio);
    this.player = new Player();
    this.player.fists.visible = false; // hidden until gameplay; keeps boot/start gate clean
    this._baseFov = this.player.camera.fov; // rest FOV, restored after the finisher punch-in
    this.scene.add(this.player.camera);

    this.rng = new RNG(newSeed());
    this.director = new Director(this);

    this.cutscene = new Cutscene(this.player.camera, this.ui, this.audio);
    this.finisher = new BarerFinisher(this.player, this.ui, this.audio);
    this.finisherActive = false;

    this.state = 'boot';
    this.time = 0;
    this.score = 0; this.kills = 0; this.bestCombo = 0; this.startTime = 0;
    this.awaitingLock = false;
    this.dying = false; this.dieTimer = 0;
    this.introHostile = 0;
    this.backdrop = null;
    this._orbit = 0;
    this._soundReturn = 'menu';
    this._tmp = new THREE.Vector3();

    this._wireCallbacks();
    this._wireEvents();

    window.addEventListener('resize', () => this._resize());
    this._resize();

    this._last = performance.now();
    requestAnimationFrame((t) => this._loop(t));

    this._boot();
  }

  addScore(n) { this.score += n; this.ui.setScore(this.score); }

  floaty3d(pos, text, opts = {}) {
    this._tmp.set(pos.x, 1.5, pos.z).project(this.player.camera);
    if (this._tmp.z > 1) return;
    const x = (this._tmp.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-this._tmp.y * 0.5 + 0.5) * window.innerHeight;
    this.ui.floaty(x, y, text, opts);
  }

  _wireCallbacks() {
    const p = this.player;
    p.onDamage = (info) => { this.audio.playerHurt(); this.ui.damageFlash(Math.min(0.9, 0.3 + info.dmg / 45)); };
    p.onHit = (info) => {
      // a broken guard is the cue to pile on — call it out, and teach the loop once
      if (info.poiseBreak && info.breakPos) {
        this.floaty3d(info.breakPos, 'GUARD BROKE!', { color: '#ffd24a', crit: true, size: 22 });
        if (!this._taughtBreak) {
          this._taughtBreak = true;
          this.ui.toast('Guard broken! Pile on while they’re staggered — every hit lands harder.', 3.4);
        }
      }
      if (info.shove) return;
      this.ui.hitmarker();
      // reward a clean shot to the kop with a little pop of feedback
      if (info.head && info.headPos) this.floaty3d(info.headPos, 'KOP!', { color: '#ffe27a', crit: true, size: 20 });
    };
    p.onCombo = (n) => { this.ui.setCombo(n); if (n > this.bestCombo) this.bestCombo = n; };
    p.onKill = (info) => {
      const base = info.score || 100;
      const mult = 1 + (this.player.combo * 0.12);
      const pts = Math.round(base * mult * (1 + this.director.depth * 0.05));
      this.addScore(pts);
      this.director.reportKill(info);
      this.floaty3d(info.pos, `+${pts}`, { color: info.type === 'bochur' ? '#f4d878' : '#ff9a4a', crit: info.type !== 'bochur', size: info.type !== 'bochur' ? 28 : 22 });
    };
    p.onDeath = () => this._onPlayerDeath();

    this.ui.onAction = (act) => this._onAction(act);
  }

  _wireEvents() {
    this.canvas.addEventListener('mousedown', () => {
      this.audio.init();
      if (this.state === 'playing' && this.awaitingLock && !this.input.locked) this.input.requestLock();
    });
    // touch: a tap begins play directly (no pointer lock on phones/tablets)
    if (this.isTouch) {
      this.canvas.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return;
        this.audio.init();
        if (this.touch.isPortrait()) return;
        if (this.state === 'intro') this.cutscene.skip();
        else if (this.state === 'playing' && this.awaitingLock) this._beginTouch();
      });
    }
    this.input.onLockChange = (locked) => {
      if (this.state === 'playing') {
        if (locked) { this.awaitingLock = false; this.ui.showPrompt(false); this.input.setEnabled(true); }
        else if (!this.dying) { this._pause(); }
      }
    };
    window.addEventListener('keydown', (e) => {
      if ((e.code === 'Enter' || e.code === 'Escape') && this.state === 'intro') this.cutscene.skip();
      // Esc backs out of a submenu (How to Brawl / Sound) to wherever it was opened from,
      // mirroring the on-screen Back button. The top-level menus aren't submenus, so they're
      // left alone (and during play, Esc keeps exiting pointer-lock to pause).
      if (e.code === 'Escape' && !e.repeat) {
        const scr = this.ui.currentScreen;
        if (scr === 'help') { this.audio.ui('click'); this._onAction('help-back'); return; }
        if (scr === 'sound') { this.audio.ui('click'); this._onAction('sound-back'); return; }
      }
      if (e.code === 'KeyM' && !e.repeat) {
        const muted = this.audio.toggleMute();
        this.ui.toast(muted ? '🔇 Muted' : '🔊 Unmuted');
      }
    });
    window.addEventListener('blur', () => { if (this.state === 'playing' && !this.awaitingLock) this._pause(); });
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.player.camera.aspect = w / h;
    this.player.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- states
  async _boot() {
    this.ui.showScreen('loading');
    for (let i = 0; i <= 100; i += 12) { this.ui.setLoading(i); await sleep(45); }
    this.ui.setLoading(100, 'Bo\'i b\'shalom…'); await sleep(200);
    // Land on a click-to-enter gate first: the click is the user gesture that lets
    // the AudioContext start, so menu music/ambience play the instant we hit the title.
    this.state = 'start';
    this.ui.showScreen('start');
    this.ui.fade(false, 1.0);
  }

  _toTitle() {
    this.state = 'title';
    this.dying = false;
    this._ensureBackdrop();
    this.player.fists.visible = false;
    this.ui.showHUD(false);
    this.ui.hideScreens();
    this.ui.showScreen('menu');
    this.ui.setBoss(null, null); this.ui.setBarer(null);
    this.audio.setMusic('menu');
    this.audio.ambient(true);
    this.input.setEnabled(false);
    this.input.exitLock();
    if (this.touch) this.touch.setVisible(false);
    this.introHostile = 0;
    this._resetTint();
  }

  _onAction(act) {
    this.audio.init(); // first call (from the start gate) is the gesture that unlocks audio
    switch (act) {
      case 'enter': this._toTitle(); break;
      case 'begin': this._startIntro(); break;
      case 'skip': this._startGameplay(); break;
      case 'help': this._helpReturn = this.state === 'paused' ? 'pause' : 'menu'; this.ui.showScreen('help'); break;
      case 'help-back': this.ui.showScreen(this._helpReturn || 'menu'); break;
      case 'sound': this._soundReturn = this.state === 'paused' ? 'pause' : 'menu'; this.ui.syncSoundControls(); this.ui.showScreen('sound'); break;
      case 'sound-back': this.ui.showScreen(this._soundReturn || 'menu'); break;
      case 'quit': this._quit(); break;
      case 'resume': this._resume(); break;
      case 'restart': this._startGameplay(); break;
      case 'retry': this._startGameplay(); break;
      case 'tomenu': this.ui.fade(true, 0.4); setTimeout(() => { this.ui.fade(false, 0.6); this._toTitle(); }, 420); break;
    }
  }

  _startIntro() {
    this.ui.hideScreens();
    this.ui.showHUD(false);
    if (this.touch) this.touch.setVisible(false);
    this.player.fists.visible = false;
    this._ensureBackdrop();
    this.introHostile = 0;
    this._resetTint();
    this.state = 'intro';
    this.audio.setMusic('menu');
    this.cutscene.play(this._introBeats(), () => {
      this.ui.fade(true, 0.7);
      setTimeout(() => this._startGameplay(), 720);
    });
  }

  _startGameplay() {
    this._disposeBackdrop();
    this.ui.hideScreens();
    this.ui.showHUD(true);
    if (this.touch) this.touch.setVisible(false); // shown once the player taps to begin
    this.player.fists.visible = true;
    this._resetTint();
    this.state = 'playing';
    this.dying = false;
    this.score = 0; this.kills = 0; this.bestCombo = 0;
    this.startTime = this.time;
    this.ui.setScore(0); this.ui.setCombo(0); this.ui.setBoss(null, null); this.ui.setBarer(null);

    this.rng = new RNG(newSeed());
    this.director.start();
    this.ui.setHealth(1);

    this.awaitingLock = true;
    this.input.setEnabled(false);
    this.ui.showPrompt(true);
    this.ui.fade(false, 0.8);
  }

  // touch equivalent of acquiring pointer lock: a tap enables input + shows the pads
  _beginTouch() {
    this.awaitingLock = false;
    this.ui.showPrompt(false);
    this.input.setEnabled(true);
    if (this.touch) this.touch.setVisible(true);
  }

  _pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.setEnabled(false);
    this.input.exitLock();
    if (this.touch) this.touch.setVisible(false);
    this.audio.setMusic('menu');
    this.ui.showScreen('pause');
  }
  _resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.ui.hideScreens();
    this.awaitingLock = true;
    this.ui.showPrompt(true);
    // combat music resumes when a fight is active
    if (this.director.roomState === 'combat') this.audio.setMusic('combat');
  }

  _onPlayerDeath() {
    if (this.dying) return;
    this.dying = true;
    this.dieTimer = 2.6;
    this.awaitingLock = false;
    this.input.setEnabled(false);
    this.input.exitLock();
    if (this.touch) this.touch.setVisible(false);
    this.audio.setMusic(null);
    this.audio.ambient(false);
    this.audio.enemyDie(0.6);
    this.ui.hideObjective();
    this.ui.setBoss(null, null); this.ui.setBarer(null);
  }

  // ---- Barer down: a brief cinematic "time stops" beat before the finisher --------
  // The world freezes, the camera locks onto Chaim Barer as he buckles to his knees, the
  // FOV punches in and the letterbox slides shut over a low sting; a quick dip to black
  // then hands off to the interactive finisher. Kicked off by the director the frame he
  // drops (state 'playing' -> 'barerdown').
  _beginBarerDown(barer) {
    this.state = 'barerdown';
    this._bdBarer = barer;
    this._bdT = 0;
    this._bdDur = 1.35;
    this._bdFlashed = false;

    this.player.fists.visible = false;     // no floating FPS hands over the cinematic
    barer.bar.visible = false;             // drop his floating HP bar
    this.ui.setBarer(null); this.ui.setBoss(null, null);
    this.ui.hideObjective();
    this.ui.showHUD(false);
    this.ui.showCinema();                  // letterbox slides shut

    // duck the driving combat track and hit the dramatic sting
    this.audio.setMusic('menu');
    this.audio.setIntensity(0);
    this.audio.hit(true, 0.6);
    this.audio.barerShriek();   // his long, agonized ostrich death-scream as time slows
    this.audio.finisherSting();
    this.player.shake = Math.min(1.5, this.player.shake + 1.0);

    // capture the camera's current framing, then solve the locked-on close-up on Barer
    const cam = this.player.camera;
    this._bdFromPos = cam.position.clone();
    this._bdFromYaw = this.player.yaw;
    this._bdFromPitch = this.player.pitch;
    this._bdFromFov = cam.fov;
    this._bdToFov = 46;                     // punch in

    const dx = barer.pos.x - this._bdFromPos.x, dz = barer.pos.z - this._bdFromPos.z;
    const horiz = Math.hypot(dx, dz) || 1;
    this._bdToYaw = Math.atan2(-dx, -dz);                 // forwardXZ = (-sin y, -cos y)
    const faceY = barer.groundY + 1.15;                  // aim at the beaten figure's face/chest
    this._bdToPitch = Math.atan2(faceY - this._bdFromPos.y, horiz);
    // creep a little closer for the push-in, but stay well short so we never clip him/walls
    const dolly = Math.max(0, Math.min(0.7, horiz - 1.5));
    this._bdToPos = this._bdFromPos.clone();
    this._bdToPos.x += (dx / horiz) * dolly;
    this._bdToPos.z += (dz / horiz) * dolly;
  }

  _updateBarerDown(dt) {
    this._bdT += dt;
    const raw = Math.min(1, this._bdT / this._bdDur);
    const p = raw * raw * (3 - 2 * raw);   // smoothstep the whole move

    // the world is frozen (director/enemy update paused) — drive Barer's crumple directly
    if (this._bdBarer) this._bdBarer.crumple(Math.min(1, this._bdT / 0.7), this.time);

    // ease the camera into a locked, pushed-in framing on him, with a decaying shake
    const cam = this.player.camera;
    this.player.shake = Math.max(0, this.player.shake - dt * 1.5);
    const sh = this.player.shake * 0.05;
    const yaw = this._bdFromYaw + shortAngle(this._bdFromYaw, this._bdToYaw) * p;
    const pitch = lerp(this._bdFromPitch, this._bdToPitch, p);
    cam.position.set(
      lerp(this._bdFromPos.x, this._bdToPos.x, p) + (Math.random() * 2 - 1) * sh,
      lerp(this._bdFromPos.y, this._bdToPos.y, p) + (Math.random() * 2 - 1) * sh,
      lerp(this._bdFromPos.z, this._bdToPos.z, p) + (Math.random() * 2 - 1) * sh,
    );
    cam.rotation.set(pitch, yaw, (Math.random() * 2 - 1) * this.player.shake * 0.02, 'YXZ');
    cam.fov = lerp(this._bdFromFov, this._bdToFov, p);
    cam.updateProjectionMatrix();
    this.player.viewRig.position.copy(cam.position);
    this.player.viewRig.quaternion.copy(cam.quaternion);

    // quick dip to black near the end to hide the swap into the finisher overlay
    if (!this._bdFlashed && this._bdT >= this._bdDur - 0.22) {
      this._bdFlashed = true;
      this.ui.fade(true, 0.2);
    }

    // swallow any input so a click during the beat can't leak into the finisher / resumed run
    this.input.consumeMouse();
    this.input.consumeLight(); this.input.consumeHeavy(); this.input.consumeShove();

    if (this._bdT >= this._bdDur) {
      const b = this._bdBarer; this._bdBarer = null;
      this._startFinisher(b);
      this.ui.fade(false, 0.4);            // reveal the finisher as its face pushes in
    }
  }

  // ---- Barer finisher: a frozen, interactive close-up before the door opens -------
  _startFinisher(barer) {
    this.finisherActive = true;
    this.state = 'finisher';
    if (barer) barer.root.visible = false; // the overlay takes over from the world figure
    // the transition punched the FOV in; restore rest FOV so the close-up frames as designed
    this.player.camera.fov = this._baseFov;
    this.player.camera.updateProjectionMatrix();
    this.player.fists.visible = false;     // the finisher renders its own hands
    this.ui.showHUD(false);
    this.ui.showCinema();                  // cinematic letterbox
    this.ui.setBoss(null, null); this.ui.setBarer(null);
    // keep pointer lock + input enabled; the finisher reads clicks off the document
    this.finisher.begin(barer, { onDone: () => this._endFinisher() });
    // pre-build + GPU-warm the next room now, while the finisher is frozen and the screen
    // is still black from the transition dip, so returning to the world doesn't hitch
    this.director.pregenNextRoom();
  }

  _updateFinisher(dt) {
    this.finisher.update(dt);
    // decay + apply camera shake on the otherwise-frozen camera (player.update isn't running)
    this.player.shake = Math.max(0, this.player.shake - dt * 2.2);
    this.player._applyCamera(dt);
    // drain any accumulated look/click input so it can't leak into the resumed run
    this.input.consumeMouse();
    this.input.consumeLight(); this.input.consumeHeavy(); this.input.consumeShove();
  }

  _endFinisher() {
    this.finisher.end();
    this.finisherActive = false;
    this.ui.hideCinema();
    this.ui.showHUD(true);
    this.player.fists.visible = true;
    this.state = 'playing';
    this.director.finishBarerEncounter();
    // seamless return to play — input/lock were never dropped
  }

  // ---- debug helpers (headless smoke test) ----
  _debugFinisher() { if (this.state === 'playing') this._startFinisher(null); }
  // spawn a downed Barer in front of the player and run the full down->finisher transition
  _debugBarerDown() {
    if (this.state !== 'playing') return;
    const b = this.director.debugSpawnBarerNearPlayer(true);
    b.state = 'downed'; b.setFace('attack2');
    this.director.barer = b;
    this._beginBarerDown(b);
  }

  _showGameOver() {
    this.state = 'gameover';
    const t = Math.max(0, this.time - this.startTime);
    this.ui.setGameOver(
      { depth: this.director.depth, kills: this.director.kills, bestCombo: this.bestCombo, score: this.score, time: fmtTime(t) },
      DEATH_FLAVORS[(this.score + this.director.depth) % DEATH_FLAVORS.length],
    );
    this.ui.showHUD(false);
    this.ui.showScreen('gameover');
  }

  _quit() {
    this.audio.setMusic(null);
    this.ui.showScreen('quit');
    setTimeout(() => { try { window.close(); } catch (e) {} }, 200);
  }

  // ---------------------------------------------------------------- backdrop
  _ensureBackdrop() { if (!this.backdrop) this._buildBackdrop(); }

  // The title/intro set-piece: a grand, hand-authored beis medrash, always the same.
  // Built off a FIXED seed so the room layout and the whole cast are identical every
  // visit; extra hero pieces (aron kodesh, bimah, candelabra, chandeliers) are placed
  // by hand on top of the deterministic base for an over-the-top opening tableau.
  _buildBackdrop() {
    const rng = new RNG(TITLE_SEED);
    const cell = backdropCell();
    const S = cell.maxX;         // half-extent of the room
    const warm = 0xffca82;
    const backZ = -S + 0.7;      // the far wall the ark stands against
    const bimahZ = backZ + 2.7;  // raised platform out in front of the ark
    const elderZ = bimahZ + 1.9; // the two elders stand just ahead of the bimah

    // Claim the whole "stage" at the head of the hall — plus the two elders' spots —
    // BEFORE the room decorates itself, so its procedural tables/benches and the
    // scattered crowd both keep clear of the hand-placed set-piece below (which is
    // otherwise invisible to the room's occupancy). Without this the fixed seed can
    // drop a study table straight through the bimah and wedge an elder inside it.
    const reserve = [
      { x: 0, z: -S + 0.9, hx: 3.4, hz: 1.3 }, // ark + ner tamid + flanking candelabra, along the back wall
      { x: 0, z: bimahZ,    hx: 2.0, hz: 1.5 }, // bimah platform + shtender
      { x: 0, z: elderZ,    hx: 2.0, hz: 0.7 }, // the two elders in front of the bimah
    ];

    const inst = buildRoom(cell, rng, this.quality, reserve);
    this.scene.add(inst.group);
    // both gates thrown open so the hall reads as calm and endless
    inst.entranceGate.openInstant();
    inst.exitGate.openInstant();

    // ---- centerpiece: the Aron Kodesh, framed down the length of the hall ------
    const aron = Props.aronKodesh();
    aron.position.set(0, 0, backZ);   // faces +Z, toward the entrance / camera
    inst.group.add(aron);
    this._addBackdropLight(inst, rng, 0xff7a2a, 4.5, 9, 0, WALL_H - 1.6, backZ + 0.9); // ner tamid
    this._addBackdropLight(inst, rng, warm, 6, 11, 0, 2.6, backZ + 1.6);               // gold up-wash

    // ---- twin candelabra flanking the ark --------------------------------------
    for (const sx of [-2.0, 2.0]) {
      const cand = titleCandelabra();
      cand.group.position.set(sx, 0, backZ + 0.8);
      inst.group.add(cand.group);
      inst.flames.push(...cand.flames);
      this._addBackdropLight(inst, rng, warm, 3.2, 6, sx, 3.0, backZ + 0.8);
    }

    // ---- a raised bimah + shtender in front of the ark -------------------------
    const plat = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.36, 2.6), MAT.woodMid);
    plat.position.set(0, 0.18, bimahZ); plat.castShadow = true; plat.receiveShadow = true;
    inst.group.add(plat);
    const shtender = Props.shtender();
    shtender.position.set(0, 0.36, bimahZ - 0.4);
    inst.group.add(shtender);

    // ---- extra chandeliers to light the length of the grand hall ---------------
    for (const cz of [-2, 5]) {
      const ch = Props.chandelier(8, 0.95);
      ch.position.set(0, WALL_H - 1.1, cz);
      inst.group.add(ch); inst.flames.push(...ch.userData.flames);
      this._addBackdropLight(inst, rng, warm, 10, S * 1.8, 0, WALL_H - 1.4, cz);
    }

    // ---- the cast --------------------------------------------------------------
    const actors = [];
    const spawnActor = (opts, x, z, faceX, faceZ) => {
      const b = buildCharacter(opts);
      b.root.position.set(x, 0, z);
      b.root.rotation.y = Math.atan2(faceX - x, faceZ - z);
      b.phase = rng.range(0, 6.28);
      this.scene.add(b.root);
      actors.push(b);
      return b;
    };

    // two distinguished elders flanking the bimah, turned to face the hall
    spawnActor({ coat: 0x0d0d10, skin: 0xc99c72, beard: 0x8a8073, hat: 'homburg', bigBeard: true, glasses: true },
      -1.0, elderZ, -1.0, 40);
    spawnActor({ coat: 0x101014, skin: 0xba895f, beard: 0x6a5a4a, hat: 'big', bigBeard: true, glasses: false },
      1.0, elderZ, 1.0, 40);

    // a full hall of bochurim, scattered clear of the furniture, all turned toward
    // the ark. randomSpawn draws from guaranteed-clear grid points; a fixed seed makes
    // the whole crowd deterministic, and the avoid-circle keeps the bimah zone open.
    // `taken` (with a 1.5m separation) stops two bochurim landing on the same spot.
    const crowd = 14;
    const taken = [];
    for (let i = 0; i < crowd; i++) {
      const p = inst.randomSpawn(rng, { x: 0, z: -S }, 6.5, taken, 1.5);
      taken.push(p);
      spawnActor({
        coat: rng.pick(COAT_COLORS), skin: rng.pick(SKIN_TONES), beard: rng.pick(BEARD_TONES),
        hat: rng.chance(0.62) ? 'fedora' : (rng.chance(0.5) ? 'homburg' : 'big'),
        bigBeard: rng.chance(0.4), glasses: rng.chance(0.32),
      }, p.x, p.z, 0, -S);
    }

    this.backdrop = { inst, actors, lightBase: inst.lights.map((l) => ({ l, color: l.light.color.clone(), base: l.base })) };
  }

  // a warm flickering point light bound to the backdrop instance so it animates
  // (inst.update) and tints with the intro (lightBase). Mirrors roombuilder's own.
  _addBackdropLight(inst, rng, color, intensity, dist, x, y, z) {
    const L = new THREE.PointLight(color, intensity, dist, 2);
    L.position.set(x, y, z);
    inst.group.add(L);
    inst.lights.push({ light: L, base: intensity, phase: rng.range(0, 6.28), speed: 5.5 + rng.range(0, 3) });
    return L;
  }

  _disposeBackdrop() {
    if (!this.backdrop) return;
    this.backdrop.inst.dispose(this.scene);
    for (const a of this.backdrop.actors) {
      this.scene.remove(a.root);
      a.root.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
      const m = a.root.userData.mats; for (const k in m) m[k].dispose();
    }
    this.backdrop = null;
  }

  _resetTint() {
    this.scene.fog.color.copy(this.baseFog);
    this.ambient.color.setHex(0x4a3826); this.ambient.intensity = 0.55;
    this.hemi.intensity = 0.5;
    if (this.backdrop) for (const b of this.backdrop.lightBase) { b.l.light.color.copy(b.color); b.l.light.intensity = b.base; }
  }

  _applyIntroTint(h) {
    // warm hall -> ominous red as the bochurim turn
    const red = new THREE.Color(0xff2a12);
    this.scene.fog.color.copy(this.baseFog).lerp(new THREE.Color(0x260403), h);
    this.ambient.intensity = 0.55 * (1 - h) + 0.25 * h;
    this.hemi.intensity = 0.5 * (1 - h) + 0.2 * h;
    if (this.backdrop) for (const b of this.backdrop.lightBase) {
      b.l.light.color.copy(b.color).lerp(red, h * 0.85);
      b.l.light.intensity = b.base * (1 - 0.3 * h) * (1 + 0.5 * h * (0.5 + 0.5 * Math.sin(this.time * 12)));
    }
  }

  _poseActors(h) {
    if (!this.backdrop) return;
    for (const a of this.backdrop.actors) {
      const j = a.root.userData.joints, s = Math.sin(this.time * 1.4 + a.phase);
      // calm: hunched over a sefer.  hostile: straighten & glare, arms ready
      j.torso.rotation.x = 0.45 * (1 - h) + (-0.06) * h + s * 0.02;
      j.head.rotation.x = 0.42 * (1 - h) + (-0.18) * h;
      j.torso.rotation.y = s * 0.04 * (1 - h);
      j.shoulderL.rotation.x = 0.55 * (1 - h) - 0.25 * h; j.shoulderL.rotation.z = 0.2;
      j.shoulderR.rotation.x = 0.55 * (1 - h) - 0.25 * h; j.shoulderR.rotation.z = -0.2;
      // elbows fold the forearm FORWARD (toward +Z / the sefer); positive x would
      // hyperextend it back behind the upper arm.
      j.elbowL.rotation.x = -0.7 * (1 - h) - 0.9 * h; j.elbowR.rotation.x = -0.7 * (1 - h) - 0.9 * h;
      a.root.position.y = h * Math.max(0, Math.sin(this.time * 8 + a.phase)) * 0.02; // menacing shudder
    }
  }

  _introBeats() {
    const G = this;
    return [
      {
        duration: 6, subtitle: 'For years, you learned here — day and night, without end.',
        cam: { from: { pos: [0, 6.5, 9], look: [0, 1.6, 0] }, to: { pos: [0, 2.4, 5.5], look: [0, 1.4, -2] } },
      },
      {
        duration: 6, subtitle: 'Shoulder to shoulder with the chevra. Your friends. Your <b>chavrusa</b>.',
        cam: { from: { pos: [-5.5, 2.0, 3], look: [0, 1.4, -1] }, to: { pos: [5.5, 2.0, 3], look: [0, 1.4, -1] } },
      },
      {
        duration: 5.5, subtitle: 'Until this morning… when something in the yeshiva <span class="em">turned</span>.',
        cam: { from: { pos: [3, 1.7, -1], look: [-3, 1.5, 1] }, to: { pos: [1.5, 1.7, -1.5], look: [-3.2, 1.5, 0.4] } },
        onUpdate: (bt, p) => { G.introHostile = Math.min(0.35, p * 0.35); },
      },
      {
        duration: 4.5, subtitle: '<b>They rise.</b>',
        cam: { from: { pos: [0, 1.7, 6], look: [0, 1.6, 0] }, to: { pos: [0, 1.9, 8.5], look: [0, 1.5, -1] } },
        onEnter: () => { G.audio.shofar(); G.audio.gate(false); },
        onUpdate: (bt, p) => { G.introHostile = 0.35 + 0.65 * Math.min(1, p * 1.4); },
      },
      {
        duration: 5, subtitle: 'Fists up. Smash your way out — hall by endless hall.',
        cam: { from: { pos: [0, 1.66, 7.5], look: [0, 1.55, -6] }, to: { pos: [0, 1.66, 4.5], look: [0, 1.55, -8] } },
        onUpdate: () => { G.introHostile = 1; },
      },
      {
        duration: 4, subtitle: 'There is no end. Only how deep you get.', fade: undefined,
        cam: { from: { pos: [0, 1.66, 3.5], look: [0, 1.5, -8] }, to: { pos: [0, 1.66, 1.5], look: [0, 1.5, -8] } },
        onUpdate: () => { G.introHostile = 1; },
      },
    ];
  }

  // ---------------------------------------------------------------- loop
  _loop(now) {
    requestAnimationFrame((t) => this._loop(t));
    let dt = (now - this._last) / 1000; this._last = now;
    if (dt > 0.05) dt = 0.05;
    this.time += dt;

    switch (this.state) {
      case 'title': this._updateTitle(dt); break;
      case 'intro': this._updateIntro(dt); break;
      case 'playing': this._updatePlaying(dt); break;
      case 'barerdown': this._updateBarerDown(dt); break;
      case 'finisher': this._updateFinisher(dt); break;
      case 'paused': break;
      default: break;
    }

    this.ui.update(dt);
    this.input.endFrame();

    this.renderer.render(this.scene, this.player.camera);
    // second pass: draw the first-person hands (or the finisher tableau) over the world
    if (this.player.fists.visible || this.finisherActive) {
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.player.viewScene, this.player.camera);
      this.renderer.autoClear = true;
    }
  }

  _updateTitle(dt) {
    // slow, stately orbit around the front of the hall — the radius + forward
    // offset keep the camera clear of the ark at the back wall while sweeping the
    // crowd, chandeliers, and the ark at the head of the hall.
    this._orbit += dt * 0.05;
    const r = 7.5, cam = this.player.camera;
    cam.position.set(Math.sin(this._orbit) * r, 3.3 + Math.sin(this._orbit * 0.6) * 0.7, Math.cos(this._orbit) * r + 0.5);
    cam.lookAt(0, 1.7, -3);
    if (this.backdrop) { this.backdrop.inst.update(dt, this.time); this._poseActors(0); }
  }

  _updateIntro(dt) {
    this.cutscene.update(dt);
    if (this.backdrop) this.backdrop.inst.update(dt, this.time);
    this._applyIntroTint(this.introHostile);
    this._poseActors(this.introHostile);
  }

  _updatePlaying(dt) {
    if (this.awaitingLock) {
      // still show the world; wait for the click-to-lock
      this.director.update(0.0001, this.time);
      this.ui.setHealth(this.player.hp / this.player.maxHp);
      return;
    }
    const colliders = this.director.currentColliders();
    this.player.update(dt, {
      input: this.input, colliders, enemies: this.director.enemies,
      windows: this.director.currentWindows(),
      audio: this.audio, time: this.time,
    });
    this.director.update(dt, this.time);
    this.ui.setHealth(this.player.hp / this.player.maxHp);
    this.ui.setCorner(this.player.cornered, dt);

    if (this.dying) {
      this.dieTimer -= dt;
      if (this.dieTimer <= 0) this._showGameOver();
    }
  }
}

// A hand-authored room used as the title/intro backdrop. Larger than a normal room
// so the camera can orbit inside it and the grand hall reads as spacious.
function backdropCell() {
  const S = 10;
  return {
    type: 'room', index: 0, depth: 0, theme: 'beis_medrash', boss: false,
    minX: -S, maxX: S, minZ: -S, maxZ: S,
    center: { x: 0, z: 0 }, size: { dep: 2 * S, wid: 2 * S },
    entryDir: { x: 0, z: 1 }, entryPoint: { x: 0, z: S },
    exitDir: { x: 0, z: -1 }, exitPoint: { x: 0, z: -S },
    gapW: 3.6, themeData: THEMES.beis_medrash,
  };
}

// A tall floor candelabra (7 candles across a brass bar) for the title tableau.
// Returns { group, flames } so the caller can register the flames for flicker.
function titleCandelabra() {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.46, 0.16, 16), MAT.brassDark);
  base.position.y = 0.08; base.castShadow = true; g.add(base);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 2.3, 12), MAT.brass);
  stem.position.y = 1.2; stem.castShadow = true; g.add(stem);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), MAT.brass);
  knob.position.y = 2.3; g.add(knob);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.06, 0.06), MAT.brass);
  arm.position.y = 2.36; arm.castShadow = true; g.add(arm);
  const flames = [];
  for (let i = -3; i <= 3; i++) {
    const cs = Props.candlestick();
    // gentle arc: the central candle rides highest
    cs.position.set(i * 0.3, 2.4 + (3 - Math.abs(i)) * 0.035, 0);
    g.add(cs);
    flames.push(...cs.userData.flames);
  }
  return { group: g, flames };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function lerp(a, b, t) { return a + (b - a) * t; }
// signed shortest angular delta from `from` to `to` (radians), so a yaw ease never
// takes the long way round the circle
function shortAngle(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function fmtTime(s) {
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, '0')}`;
}

window.addEventListener('DOMContentLoaded', () => { window.__game = new Game(); });
