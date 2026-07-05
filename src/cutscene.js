// Generic cinematic director: sequences "beats" of camera moves, subtitles,
// fades, and callbacks. Scene-specific content (the intro) is assembled by the game.
import * as THREE from 'three';

function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

export class Cutscene {
  constructor(camera, ui, audio) {
    this.camera = camera; this.ui = ui; this.audio = audio;
    this.active = false;
    this._look = new THREE.Vector3();
  }

  play(beats, onDone) {
    this.beats = beats; this.i = -1; this.onDone = onDone;
    this.active = true;
    this.ui.showCinema(true); // intro is skippable — show the "Press Enter to skip" hint
    this._advance();
    return this;
  }

  _advance() {
    this.i++;
    if (this.i >= this.beats.length) { this._finish(); return; }
    const b = this.beats[this.i];
    this.beat = b; this.bt = 0;
    if (b.onEnter) b.onEnter();
    if (b.subtitle !== undefined) this.ui.setSubtitle(b.subtitle);
    // speak this beat's line (interrupts the previous one; no-op if the clip is absent)
    if (b.vo && this.audio.playVO) this.audio.playVO(b.vo);
    if (b.fade === 'out') this.ui.fade(true, b.fadeDur ?? 0.6);
    if (b.fade === 'in') this.ui.fade(false, b.fadeDur ?? 0.6);
    if (b.cam) this._applyCam(0);
  }

  _applyCam(p) {
    const c = this.beat.cam;
    const e = c.ease === false ? p : easeInOut(p);
    const from = c.from, to = c.to || c.from;
    const pos = lerp3(from.pos, to.pos, e);
    const look = lerp3(from.look, to.look, e);
    this.camera.position.set(pos[0], pos[1], pos[2]);
    this._look.set(look[0], look[1], look[2]);
    this.camera.lookAt(this._look);
  }

  update(dt) {
    if (!this.active || !this.beat) return;
    const b = this.beat;
    this.bt += dt;
    const p = b.duration > 0 ? Math.min(1, this.bt / b.duration) : 1;
    if (b.cam) this._applyCam(p);
    if (b.onUpdate) b.onUpdate(this.bt, p);
    if (this.bt >= b.duration) this._advance();
  }

  skip() {
    if (!this.active) return;
    // run any remaining onEnter side-effects that matter? Keep it simple: jump to end.
    this._finish();
  }

  _finish() {
    if (!this.active) return;
    this.active = false;
    this.beat = null;
    if (this.audio.stopVO) this.audio.stopVO(); // cut any line still speaking (e.g. on skip)
    this.ui.hideCinema();
    if (this.onDone) { const cb = this.onDone; this.onDone = null; cb(); }
  }
}
