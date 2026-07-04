// Fully procedural audio: no sample files. Web Audio API synthesis for SFX,
// ambience, and a klezmer-flavored (Freygish / Phrygian-dominant) music engine.

const FREYGISH = [0, 1, 4, 5, 7, 8, 10]; // scale degrees in semitones

// ---- Klezmer harmony (A Freygish / Ahava-Raba) -----------------------------
// Triads built only from in-scale tones; values are semitone offsets above the
// tonic, with the fifth as the top voice ([root, third, fifth]).
const CHORDS = {
  I:   [0, 4, 7],    // A  major  — tonic (the mode's bright major third)
  iv:  [5, 8, 12],   // D  minor  — subdominant
  bII: [1, 5, 8],    // Bb major  — the signature "Freygish" flat-two
  vii: [10, 13, 17], // G  minor  — a descending turn on the way home
};
// One chord per bar. Menu breathes over four bars; combat drives through eight.
const MENU_PROG   = ['I', 'iv', 'bII', 'I'];
const COMBAT_PROG = ['I', 'iv', 'bII', 'I', 'vii', 'iv', 'bII', 'I'];

// Melodic phrase banks — scale-degree indices (0=tonic, 1=b2, 2=maj3 … 6=b7,
// 7=octave), null = rest. Banks rotate on their own length, out of phase with
// the chord loop, so the melody keeps landing on fresh harmony (nigunim never
// repeat the same way twice). The b2->maj3 leap (deg 1->2) is the augmented
// second that gives klezmer its ache.
// Bank lengths (7) are kept coprime with the progressions (4 and 8) on purpose:
// melody and harmony only realign after LCM bars (28 menu / 56 combat), so the
// tune wanders a long time before any bar comes back around.
const MENU_MEL = [
  [4, null, 3, null, 2, null, 1, null, 1, null, 0, null, null, null, null, null],
  [0, null, 1, 2, 4, null, 3, 2, 1, null, null, 0, null, null, null, null],
  [2, null, 1, 0, 1, null, null, 0, null, 1, 2, null, 1, null, 0, null],
  [4, null, 5, null, 6, null, 7, null, 6, 5, 4, null, 3, null, 2, null],
  [0, null, null, null, 1, null, 0, null, null, null, null, null, 2, null, 1, 0],
  [2, null, 1, null, 0, null, null, null, 1, 0, null, null, 0, null, null, null],
  [3, null, 2, null, 1, null, 2, 3, 4, null, 3, null, 2, 1, 0, null],
];
const COMBAT_MEL = [
  [0, 3, 2, 3, 4, 3, 2, 0, 6, 5, 4, 3, 2, 1, 0, null],
  [0, null, 1, 2, 3, 2, 1, 0, 4, null, 3, 2, 1, null, 0, null],
  [0, 0, 1, 2, 4, 4, 3, 2, 7, null, 6, 5, 4, 3, 2, null],
  [4, 5, 6, 7, 6, 5, 4, 3, 2, 3, 2, 1, 0, null, null, null],
  [0, null, 0, 3, 2, null, 3, null, 4, 3, 2, 1, 0, null, 6, null],
  [7, 6, 7, null, 5, 6, 5, null, 4, null, 3, 4, 2, null, 0, null],
  [0, null, 2, null, 1, 0, null, null, 3, null, 5, null, 4, 2, 1, 0],
];

function midi(n) { return 440 * Math.pow(2, (n - 69) / 12); }
function clamp01(v) { v = +v; return v >= 0 ? (v <= 1 ? v : 1) : 0; } // also maps NaN -> 0

