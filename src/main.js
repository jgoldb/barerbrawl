// Barer Brawl — entry point. Owns the renderer, scene, state machine, and loop.
import * as THREE from 'three';
import { initAssets, MAT, COAT_COLORS, SKIN_TONES, BEARD_TONES } from './assets.js';
import { THEMES, WALL_H } from './mapgen.js';
import { buildRoom } from './roombuilder.js';
import * as Props from './props.js';
import { buildCharacter, sitPose } from './characters.js';
import { AudioEngine } from './audio.js';
import { Input } from './input.js';
import { TouchControls } from './touch.js';
import { UI } from './ui.js';
import { Player } from './player.js';
import { Director } from './director.js';
import { Cutscene } from './cutscene.js';
import { DvarTorah } from './dvartorah.js';
import { ChavrusaScene } from './chavrusa.js';
import { BarerFinisher } from './finisher.js';
import { VO_IDS } from './vo-manifest.js';
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

// True only when served from a local machine — mirrors the service-worker gate in
// index.html. Debug-only keybinds hang off this so they never reach the deployed site.
const IS_LOCAL_DEV = (() => {
  const host = location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' ||
    host === '::1' || host === '' || host.endsWith('.local');
})();

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
    // Bake the lazily-generated window textures now, before any seeded scene build, so the
    // deterministic title backdrop renders identically on first load and every revisit
    // (see props.warmWindowMaterials).
    Props.warmWindowMaterials();

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
    // set-piece cut-scenes: the dvar-torah (first boss cleared) and the chavrusa with
    // Rabbi Zehnwirth (second boss cleared). `cut` is whichever is currently running.
    // `_dvarShown`/`_zehnShown` are PER-RUN (reset in _startGameplay) — they route the
    // director's next boss (dvar -> zehn). `_streakSeen` spans a restart-streak: any scene
    // seen in an earlier run of the streak is bypassed on re-run, and it's cleared whenever
    // we return to the title (quit-to-title / fresh game); a refresh clears it too. See
    // _triggerCutscene / _startGameplay / _toTitle.
    this.dvar = null; this.chav = null; this.cut = null;
    this._dvarShown = false; this._dvarPending = false;
    this._zehnShown = false; this._zehnPending = false;
    this._streakSeen = new Set();
    this._cutStarting = false;

    this.state = 'boot';
    this.time = 0;
    this.score = 0; this.kills = 0; this.bestCombo = 0; this.startTime = 0;
    this.awaitingLock = false;
    this.dying = false; this.dieTimer = 0;
    this.introHostile = 0;
    this.backdrop = null;
    this._orbit = 0;
    this._soundReturn = 'menu';
    this._csPreview = false; // true while a cut-scene is being previewed from the title
    this._tmp = new THREE.Vector3();
    this._perfTag = null;    // dev-only: tags the frame's heavy work for the spike logger (see _loop)

    this._wireCallbacks();
    this._wireEvents();
    // local dev only: a title-menu gallery to replay any single cut-scene in isolation
    if (IS_LOCAL_DEV) this._setupCutsceneGallery();

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
    p.onDamage = (info) => { if (!info.book) this.audio.playerHurt(); this.ui.damageFlash(Math.min(0.9, 0.3 + info.dmg / 45)); };
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
    // the two later-game disruptors announce themselves — a heavy body-check whump when a
    // bulvan shoves you, an eerie hex when a mekubal binds your legs; each teaches once
    p.onKnockback = () => {
      this.audio.bulvanSlam();
      if (!this._taughtKnock) { this._taughtKnock = true; this.ui.toast('A bulvan bowled you over! The big brutes knock you clear out of position — keep your footing.', 3.4); }
    };
    p.onSlow = () => {
      this.audio.hex();
      if (!this._taughtSlow) { this._taughtSlow = true; this.ui.toast('A mekubal bound your legs — you’re slowed. Break away and wait it out before you press in.', 3.4); }
    };
    // the walls closing in bite in rhythmic beats: a grinding crush SFX paired with a red
    // squeeze-flash on the HUD, both scaled by how deep the corner pressure has gotten
    p.onCornerCrush = (sev) => { this.audio.wallCrush(sev); this.ui.cornerCrush(sev); };
    p.onKill = (info) => {
      const base = info.score || 100;
      const mult = 1 + (this.player.combo * 0.12);
      const pts = Math.round(base * mult * (1 + this.director.depth * 0.05));
      this.addScore(pts);
      this.director.reportKill(info);
      this.floaty3d(info.pos, `+${pts}`, { color: info.type === 'bochur' ? '#f4d878' : '#ff9a4a', crit: info.type !== 'bochur', size: info.type !== 'bochur' ? 28 : 22 });
    };
    p.onDeath = () => this._onPlayerDeath();
    // a tossed shekel: hand the launch spec to the director, which spawns the airborne,
    // wall-bouncing lure coin the whole room will chase
    p.onToss = (info) => this.director.tossShekel(info);

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
        if (this.state === 'intro' || this.state === 'cutscene') this.cutscene.skip();
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
      if ((e.code === 'Enter' || e.code === 'Escape') && (this.state === 'intro' || this.state === 'cutscene')) this.cutscene.skip();
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
      // Local-dev only: 'B' summons a non-invulnerable Chaim Barer in front of the
      // player (debug). Gated to localhost so it never ships on the deployed site.
      if (IS_LOCAL_DEV && e.code === 'KeyB' && !e.repeat && this.state === 'playing') {
        this.director.debugSpawnBarerNearPlayer(true);
        this.ui.toast('Chaim Barer summoned (vulnerable)');
      }
      // Local-dev only: 'G' (gelt) drops a shekel just in front of the player, exactly as a
      // fallen boss would (same pop-out-and-bounce) — a hook to test the drop/collect flow
      // without clearing a whole boss hall. Localhost-gated so it never ships.
      if (IS_LOCAL_DEV && e.code === 'KeyG' && !e.repeat && this.state === 'playing') {
        this.director.debugDropShekelNearPlayer();
        this.ui.toast('Shekel dropped (dev)');
      }
      // Local-dev only: 'K' force-clears the active combat hall (removes all live enemies)
      // so the room-clear + next-room transition can be profiled on demand. Localhost-gated.
      if (IS_LOCAL_DEV && e.code === 'KeyK' && !e.repeat && this.state === 'playing') {
        this.director.debugForceClear();
        this.ui.toast('Room force-cleared (dev)');
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
    // Leaving to the title ends any restart-streak: the next game is genuinely fresh, so
    // its set-piece cut-scenes play again (only a Restart Run / Fight Again keeps the streak).
    this._streakSeen.clear();
    // Tear down any world the director streamed in during the last run (or a cut-scene
    // preview): its rooms/corridors/enemies/pickups live in THIS same scene and are only
    // disposed on reset. Left behind, they drop a smaller, procedurally-generated room
    // inside the title hall — overlapping the fixed set-piece and its cast, and different
    // every run. Clearing it keeps the title showing only the deterministic backdrop.
    this.director.reset();
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
    this.audio.preloadVO(VO_IDS); // warm the cut-scene voice-over clips (idempotent; no-op if absent)
    this.audio.preloadDeath();    // warm the death sting so it fires the instant the player drops
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
      // local-dev cut-scene gallery (only wired up when _setupCutsceneGallery ran)
      case 'cutscenes': this.ui.showScreen('cutscenes'); break;
      case 'cutscenes-back': this.ui.showScreen('menu'); break;
      case 'cs:intro': this._previewCutscene('intro'); break;
      case 'cs:dvar': this._previewCutscene('dvar'); break;
      case 'cs:zehn': this._previewCutscene('zehn'); break;
      case 'cs:barer': this._previewCutscene('barer'); break;
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
      setTimeout(() => {
        if (this._csPreview) this._csReturnToTitle();   // preview: back to the title, not into a run
        else this._startGameplay();
      }, 720);
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
    // per-run cut-scene triggers: they must re-arm every run so the boss-hall triggers fire
    // again. Whether a fired scene actually plays or is silently bypassed is decided against
    // `_streakSeen` in _triggerCutscene (kept across Restart Run / Fight Again, cleared at title).
    this._dvarShown = false; this._zehnShown = false;
    this._dvarPending = false; this._zehnPending = false;
    this.score = 0; this.kills = 0; this.bestCombo = 0;
    this.startTime = this.time;
    this.ui.setScore(0); this.ui.setCombo(0); this.ui.setBoss(null, null); this.ui.setBarer(null);
    this.ui.setShekels(0, this.player.maxShekels);
    this._taughtShekel = false;
    if (this.touch) this.touch.setTossVisible(false);

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
    this.ui.setSitCursor('none');
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
    this.ui.setSitCursor('none');
    this.audio.setMusic(null);
    this.audio.ambient(false);
    this.audio.playerDeath();   // the pre-rendered death sting (assets/death.ogg)
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
    // (skipped in a title preview — there is no run to return to)
    if (!this._csPreview) this.director.pregenNextRoom();
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
    if (this._csPreview) {
      // title preview: tear down the summoned Barer (there is no room to clear) and
      // bow out to the title instead of resuming play
      for (const e of this.director.enemies) { this.scene.remove(e.root); e.dispose(); }
      this.director.enemies.length = 0;
      this.director.barer = null;
      this._csReturnToTitle();
      return;
    }
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

  // ---- cut-scene gallery (local dev only) ---------------------------------
  // A title-menu tool to replay any single cinematic in isolation. The DOM is built
  // here (never in index.html) so nothing about it exists on the deployed site, and
  // each preview funnels back to the title through _csReturnToTitle instead of a run.
  _setupCutsceneGallery() {
    const menuButtons = document.querySelector('#menu .menu-buttons');
    if (menuButtons) {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.dataset.act = 'cutscenes';
      btn.textContent = 'Cut-scenes';
      menuButtons.appendChild(btn);
    }
    const scr = document.createElement('div');
    scr.id = 'cutscenes';
    scr.className = 'screen hidden';
    scr.innerHTML = '<div class="menu-inner">'
      + '<h2 class="pause-title">Cut-scenes</h2>'
      + '<div class="menu-buttons">'
      + '<button class="btn" data-act="cs:intro">Intro</button>'
      + '<button class="btn" data-act="cs:dvar">Dvar Torah</button>'
      + '<button class="btn" data-act="cs:zehn">Rabbi Zehnwirth &amp; Barer</button>'
      + '<button class="btn" data-act="cs:barer">Chaim Barer — Down &amp; Finisher</button>'
      + '<button class="btn ghost" data-act="cutscenes-back">Back</button>'
      + '</div></div>';
    document.getElementById('app').appendChild(scr);
    // register with the UI so showScreen/hideScreens manage it like any other screen
    this.ui.screens.push('cutscenes');
  }

  // Launch one cinematic from the gallery. Only reachable from the title, so the
  // backdrop exists and the camera lives in the main scene.
  _previewCutscene(which) {
    this._csPreview = true;
    this.ui.hideScreens();
    switch (which) {
      case 'intro': this._startIntro(); break;
      case 'dvar': this._beginDvarTorah(); break;
      case 'zehn': this._beginZehnwirth(); break;
      case 'barer': this._previewBarerDown(); break;
      default: this._csPreview = false; break;
    }
  }

  // Preview the Barer down->finisher sequence from the title. Reset the director so its
  // enemy pool exists (a cold title never ran a game), stand the player in the hall
  // facing the ark, then summon a downed Barer in front and run the full cinematic.
  _previewBarerDown() {
    this.director.reset();
    this.ui.showHUD(false);
    this._ensureBackdrop();
    this._resetTint();
    this.player.fists.visible = false;
    this.player.spawn(0, 2, 0);   // centre of the hall, facing -Z (toward the ark)
    const b = this.director.debugSpawnBarerNearPlayer(true);
    b.state = 'downed'; b.setFace('attack2');
    this.director.barer = b;
    this._beginBarerDown(b);
  }

  // Common exit from any gallery preview: fade out, drop back to the title menu.
  _csReturnToTitle() {
    this._csPreview = false;
    this.player.camera.fov = this._baseFov; this.player.camera.updateProjectionMatrix();
    this.ui.fade(true, 0.4);
    setTimeout(() => {
      this.ui.hideCinema();
      this._toTitle();
      this.ui.fade(false, 0.6);
    }, 420);
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
    // The seed below pins layout + cast, but several props bake in small random details
    // straight from the global Math.random (e.g. studyTable's scattered sefarim, light
    // flicker phases), which would make the tableau differ subtly every visit. Route
    // Math.random through a seeded stream for the whole (synchronous) build, then restore
    // it, so the entire set-piece — down to every prop detail — is identical each time.
    const realRandom = Math.random;
    const detailRng = new RNG((TITLE_SEED ^ 0x9e3779b9) >>> 0);
    Math.random = () => detailRng.next();
    try {
      this._buildBackdropSet();
    } finally {
      Math.random = realRandom;
    }
  }

  _buildBackdropSet() {
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

    // a handful of bochurim SITTING on the benches — the same seat system the player
    // uses in play (see props/roombuilder seats + characters.sitPose). Marked `seated`
    // so the intro pose animator leaves their static sit pose alone.
    const seatActor = (seat, opts) => {
      const b = buildCharacter(opts);
      b.root.position.set(seat.x, 0, seat.z);
      b.root.rotation.y = seat.ry;   // face out of the seat
      sitPose(b.joints);
      b.seated = true; b.phase = rng.range(0, 6.28);
      this.scene.add(b.root); actors.push(b); seat.occupant = b;
    };
    let seated = 0;
    for (const s of inst.seats) {
      if (seated >= 7) break;
      if (s.occupant) continue;
      seatActor(s, {
        coat: rng.pick(COAT_COLORS), skin: rng.pick(SKIN_TONES), beard: rng.pick(BEARD_TONES),
        hat: rng.chance(0.6) ? 'fedora' : 'homburg', bigBeard: rng.chance(0.35), glasses: rng.chance(0.3),
      });
      seated++;
    }

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
      a.root.traverse((o) => { if (o.isMesh && o.geometry && !o.geometry.userData.shared) o.geometry.dispose(); });
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
      if (a.seated) continue;   // seated bochurim hold their static sit pose
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
        duration: 6, vo: 'intro-1', subtitle: 'For years, you learned here — day and night, without end.',
        cam: { from: { pos: [0, 6.5, 9], look: [0, 1.6, 0] }, to: { pos: [0, 2.4, 5.5], look: [0, 1.4, -2] } },
      },
      {
        duration: 6, vo: 'intro-2', subtitle: 'Shoulder to shoulder with the chevra. Your friends. Your <b>chavrusa</b>.',
        cam: { from: { pos: [-5.5, 2.0, 3], look: [0, 1.4, -1] }, to: { pos: [5.5, 2.0, 3], look: [0, 1.4, -1] } },
      },
      {
        duration: 5.5, vo: 'intro-3', subtitle: 'Until this morning… when something in the yeshiva <span class="em">turned</span>.',
        cam: { from: { pos: [3, 1.7, -1], look: [-3, 1.5, 1] }, to: { pos: [1.5, 1.7, -1.5], look: [-3.2, 1.5, 0.4] } },
        onUpdate: (bt, p) => { G.introHostile = Math.min(0.35, p * 0.35); },
      },
      {
        duration: 4.5, vo: 'intro-4', subtitle: '<b>They rise.</b>',
        cam: { from: { pos: [0, 1.7, 6], look: [0, 1.6, 0] }, to: { pos: [0, 1.9, 8.5], look: [0, 1.5, -1] } },
        onEnter: () => { G.audio.shofar(); G.audio.gate(false); },
        onUpdate: (bt, p) => { G.introHostile = 0.35 + 0.65 * Math.min(1, p * 1.4); },
      },
      {
        duration: 5, vo: 'intro-5', subtitle: 'Fists up. Smash your way out — hall by endless hall.',
        cam: { from: { pos: [0, 1.66, 7.5], look: [0, 1.55, -6] }, to: { pos: [0, 1.66, 4.5], look: [0, 1.55, -8] } },
        onUpdate: () => { G.introHostile = 1; },
      },
      {
        duration: 4, vo: 'intro-6', subtitle: 'There is no end. Only how deep you get.', fade: undefined,
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
    const perfT0 = IS_LOCAL_DEV ? performance.now() : 0;

    switch (this.state) {
      case 'title': this._updateTitle(dt); break;
      case 'intro': this._updateIntro(dt); break;
      case 'playing': this._updatePlaying(dt); break;
      case 'cutscene': this._updateCutscene(dt); break;
      case 'barerdown': this._updateBarerDown(dt); break;
      case 'finisher': this._updateFinisher(dt); break;
      case 'paused': break;
      default: break;
    }

    this.ui.update(dt);
    this.input.endFrame();

    // a set-piece cut-scene renders its own isolated scene
    const scene = (this.state === 'cutscene' && this.cut && this.cut.built) ? this.cut.scene : this.scene;
    this.renderer.render(scene, this.player.camera);
    // second pass: draw the first-person hands (or the finisher tableau) over the world
    if (this.player.fists.visible || this.finisherActive) {
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.player.viewScene, this.player.camera);
      this.renderer.autoClear = true;
    }

    // dev-only frame-spike logger (Phase 0 instrumentation): flag any frame whose CPU work
    // blew past a frame's budget, tagged with whatever the director last did this frame, so
    // the room-clear / wave-spawn / pregen stalls can be pinned down and measured. The
    // IS_LOCAL_DEV gate strips it from the deployed build.
    if (IS_LOCAL_DEV) {
      const ms = performance.now() - perfT0;
      if (ms > 20) console.warn(`[spike] ${ms.toFixed(1)}ms (${this._perfTag || 'frame'})`);
      this._perfTag = null;
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
      this.ui.setSitCursor('none');
      return;
    }
    const colliders = this.director.currentColliders();
    this.player.update(dt, {
      input: this.input, colliders, enemies: this.director.enemies,
      windows: this.director.currentWindows(),
      bookshelves: this.director.currentBookshelves(),
      seats: this.director.currentSeats(),
      canSit: this.director.roomState !== 'combat',   // no parking on a bench mid-fight
      inCombat: this.director.roomState === 'combat', // wall-hug penalty only bites in a fight
      audio: this.audio, time: this.time,
    });
    this.director.update(dt, this.time);
    // boss halls trigger their set-piece cut-scenes (consumed once, the frame after clear);
    // _triggerCutscene plays or bypasses per the restart-streak (returns true if a scene began)
    if (this._dvarPending && !this.dying) { this._dvarPending = false; if (this._triggerCutscene('dvar')) return; }
    if (this._zehnPending && !this.dying) { this._zehnPending = false; if (this._triggerCutscene('zehn')) return; }
    this.ui.setHealth(this.player.hp / this.player.maxHp);
    this.ui.setShekels(this.player.shekels, this.player.maxShekels);
    this.ui.setCorner(this.player.cornered, dt);
    this.ui.setSlow(this.player.slowT / 2.6);   // frost telegraph while a mekubal's binding holds
    // contextual sit reticle (and touch button)
    this.ui.setSitCursor(this.player.sitState);
    if (this.touch) this.touch.setSitVisible(this.player.sitState === 'enabled');
    // the TOSS button only makes sense with a coin in pocket
    if (this.touch) this.touch.setTossVisible(this.player.shekels > 0);

    if (this.dying) {
      this.dieTimer -= dt;
      if (this.dieTimer <= 0) this._showGameOver();
    }
  }

  // ---- set-piece cut-scenes (generic runner) ------------------------------
  // The dvar-torah (first boss cleared) and the chavrusa with Rabbi Zehnwirth (second
  // boss cleared) both work the same way: freeze the world, dip to black, build a
  // hand-authored scene as its OWN THREE.Scene, reparent the shared camera into it, run
  // the Cutscene beats, then dispose and resume the already-cleared hall. `makeScene`
  // returns the (cached) scene instance, which exposes build/beats/update/dispose.
  _beginCutscene(makeScene) {
    this.state = 'cutscene';
    this._cutStarting = true;
    this._makeCutScene = makeScene;
    this.player.fists.visible = false;
    this.ui.showHUD(false);
    this.ui.hideObjective();
    this.ui.setBoss(null, null); this.ui.setBarer(null);
    this.ui.setSitCursor('none');
    if (this.touch) this.touch.setVisible(false);
    this.input.setEnabled(false);
    this.audio.setMusic('menu'); this.audio.setIntensity(0);
    this.ui.fade(true, 0.3);               // dip to black to hide the world->set-piece swap
    setTimeout(() => this._startCutscene(), 340);
  }

  _startCutscene() {
    if (this.state !== 'cutscene') return;   // bailed out (e.g. a reset) during the dip
    this.cut = this._makeCutScene();
    this.cut.build();
    // reparent the shared camera into the set-piece scene so its world matrix updates
    // when we render that scene; reset FOV (some beats punch it in and back)
    this.scene.remove(this.player.camera);
    this.cut.scene.add(this.player.camera);
    this.cut.camera = this.player.camera;    // scenes that swap by camera angle read this
    this.player.camera.fov = this._baseFov; this.player.camera.updateProjectionMatrix();
    // compile the set-piece's programs now, while the screen is still black — no first-frame hitch
    try { this.renderer.compile(this.cut.scene, this.player.camera); } catch (e) {}
    this._cutStarting = false;
    this.cutscene.play(this.cut.beats(this.player.camera), () => this._endCutscene());
  }

  _updateCutscene(dt) {
    if (this._cutStarting || !this.cut || !this.cut.built) return;
    this.cutscene.update(dt);
    this.cut.update(dt, this.time);
  }

  _endCutscene() {
    // the final beat has faded us to black; swap the world back in behind it
    this.ui.setSubtitle('');
    setTimeout(() => {
      if (this.cut) {
        if (this.cut.scene) this.cut.scene.remove(this.player.camera);
        this.scene.add(this.player.camera);
        this.cut.dispose();
        this.cut = null;
      }
      this.player.camera.fov = this._baseFov; this.player.camera.updateProjectionMatrix();
      if (this._csPreview) { this._csReturnToTitle(); return; }   // preview: back to the title, not into the cleared hall
      this.ui.hideScreens();
      this.ui.showHUD(true);
      this.player.fists.visible = true;
      this.state = 'playing';
      this.audio.setMusic('menu'); this.audio.ambient(true);
      // the hall's already cleared and the exit is open — point the player onward
      this.ui.objective('The way is open — press on →', 'warn'); this.director.objTimer = 4;
      const seamless = !this.isTouch && this.input.locked;
      if (seamless) { this.awaitingLock = false; this.input.setEnabled(true); }
      else { this.awaitingLock = true; this.input.setEnabled(false); this.ui.showPrompt(true); }
      this.ui.fade(false, 0.9);
    }, 260);
  }

  // A boss hall cleared and its cut-scene trigger fired. Mark it shown either way so the
  // director routes the NEXT boss to the next scene (dvar -> zehn). Then, if this scene was
  // already seen earlier in the current restart-streak, bypass it — gameplay just carries on
  // and the already-open gate is used. Otherwise remember it (so re-runs bypass it) and play.
  // Returns true iff a cut-scene actually began (the caller then yields the rest of the frame).
  _triggerCutscene(key) {
    if (key === 'dvar') this._dvarShown = true; else this._zehnShown = true;
    if (this._streakSeen.has(key)) return false;   // seen earlier this streak — skip straight past
    this._streakSeen.add(key);
    if (key === 'dvar') this._beginDvarTorah(); else this._beginZehnwirth();
    return true;
  }

  // The dvar-torah: after the first boss hall falls, how it all began (see dvartorah.js).
  _beginDvarTorah() {
    if (!this._csPreview) this._dvarShown = true;   // a preview must not consume the one-time gameplay trigger
    this._beginCutscene(() => (this.dvar || (this.dvar = new DvarTorah(this.ui, this.audio))));
  }
  // The chavrusa: after the second boss hall falls, Rabbi Zehnwirth learns Barer into
  // devoting himself to the Satan (see chavrusa.js).
  _beginZehnwirth() {
    if (!this._csPreview) this._zehnShown = true;
    this._beginCutscene(() => (this.chav || (this.chav = new ChavrusaScene(this.ui, this.audio))));
  }

  // debug (headless smoke test): jump straight into either set-piece cut-scene
  _debugDvarTorah() { if (this.state === 'playing') { this._dvarPending = false; this._beginDvarTorah(); } }
  _debugZehnwirth() { if (this.state === 'playing') { this._zehnPending = false; this._beginZehnwirth(); } }
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