const VOL_KEY = 'bb_volumes';
const VOL_DEFAULT = { master: 0.9, music: 1.0, sfx: 1.0, muted: false };

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    // user-adjustable levels (0..1), persisted in localStorage
    this.volumes = this._loadVolumes();
    // global mute (M key) — gates the master output, independent of the volume trims
    this.muted = !!this.volumes.muted;
    this.master = null;
    this.musicBus = null;
    this.sfxBus = null;
    this.ambBus = null;
    this.noiseBuf = null;

    this._musicName = null;
    this._seqTimer = null;
    this._step = 0;
    this._bar = 0;        // bars elapsed — drives the chord/phrase progression
    this._root = 57;      // A3 tonic of the Freygish mode
    this._nextNoteTime = 0;
    this._bpm = 96;
    this._intensity = 0;
    this._ambNodes = null;
    this._footFlip = false;
  }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    const ctx = new AC();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volumes.master;
    this.master.connect(ctx.destination);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 3.2; comp.attack.value = 0.004; comp.release.value = 0.22;
    comp.connect(this.master);
    this.out = comp;

    // Per-category user volume trims sit between the buses and the compressor,
    // so setMusicVolume/setSfxVolume are independent of the dynamic fades on the buses.
    this.musicVol = ctx.createGain(); this.musicVol.gain.value = this.volumes.music; this.musicVol.connect(this.out);
    this.sfxVol = ctx.createGain(); this.sfxVol.gain.value = this.volumes.sfx; this.sfxVol.connect(this.out);

    this.musicBus = ctx.createGain(); this.musicBus.gain.value = 0.0; this.musicBus.connect(this.musicVol);
    this.sfxBus = ctx.createGain(); this.sfxBus.gain.value = 0.95; this.sfxBus.connect(this.sfxVol);
    // ambience is part of the background bed -> trimmed by music volume
    this.ambBus = ctx.createGain(); this.ambBus.gain.value = 0.0; this.ambBus.connect(this.musicVol);

    // reverb-ish convolvers for spatial warmth — one per category so the wet tail
    // is trimmed by the same volume as its dry signal (share the impulse buffer).
    const imp = this._impulse(1.9, 2.6);
    this.reverb = ctx.createConvolver(); this.reverb.buffer = imp;         // SFX send
    this.reverbGain = ctx.createGain(); this.reverbGain.gain.value = 0.25;
    this.reverb.connect(this.reverbGain); this.reverbGain.connect(this.sfxVol);
    this.musicReverb = ctx.createConvolver(); this.musicReverb.buffer = imp; // music send
    this.musicReverbGain = ctx.createGain(); this.musicReverbGain.gain.value = 0.25;
    this.musicReverb.connect(this.musicReverbGain); this.musicReverbGain.connect(this.musicVol);

    this.noiseBuf = this._noise(2.0);
    this.ready = true;
    // created inside a user gesture it should already be running, but resume defensively
    if (ctx.state === 'suspended') ctx.resume();
  }

  // ---------- user volume (0..1), persisted ----------
  _loadVolumes() {
    try {
      const raw = localStorage.getItem(VOL_KEY);
      if (raw) {
        const v = JSON.parse(raw);
        return {
          master: v.master != null ? clamp01(v.master) : VOL_DEFAULT.master,
          music: v.music != null ? clamp01(v.music) : VOL_DEFAULT.music,
          sfx: v.sfx != null ? clamp01(v.sfx) : VOL_DEFAULT.sfx,
          muted: !!v.muted,
        };
      }
    } catch (e) {}
    return { ...VOL_DEFAULT };
  }
  _saveVolumes() { try { localStorage.setItem(VOL_KEY, JSON.stringify({ ...this.volumes, muted: this.muted })); } catch (e) {} }

  // apply master gain honoring the mute gate (0 when muted, otherwise the user level)
  _applyMaster() { if (this.master) this.master.gain.value = this.muted ? 0 : this.volumes.master; }

  setMasterVolume(v) { this.volumes.master = clamp01(v); this._applyMaster(); this._saveVolumes(); }
  setMusicVolume(v) { this.volumes.music = clamp01(v); if (this.musicVol) this.musicVol.gain.value = this.volumes.music; this._saveVolumes(); }
  setSfxVolume(v) { this.volumes.sfx = clamp01(v); if (this.sfxVol) this.sfxVol.gain.value = this.volumes.sfx; this._saveVolumes(); }

  // toggle mute for all sound; returns the new muted state
  toggleMute() { this.muted = !this.muted; this._applyMaster(); this._saveVolumes(); return this.muted; }
  setMuted(m) { this.muted = !!m; this._applyMaster(); this._saveVolumes(); return this.muted; }

  _noise(sec) {
    const ctx = this.ctx, len = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _impulse(sec, decay) {
    const ctx = this.ctx, rate = ctx.sampleRate, len = Math.floor(rate * sec);
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  _now() { return this.ctx.currentTime; }

  _noiseSrc() {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf; s.loop = true;
    return s;
  }

  // Generic envelope helper
  _env(gain, t, a, peak, d, sustain = 0) {
    gain.setValueAtTime(0.0001, t);
    gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + a);
    if (sustain > 0) {
      gain.exponentialRampToValueAtTime(Math.max(peak * sustain, 0.0002), t + a + d * 0.4);
      gain.exponentialRampToValueAtTime(0.0002, t + a + d);
    } else {
      gain.exponentialRampToValueAtTime(0.0002, t + a + d);
    }
  }

  // ============================================================= SFX
  whoosh(heavy = false) {
    if (!this.ready) return;
    const t = this._now(), src = this._noiseSrc();
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.setValueAtTime(heavy ? 380 : 700, t);
    bp.frequency.exponentialRampToValueAtTime(heavy ? 120 : 240, t + 0.18);
    bp.Q.value = 1.1;
    const g = this.ctx.createGain();
    this._env(g.gain, t, 0.012, heavy ? 0.32 : 0.2, heavy ? 0.24 : 0.16);
    src.connect(bp); bp.connect(g); g.connect(this.sfxBus);
    src.start(t); src.stop(t + 0.4);
  }

  hit(heavy = false, pitch = 1) {
    if (!this.ready) return;
    const t = this._now();
    // thud body
    const o = this.ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime((heavy ? 190 : 150) * pitch, t);
    o.frequency.exponentialRampToValueAtTime((heavy ? 46 : 60) * pitch, t + 0.16);
    const g = this.ctx.createGain();
    this._env(g.gain, t, 0.004, heavy ? 0.9 : 0.6, heavy ? 0.28 : 0.18);
    o.connect(g); g.connect(this.sfxBus); g.connect(this.reverb);
    o.start(t); o.stop(t + 0.4);
    // slap transient
    const n = this._noiseSrc();
    const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1400;
    const ng = this.ctx.createGain();
    this._env(ng.gain, t, 0.001, heavy ? 0.5 : 0.34, 0.06);
    n.connect(hp); hp.connect(ng); ng.connect(this.sfxBus);
    n.start(t); n.stop(t + 0.1);
  }

  enemyHurt(pitch = 1) {
    if (!this.ready) return;
    const t = this._now();
    // vocal-ish "oy" grunt: two saws through a vowel bandpass with a pitch drop
    const base = 150 * pitch;
    const g = this.ctx.createGain();
    this._env(g.gain, t, 0.02, 0.26, 0.26);
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.setValueAtTime(760, t);
    bp.frequency.exponentialRampToValueAtTime(520, t + 0.25);
    bp.Q.value = 4.5;
    for (const det of [1, 1.01]) {
      const o = this.ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(base * det, t);
      o.frequency.exponentialRampToValueAtTime(base * 0.7 * det, t + 0.28);
      o.connect(bp); o.start(t); o.stop(t + 0.32);
    }
    bp.connect(g); g.connect(this.sfxBus); g.connect(this.reverb);
  }

  enemyDie(pitch = 1) {
    if (!this.ready) return;
    const t = this._now();
    // comic descending "oyyy" then thud
    const o = this.ctx.createOscillator(); o.type = 'sawtooth';
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 640; bp.Q.value = 5;
    o.frequency.setValueAtTime(220 * pitch, t);
    o.frequency.exponentialRampToValueAtTime(90 * pitch, t + 0.5);
    const g = this.ctx.createGain();
    this._env(g.gain, t, 0.02, 0.3, 0.55);
    o.connect(bp); bp.connect(g); g.connect(this.sfxBus); g.connect(this.reverb);
    o.start(t); o.stop(t + 0.6);
    // body flop
    const n = this._noiseSrc();
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 300;
    const ng = this.ctx.createGain();
    this._env(ng.gain, t + 0.42, 0.006, 0.5, 0.22);
    n.connect(lp); lp.connect(ng); ng.connect(this.sfxBus);
    n.start(t + 0.4); n.stop(t + 0.7);
  }

  // Chaim Barer's head coming apart — a wet, low burst with a squelchy pitch-drop
  // and a scatter of spatter, for the "LOUIE BALLEWIE!" finisher.
  splat() {
    if (!this.ready) return;
    const t = this._now();
    // wet low burst
    const n = this._noiseSrc();
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1300, t); lp.frequency.exponentialRampToValueAtTime(170, t + 0.3); lp.Q.value = 1.2;
    const g = this.ctx.createGain(); this._env(g.gain, t, 0.002, 0.72, 0.42);
    n.connect(lp); lp.connect(g); g.connect(this.sfxBus); g.connect(this.reverb);
    n.start(t); n.stop(t + 0.5);
    // squelchy descending body
    const o = this.ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(210, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.36);
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 520; bp.Q.value = 1.5;
    const og = this.ctx.createGain(); this._env(og.gain, t, 0.003, 0.5, 0.42);
    o.connect(bp); bp.connect(og); og.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.5);
    // spatter of flesh hitting the floor
    for (let i = 0; i < 9; i++) {
      const st = t + 0.04 + Math.random() * 0.28;
      const nn = this._noiseSrc();
      const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 700 + Math.random() * 1400; f.Q.value = 0.8;
      const gg = this.ctx.createGain(); this._env(gg.gain, st, 0.001, 0.13, 0.1);
      nn.connect(f); f.connect(gg); gg.connect(this.sfxBus);
      nn.start(st); nn.stop(st + 0.14);
    }
  }

  playerHurt() {
    if (!this.ready) return;
    const t = this._now();
    const o = this.ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    const g = this.ctx.createGain(); this._env(g.gain, t, 0.003, 0.75, 0.3);
    o.connect(g); g.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.4);
    const n = this._noiseSrc();
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.7;
    const ng = this.ctx.createGain(); this._env(ng.gain, t, 0.002, 0.32, 0.14);
    n.connect(bp); bp.connect(ng); ng.connect(this.sfxBus);
    n.start(t); n.stop(t + 0.2);
  }

  footstep() {
    if (!this.ready) return;
    const t = this._now();
    this._footFlip = !this._footFlip;
    const n = this._noiseSrc();
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.value = this._footFlip ? 240 : 300; lp.Q.value = 1.5;
    const g = this.ctx.createGain(); this._env(g.gain, t, 0.003, 0.13, 0.08);
    n.connect(lp); lp.connect(g); g.connect(this.sfxBus);
    n.start(t); n.stop(t + 0.12);
  }

  // soft effort-whoosh of pushing off the floor
  jump() {
    if (!this.ready) return;
    const t = this._now(), n = this._noiseSrc();
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(320, t);
    bp.frequency.exponentialRampToValueAtTime(620, t + 0.14);
    const g = this.ctx.createGain(); this._env(g.gain, t, 0.006, 0.16, 0.14);
    n.connect(bp); bp.connect(g); g.connect(this.sfxBus);
    n.start(t); n.stop(t + 0.2);
  }

  // heavier double-thud of boots hitting the floor
  land() {
    if (!this.ready) return;
    const t = this._now();
    const n = this._noiseSrc();
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220; lp.Q.value = 1.4;
    const ng = this.ctx.createGain(); this._env(ng.gain, t, 0.002, 0.22, 0.11);
    n.connect(lp); lp.connect(ng); ng.connect(this.sfxBus);
    n.start(t); n.stop(t + 0.16);
    const o = this.ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(52, t + 0.1);
    const og = this.ctx.createGain(); this._env(og.gain, t, 0.003, 0.3, 0.12);
    o.connect(og); og.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.2);
  }

  gate(open) {
    if (!this.ready) return;
    const t = this._now();
    // heavy stone/wood slide
    const n = this._noiseSrc();
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 3;
    bp.frequency.setValueAtTime(open ? 200 : 520, t);
    bp.frequency.exponentialRampToValueAtTime(open ? 520 : 140, t + 0.7);
    const g = this.ctx.createGain(); this._env(g.gain, t, 0.05, 0.4, 0.85);
    n.connect(bp); bp.connect(g); g.connect(this.sfxBus); g.connect(this.reverb);
    n.start(t); n.stop(t + 1.0);
    // low boom at the end for a slam
    if (!open) {
      const o = this.ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(80, t + 0.6); o.frequency.exponentialRampToValueAtTime(38, t + 0.95);
      const og = this.ctx.createGain(); this._env(og.gain, t + 0.6, 0.01, 0.7, 0.4);
      o.connect(og); og.connect(this.sfxBus); og.connect(this.reverb);
      o.start(t + 0.6); o.stop(t + 1.1);
    }
  }

  // sharp, dry crackle of a pane fracturing (a jab that doesn't quite break through)
  glassCrack() {
    if (!this.ready) return;
    const t = this._now();
    // staggered high-frequency ticks — the splinters racing across the glass
    for (const off of [0, 0.02, 0.05, 0.09]) {
      const n = this._noiseSrc();
      const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3500 + Math.random() * 2500;
      const g = this.ctx.createGain(); this._env(g.gain, t + off, 0.001, 0.16 - off * 0.4, 0.05);
      n.connect(hp); hp.connect(g); g.connect(this.sfxBus); g.connect(this.reverb);
      n.start(t + off); n.stop(t + off + 0.08);
    }
    // a couple of glassy 'tink' partials
    for (const f of [2600, 3300, 4100]) {
      const o = this.ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * (0.98 + Math.random() * 0.06);
      const g = this.ctx.createGain(); this._env(g.gain, t, 0.001, 0.09, 0.09);
      o.connect(g); g.connect(this.sfxBus); g.connect(this.reverb);
      o.start(t); o.stop(t + 0.14);
    }
  }

  // the full smash: a bright burst, a low frame-thunk, then a cascade of shards
  // tinkling down onto the floor
  glassShatter() {
    if (!this.ready) return;
    const t = this._now();
    // the break: a bright broadband burst
    const n = this._noiseSrc();
    const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2000;
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 0.6;
    const g = this.ctx.createGain(); this._env(g.gain, t, 0.001, 0.5, 0.22);
    n.connect(hp); hp.connect(bp); bp.connect(g); g.connect(this.sfxBus); g.connect(this.reverb);
    n.start(t); n.stop(t + 0.3);
    // low thunk of the casement taking the blow
    const o = this.ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(60, t + 0.12);
    const og = this.ctx.createGain(); this._env(og.gain, t, 0.002, 0.3, 0.14);
    o.connect(og); og.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.2);
    // falling shards — scattered high blips settling over half a second
    for (let i = 0; i < 10; i++) {
      const st = t + 0.04 + Math.random() * 0.5;
      const fr = 1800 + Math.random() * 3200;
      const os = this.ctx.createOscillator(); os.type = Math.random() < 0.5 ? 'sine' : 'triangle';
      os.frequency.setValueAtTime(fr, st); os.frequency.exponentialRampToValueAtTime(fr * 0.85, st + 0.06);
      const gs = this.ctx.createGain(); this._env(gs.gain, st, 0.001, 0.05 + Math.random() * 0.06, 0.05 + Math.random() * 0.05);
      os.connect(gs); gs.connect(this.sfxBus); gs.connect(this.reverb);
      os.start(st); os.stop(st + 0.16);
    }
  }

  pickup() {
    if (!this.ready) return;
    const t = this._now();
    [0, 4, 7, 12].forEach((s, i) => {
      const o = this.ctx.createOscillator(); o.type = 'triangle';
      o.frequency.value = midi(72 + s);
      const g = this.ctx.createGain();
      const st = t + i * 0.06;
      this._env(g.gain, st, 0.005, 0.22, 0.25);
      o.connect(g); g.connect(this.sfxBus); g.connect(this.reverb);
      o.start(st); o.stop(st + 0.3);
    });
  }

  // Shofar-ish blast to punctuate a new hall / wave
  shofar() {
    if (!this.ready) return;
    const t = this._now();
    const notes = [[0, 0.0, 0.5], [7, 0.5, 0.9]]; // tekiah-ish rise
    for (const [semi, off, dur] of notes) {
      const o = this.ctx.createOscillator(); o.type = 'sawtooth';
      const f = midi(50 + semi);
      o.frequency.setValueAtTime(f * 0.98, t + off);
      o.frequency.linearRampToValueAtTime(f, t + off + 0.12);
      // vibrato
      const lfo = this.ctx.createOscillator(); lfo.frequency.value = 5.5;
      const lg = this.ctx.createGain(); lg.gain.value = f * 0.012;
      lfo.connect(lg); lg.connect(o.frequency); lfo.start(t + off); lfo.stop(t + off + dur);
      const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * 3; bp.Q.value = 3;
      const g = this.ctx.createGain();
      this._env(g.gain, t + off, 0.06, 0.32, dur, 0.7);
      o.connect(bp); bp.connect(g); g.connect(this.sfxBus); g.connect(this.reverb);
      o.start(t + off); o.stop(t + off + dur + 0.05);
    }
  }

  ui(type = 'click') {
    if (!this.ready) return;
    const t = this._now();
    const o = this.ctx.createOscillator(); o.type = 'triangle';
    o.frequency.value = type === 'hover' ? midi(76) : midi(69);
    const g = this.ctx.createGain(); this._env(g.gain, t, 0.003, type === 'hover' ? 0.08 : 0.16, 0.12);
    o.connect(g); g.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.2);
  }

  combo(n) {
    if (!this.ready) return;
    const t = this._now();
    const o = this.ctx.createOscillator(); o.type = 'square';
    o.frequency.value = midi(64 + Math.min(n, 18));
    const g = this.ctx.createGain(); this._env(g.gain, t, 0.002, 0.09, 0.09);
    o.connect(g); g.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.12);
  }

  // ============================================================= AMBIENCE
  ambient(on) {
    if (!this.ready) return;
    if (on && !this._ambNodes) {
      const t = this._now();
      // low murmuring drone (a beis medrash never sleeps)
      const n = this._noiseSrc();
      const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 0.6;
      const lfo = this.ctx.createOscillator(); lfo.frequency.value = 0.13;
      const lg = this.ctx.createGain(); lg.gain.value = 90;
      lfo.connect(lg); lg.connect(lp.frequency);
      const g = this.ctx.createGain(); g.gain.value = 0.5;
      n.connect(lp); lp.connect(g); g.connect(this.ambBus);
      // faint low pad
      const o = this.ctx.createOscillator(); o.type = 'sine'; o.frequency.value = midi(38);
      const og = this.ctx.createGain(); og.gain.value = 0.14;
      o.connect(og); og.connect(this.ambBus);
      n.start(t); lfo.start(t); o.start(t);
      this._ambNodes = { n, lfo, o };
      this.ambBus.gain.cancelScheduledValues(t);
      this.ambBus.gain.setValueAtTime(this.ambBus.gain.value, t);
      this.ambBus.gain.linearRampToValueAtTime(0.5, t + 2);
    } else if (!on && this._ambNodes) {
      const t = this._now();
      this.ambBus.gain.cancelScheduledValues(t);
      this.ambBus.gain.setValueAtTime(this.ambBus.gain.value, t);
      this.ambBus.gain.linearRampToValueAtTime(0.0, t + 1.5);
      const nodes = this._ambNodes; this._ambNodes = null;
      setTimeout(() => { try { nodes.n.stop(); nodes.lfo.stop(); nodes.o.stop(); } catch (e) {} }, 1700);
    }
  }

  // ============================================================= MUSIC
  setIntensity(x) { this._intensity = Math.max(0, Math.min(1, x)); }

  setMusic(name) {
    if (!this.ready) { this._musicName = name; return; }
    if (this._musicName === name) return;
    this._musicName = name;
    const t = this._now();
    // fuller ensemble now, so trim the bus a touch and let the compressor glue it
    const target = name ? (name === 'combat' ? 0.38 : 0.3) : 0.0;
    this.musicBus.gain.cancelScheduledValues(t);
    this.musicBus.gain.setValueAtTime(this.musicBus.gain.value, t);
    this.musicBus.gain.linearRampToValueAtTime(target, t + 1.2);

    if (name && !this._seqTimer) {
      this._step = 0;
      this._bar = 0;
      this._nextNoteTime = this._now() + 0.1;
      this._seqTimer = setInterval(() => this._scheduler(), 25);
    } else if (!name && this._seqTimer) {
      // let fade finish, then stop scheduler
      setTimeout(() => { if (!this._musicName) { clearInterval(this._seqTimer); this._seqTimer = null; } }, 1400);
    }
  }

  _scheduler() {
    if (!this.ready || !this._musicName) return;
    const ctx = this.ctx;
    this._bpm = this._musicName === 'combat' ? (108 + this._intensity * 46) : 76;
    const stepDur = 60 / this._bpm / 2; // eighth notes
    while (this._nextNoteTime < ctx.currentTime + 0.14) {
      this._scheduleStep(this._step, this._nextNoteTime, stepDur);
      this._step++;
      if (this._step >= 16) { this._step = 0; this._bar++; } // new bar -> next chord/phrase
      this._nextNoteTime += stepDur;
    }
  }

  // ---------- klezmer instrument voices ----------
  // scale-degree index -> semitone offset above the tonic (d>=7 climbs octaves,
  // d<0 descends), so melodies can be written as plain degree numbers.
  _deg(d) { const o = Math.floor(d / 7); return FREYGISH[((d % 7) + 7) % 7] + 12 * o; }

  _hat(t, open = false) {
    const n = this._noiseSrc();
    const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
    const g = this.ctx.createGain(); this._env(g.gain, t, 0.001, 0.08, open ? 0.14 : 0.045);
    n.connect(hp); hp.connect(g); g.connect(this.musicBus);
    n.start(t); n.stop(t + 0.2);
  }

  // Pizzicato upright bass — the "oom" of the oom-pah (plucked), or a held drone.
  _bass(semi, t, dur, peak, pluck = true) {
    const f = midi(this._root - 24 + semi);
    const o = this.ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
    const sub = this.ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = f;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; lp.Q.value = 0.7;
    const g = this.ctx.createGain();
    this._env(g.gain, t, pluck ? 0.006 : 0.04, peak, dur, pluck ? 0.2 : 0.7);
    o.connect(lp); sub.connect(lp); lp.connect(g); g.connect(this.musicBus);
    o.start(t); sub.start(t); o.stop(t + dur + 0.05); sub.stop(t + dur + 0.05);
  }

  // Accordion / bayan — musette-detuned reeds with a shared tremolo. Short = a
  // "pah" chord stab; long = a sustained pad under the whole bar.
  _accordion(tones, t, dur, peak, oct = 0) {
    const g = this.ctx.createGain();
    this._env(g.gain, t, 0.02, peak, dur, 0.8);
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 0.6;
    const trem = this.ctx.createOscillator(); trem.type = 'sine'; trem.frequency.value = 5.2;
    const tg = this.ctx.createGain(); tg.gain.value = peak * 0.16;
    trem.connect(tg); tg.connect(g.gain); trem.start(t); trem.stop(t + dur + 0.05);
    lp.connect(g); g.connect(this.musicBus); g.connect(this.musicReverb);
    for (const semi of tones) {
      const f = midi(this._root + oct + semi);
      for (const det of [0.994, 1.006]) {
        const o = this.ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f * det;
        o.connect(lp); o.start(t); o.stop(t + dur + 0.05);
      }
    }
  }

  // Tsimbl (hammered dulcimer) — a bright, faintly inharmonic pluck that rings out.
  _tsimbl(semi, t, peak, oct = 12) {
    const f = midi(this._root + oct + semi);
    const g = this.ctx.createGain(); this._env(g.gain, t, 0.002, peak, 0.42);
    g.connect(this.musicBus); g.connect(this.musicReverb);
    for (const [mult, amp, type] of [[1, 1, 'triangle'], [2.01, 0.4, 'sine'], [3.02, 0.16, 'sine']]) {
      const o = this.ctx.createOscillator(); o.type = type; o.frequency.value = f * mult;
      const pg = this.ctx.createGain(); pg.gain.value = amp;
      o.connect(pg); pg.connect(g); o.start(t); o.stop(t + 0.5);
    }
  }

  // Klezmer clarinet — reedy square+saw through a formant, with vibrato that
  // swells in, plus optional ornaments: a downward slide into the note, and a
  // krekht (the little sobbing grace note a step above, clipped short).
  _clarinet(semi, t, dur, peak, opts = {}) {
    const oct = opts.oct || 0;
    const f = midi(this._root + oct + semi);
    const o = this.ctx.createOscillator(); o.type = 'square';
    if (opts.slide) {
      o.frequency.setValueAtTime(f * opts.slide, t);
      o.frequency.exponentialRampToValueAtTime(f, t + Math.min(0.09, dur * 0.4));
    } else { o.frequency.setValueAtTime(f, t); }
    const o2 = this.ctx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = f;
    const o2g = this.ctx.createGain(); o2g.gain.value = 0.3;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2100; lp.Q.value = 0.9;
    const form = this.ctx.createBiquadFilter(); form.type = 'peaking'; form.frequency.value = 1500; form.gain.value = 6; form.Q.value = 1.2;
    const g = this.ctx.createGain(); this._env(g.gain, t, Math.min(0.03, dur * 0.2), peak, dur, 0.7);
    const vib = this.ctx.createOscillator(); vib.frequency.value = 5.5;
    const vg = this.ctx.createGain();
    vg.gain.setValueAtTime(0.0001, t); vg.gain.linearRampToValueAtTime(f * 0.013, t + dur * 0.5);
    vib.connect(vg); vg.connect(o.frequency); vg.connect(o2.frequency); vib.start(t); vib.stop(t + dur + 0.05);
    o.connect(lp); o2.connect(o2g); o2g.connect(lp); lp.connect(form); form.connect(g);
    g.connect(this.musicBus); g.connect(this.musicReverb);
    o.start(t); o2.start(t); o.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
    if (opts.krekht != null) {
      const gt = Math.max(t - 0.05, this.ctx.currentTime); // land just before the beat
      const ko = this.ctx.createOscillator(); ko.type = 'square'; ko.frequency.value = midi(this._root + oct + opts.krekht);
      const klp = this.ctx.createBiquadFilter(); klp.type = 'lowpass'; klp.frequency.value = 2200;
      const kg = this.ctx.createGain(); this._env(kg.gain, gt, 0.004, peak * 0.55, 0.08);
      ko.connect(klp); klp.connect(kg); kg.connect(this.musicBus);
      ko.start(gt); ko.stop(gt + 0.12);
    }
  }

  // Fiddle — bowed, detuned saws with a slow attack and vibrato; a lyrical
  // counter-voice that sustains under the clarinet when the fight heats up.
  _fiddle(semi, t, dur, peak) {
    const f = midi(this._root + 12 + semi);
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000; lp.Q.value = 0.8;
    const g = this.ctx.createGain(); this._env(g.gain, t, dur * 0.25, peak, dur, 0.85);
    const vib = this.ctx.createOscillator(); vib.frequency.value = 6.2;
    const vg = this.ctx.createGain(); vg.gain.setValueAtTime(0.0001, t); vg.gain.linearRampToValueAtTime(f * 0.01, t + dur * 0.4);
    vib.connect(vg); vib.start(t); vib.stop(t + dur + 0.05);
    for (const det of [0.995, 1.006]) {
      const o = this.ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f * det;
      vg.connect(o.frequency); o.connect(lp); o.start(t); o.stop(t + dur + 0.05);
    }
    lp.connect(g); g.connect(this.musicBus); g.connect(this.musicReverb);
  }

  // Frame-drum / dumbek kit
  _doom(t, peak = 0.5) { // deep hand-drum "doom" on the beat
    const o = this.ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(55, t + 0.14);
    const g = this.ctx.createGain(); this._env(g.gain, t, 0.004, peak, 0.2);
    o.connect(g); g.connect(this.musicBus); o.start(t); o.stop(t + 0.28);
    const n = this._noiseSrc(); const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400;
    const ng = this.ctx.createGain(); this._env(ng.gain, t, 0.002, peak * 0.4, 0.08);
    n.connect(lp); lp.connect(ng); ng.connect(this.musicBus); n.start(t); n.stop(t + 0.12);
  }
  _tek(t, peak = 0.24) { // crisp rim "tek"
    const n = this._noiseSrc(); const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2100; bp.Q.value = 1.3;
    const g = this.ctx.createGain(); this._env(g.gain, t, 0.001, peak, 0.05);
    n.connect(bp); bp.connect(g); g.connect(this.musicBus); n.start(t); n.stop(t + 0.08);
  }
  _snare(t, peak = 0.3) { // backbeat snare/frame with a tuned body
    const n = this._noiseSrc();
    const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1500;
    const g = this.ctx.createGain(); this._env(g.gain, t, 0.001, peak, 0.12);
    n.connect(hp); hp.connect(g); g.connect(this.musicBus); g.connect(this.musicReverb);
    n.start(t); n.stop(t + 0.18);
    const o = this.ctx.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(330, t); o.frequency.exponentialRampToValueAtTime(180, t + 0.08);
    const og = this.ctx.createGain(); this._env(og.gain, t, 0.001, peak * 0.4, 0.09);
    o.connect(og); og.connect(this.musicBus); o.start(t); o.stop(t + 0.12);
  }
  _tambourine(t, peak = 0.14) { // finger-cymbal / tambourine shimmer
    const n = this._noiseSrc(); const hp = this.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6000;
    const g = this.ctx.createGain(); this._env(g.gain, t, 0.001, peak, 0.16);
    n.connect(hp); hp.connect(g); g.connect(this.musicBus); g.connect(this.musicReverb);
    n.start(t); n.stop(t + 0.2);
    for (const fr of [5200, 7100]) {
      const o = this.ctx.createOscillator(); o.type = 'sine'; o.frequency.value = fr;
      const og = this.ctx.createGain(); this._env(og.gain, t, 0.001, peak * 0.3, 0.18);
      o.connect(og); og.connect(this.musicBus); o.start(t); o.stop(t + 0.22);
    }
  }

  // The arranger. Each 16-step bar pulls a chord from the progression and a
  // melodic phrase from a bank of a *coprime* length, so the two cycles only
  // realign after their least-common-multiple of bars — a very long loop before
  // any bar repeats verbatim. Per-note humanization and a slow `variation`
  // counter (which flips drum/voicing details every pass) hide the seams further.
  _scheduleStep(step, t, stepDur) {
    const combat = this._musicName === 'combat';
    const intensity = this._intensity;
    const rnd = () => Math.random();
    const hum = (a) => (rnd() * 2 - 1) * a;   // subtle velocity/timing wobble
    const T = (a) => t + hum(a);              // jittered start (safe under lookahead)

    const prog = combat ? COMBAT_PROG : MENU_PROG;
    const bank = combat ? COMBAT_MEL : MENU_MEL;
    const chord = CHORDS[prog[this._bar % prog.length]];
    const mel = bank[this._bar % bank.length];
    const bassRoot = chord[0], bassFifth = chord[2];
    const passes = Math.floor(this._bar / prog.length); // times through the form
    const lastBar = (this._bar % prog.length) === prog.length - 1;

    if (!combat) {
      // ---------------- Menu: a slow, contemplative nign ----------------
      if (step === 0) {
        this._accordion(chord, t, stepDur * 16, 0.05, -12);  // sustained pad
        this._bass(bassRoot, t, stepDur * 16, 0.16, false);  // low drone
        this._doom(T(0.006), 0.32);                          // frame drum, beat 1
      }
      if (step === 8) this._doom(T(0.006), 0.24);            // beat 3
      if (step === 4 || step === 12) this._tek(T(0.006), 0.11);
      if (step === 14 && passes % 2 === 1) this._tambourine(t, 0.08);

      const d = mel[step];
      if (d != null) {
        const dur = stepDur * (mel[step + 1] == null ? 2.4 : 1.3);
        const opts = {};
        if (step % 4 === 0 && rnd() < 0.5) opts.krekht = this._deg(d + 1); // the sob
        if (rnd() < 0.3) opts.slide = 1.03;                                // sigh into it
        this._clarinet(this._deg(d), T(0.006), dur, 0.12 + hum(0.015), opts);
      }
      // tsimbl arpeggio flourish through the bar's second half
      if (step === 6) this._tsimbl(chord[0], t, 0.10);
      if (step === 7) this._tsimbl(chord[1], t, 0.09);
      if (step === 9) this._tsimbl(chord[2], t, 0.09);
      return;
    }

    // ---------------- Combat: a driving bulgar / freylekhs ----------------
    // oom-pah: bass on the beats, accordion chord-stabs on the off-beats
    if (step === 0 || step === 8) this._bass(bassRoot, T(0.005), stepDur * 1.2, 0.32);
    if (step === 4 || step === 12) this._bass(bassFifth, T(0.005), stepDur * 1.2, 0.28);
    if (intensity > 0.55 && (step === 7 || step === 15)) this._bass(bassRoot, T(0.005), stepDur * 0.9, 0.2);
    if (step === 2 || step === 6 || step === 10 || step === 14)
      this._accordion(chord, T(0.006), stepDur * 1.1, 0.06 + intensity * 0.02, 0);
    if (step === 0 && intensity > 0.35) this._accordion(chord, t, stepDur * 16, 0.028, -12);

    // percussion — the kick pattern alternates every pass through the form
    const kick = passes % 2 === 0
      ? [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0]
      : [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    if (kick[step]) this._doom(T(0.004), 0.5);
    if (step === 4 || step === 12) this._snare(T(0.004), 0.3); // backbeat
    if (step % 2 === 0) this._hat(t, step % 8 === 4);
    if (intensity > 0.3 && step % 2 === 1) this._tek(t, 0.13);
    if (intensity > 0.5 && (step === 6 || step === 14)) this._tambourine(t, 0.12);

    // turnaround fill on the last bar of the form — a little tsimbl run
    if (lastBar && step >= 12) {
      if (step === 13 || step === 15) this._doom(t, 0.4);
      if (step >= 14) this._tsimbl(this._deg(step - 12 + 2), t, 0.12);
    }

    // fiddle counter-voice sustains the chord's fifth once the fight heats up
    if (intensity > 0.45 && step === 0) this._fiddle(bassFifth, t, stepDur * 15, 0.05 + intensity * 0.03);
    if (intensity > 0.25 && (step === 3 || step === 11)) this._tsimbl(chord[1], t, 0.09); // sparkle

    // lead clarinet — soars an octave up when intensity is high
    const d = mel[step];
    if (d != null) {
      const dur = stepDur * (mel[step + 1] == null ? 1.8 : 1.15);
      const opts = { oct: intensity > 0.6 ? 12 : 0 };
      if (step % 8 === 0 && rnd() < 0.4) opts.krekht = this._deg(d + 1);
      if (rnd() < 0.25) opts.slide = 1.04;
      this._clarinet(this._deg(d), T(0.005), dur, 0.11 + intensity * 0.03 + hum(0.012), opts);
    }
  }
}
