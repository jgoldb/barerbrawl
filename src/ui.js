// DOM-based HUD, menus, and cinematic overlay control.

const $ = (id) => document.getElementById(id);
const COMBO_WORDS = [
  [2, 'MAKKOS'], [4, 'MUSSAR'], [6, 'MABUL'], [9, 'SHKOYACH'],
  [13, 'GEVALDIG'], [18, 'MOICHEL'], [25, 'MOSHIACH'],
];

export class UI {
  constructor(audio) {
    this.audio = audio;
    this.onAction = null;
    this.screens = ['start', 'menu', 'help', 'sound', 'pause', 'gameover', 'quit', 'loading'];
    this.currentScreen = null;

    // delegated button handling
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (this.audio) this.audio.ui('click');
      if (this.onAction) this.onAction(b.dataset.act);
    });
    document.addEventListener('mouseover', (e) => {
      const b = e.target.closest('.btn');
      if (b && this.audio) this.audio.ui('hover');
    });

    // sound-settings sliders
    this._volCfg = [
      { id: 'vol-master', set: (v) => this.audio.setMasterVolume(v), get: () => this.audio.volumes.master },
      { id: 'vol-music', set: (v) => this.audio.setMusicVolume(v), get: () => this.audio.volumes.music },
      { id: 'vol-sfx', set: (v) => this.audio.setSfxVolume(v), get: () => this.audio.volumes.sfx },
    ];
    for (const c of this._volCfg) {
      const el = $(c.id);
      if (!el) continue;
      el.addEventListener('input', () => {
        const frac = (+el.value) / 100;
        c.set(frac);
        this._updateVolLabel(c.id, frac);
      });
    }
    // preview the level with a representative hit when the effects slider is released
    const sfxEl = $('vol-sfx');
    if (sfxEl) sfxEl.addEventListener('change', () => { if (this.audio) this.audio.hit(false); });

    // boss bar (created dynamically)
    const bb = document.createElement('div');
    bb.id = 'boss-bar';
    bb.innerHTML = '<div class="boss-name"></div><div class="boss-track"><div class="boss-fill"></div></div>';
    bb.style.cssText = 'position:absolute;left:50%;top:78px;transform:translateX(-50%);width:min(52vw,620px);text-align:center;opacity:0;transition:opacity .4s;pointer-events:none;';
    bb.querySelector('.boss-name').style.cssText = 'font-family:var(--disp,serif);letter-spacing:.16em;color:#e7c27a;font-size:16px;text-shadow:0 2px 8px #000;margin-bottom:4px;';
    const track = bb.querySelector('.boss-track');
    track.style.cssText = 'height:14px;background:rgba(10,4,3,.75);border:1px solid rgba(216,180,74,.55);border-radius:3px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.6);';
    bb.querySelector('.boss-fill').style.cssText = 'height:100%;width:100%;transform-origin:left;background:linear-gradient(180deg,#e0552e,#7a140c);transition:transform .2s;';
    $('hud').appendChild(bb);
    this.bossBar = bb; this.bossFill = bb.querySelector('.boss-fill'); this.bossName = bb.querySelector('.boss-name');

    // Chaim Barer's own health pool — a second, greener bar under the boss's
    const cb = document.createElement('div');
    cb.id = 'barer-bar';
    cb.innerHTML = '<div class="boss-name"></div><div class="boss-track"><div class="boss-fill"></div></div>';
    cb.style.cssText = 'position:absolute;left:50%;top:118px;transform:translateX(-50%);width:min(40vw,460px);text-align:center;opacity:0;transition:opacity .4s;pointer-events:none;';
    cb.querySelector('.boss-name').style.cssText = 'font-family:var(--disp,serif);letter-spacing:.14em;color:#9fe6b6;font-size:13px;text-shadow:0 2px 8px #000;margin-bottom:3px;';
    const ctrack = cb.querySelector('.boss-track');
    ctrack.style.cssText = 'height:11px;background:rgba(6,14,8,.75);border:1px solid rgba(70,196,110,.55);border-radius:3px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.6);';
    cb.querySelector('.boss-fill').style.cssText = 'height:100%;width:100%;transform-origin:left;background:linear-gradient(180deg,#5fe08a,#1a7a3a);transition:transform .2s;';
    $('hud').appendChild(cb);
    this.barerBar = cb; this.barerFill = cb.querySelector('.boss-fill'); this.barerName = cb.querySelector('.boss-name');

    // ---- Barer finisher: the two-option prompt + the LEWIE BALLEWIE banner
    const fp = document.createElement('div');
    fp.id = 'finisher-prompt';
    fp.innerHTML = '<div class="fin-opt fin-left"><span class="fin-key">L-CLICK</span><span class="fin-lbl">Jab</span></div>'
      + '<div class="fin-opt fin-right"><span class="fin-key">R-CLICK</span><span class="fin-lbl">Baruch dayan haemet</span></div>';
    fp.classList.add('hidden');
    $('app').appendChild(fp);
    this.finisherPromptEl = fp;

    const lb = document.createElement('div');
    lb.id = 'lewie-banner'; lb.textContent = 'LEWIE BALLEWIE!';
    lb.classList.add('hidden');
    $('app').appendChild(lb);
    this.lewieEl = lb;

    // click-to-lock prompt
    const pr = document.createElement('div');
    pr.id = 'prompt';
    pr.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;z-index:25;pointer-events:none;background:rgba(4,2,1,.35);';
    pr.innerHTML = '<div style="font-family:var(--disp,serif);font-size:34px;letter-spacing:.14em;color:#f4d878;text-shadow:0 3px 18px #000;"><span class="only-kbd">CLICK TO BRAWL</span><span class="only-touch">TAP TO BRAWL</span></div>'
      + '<div style="font-size:15px;color:#c9b98e;font-style:italic;">'
      + '<span class="only-kbd">WASD move · Mouse look · L-click jab · R-click haymaker · Space jump · E shove</span>'
      + '<span class="only-touch">Left thumb moves · drag right to look · buttons to brawl</span></div>';
    pr.classList.add('hidden');
    $('hud').appendChild(pr);
    this.promptEl = pr;

    this._comboBumpT = 0;
    this._toastT = 0;
    this._objT = 0;
    this._cornerPulse = 0;
  }

  showPrompt(on) { this.promptEl.classList.toggle('hidden', !on); }

  // ---------- screens ----------
  showScreen(name) {
    for (const s of this.screens) $(s).classList.toggle('hidden', s !== name);
    this.currentScreen = name;
  }
  hideScreens() { for (const s of this.screens) $(s).classList.add('hidden'); this.currentScreen = null; }

  showHUD(on) { $('hud').classList.toggle('hidden', !on); }

  // reflect the persisted volumes onto the sliders (call before showing the sound screen)
  syncSoundControls() {
    for (const c of this._volCfg) {
      const el = $(c.id);
      if (!el) continue;
      const frac = c.get();
      el.value = Math.round(frac * 100);
      this._updateVolLabel(c.id, frac);
    }
  }
  _updateVolLabel(id, frac) {
    const pct = Math.round(frac * 100);
    const el = $(id), val = $(id + '-val');
    if (val) val.textContent = `${pct}%`;
    if (el) el.style.setProperty('--fill', `${pct}%`);
  }

  setLoading(pct, txt) {
    const f = document.querySelector('.load-fill'); if (f) f.style.width = `${pct}%`;
    if (txt) { const t = document.querySelector('.load-txt'); if (t) t.textContent = txt; }
  }

  // ---------- cinema ----------
  showCinema(skippable = false) {
    const c = $('cinema');
    c.classList.remove('hidden'); c.classList.remove('closed');
    // the "Press Enter to skip" hint only applies to the intro cutscene; the finisher
    // and the Barer-down beat play out fully, so hide it there
    const skip = $('cinema-skip');
    if (skip) skip.style.display = skippable ? '' : 'none';
  }
  hideCinema() {
    const c = $('cinema');
    c.classList.add('closed');
    this.setSubtitle('');
    setTimeout(() => c.classList.add('hidden'), 850);
  }
  setSubtitle(html) {
    const s = $('subtitle');
    s.style.opacity = '0';
    // small delay so the fade restarts each line
    setTimeout(() => { s.innerHTML = html || ''; s.style.transition = 'opacity .6s ease'; s.style.opacity = html ? '1' : '0'; }, 60);
  }

  fade(toBlack, dur = 0.6) {
    const f = $('fade');
    f.style.transitionDuration = `${dur}s`;
    f.classList.toggle('clear', !toBlack);
  }
  fadeClearInstant() { const f = $('fade'); f.style.transitionDuration = '0s'; f.classList.add('clear'); }

  // ---------- HUD values ----------
  setHealth(frac) {
    frac = Math.max(0, Math.min(1, frac));
    $('health-fill').style.transform = `scaleX(${frac})`;
    $('health-ghost').style.transform = `scaleX(${frac})`;
    const fill = $('health-fill');
    fill.style.background = frac < 0.3
      ? 'linear-gradient(180deg,#ff5a3a,#b01008)'
      : 'linear-gradient(180deg,#e04a2e,#9a1c10)';
  }
  setScore(n) { $('score-val').textContent = Math.floor(n).toLocaleString(); }
  setDepth(n) { $('depth-val').textContent = n; }

  setCombo(n) {
    const c = $('combo');
    if (n < 2) { c.classList.add('hidden'); return; }
    c.classList.remove('hidden');
    $('combo-num').textContent = n;
    let word = 'MAKKOS';
    for (const [th, w] of COMBO_WORDS) if (n >= th) word = w;
    $('combo-word').textContent = word;
    c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump');
  }

  objective(text, cls = '') {
    const o = $('objective');
    o.className = 'show ' + cls;
    o.innerHTML = text;
    this._objT = 0; this._objHold = true;
  }
  hideObjective() { $('objective').classList.remove('show'); this._objHold = false; }

  toast(text, dur = 2.2) {
    const t = $('toast');
    t.innerHTML = text; t.classList.add('show'); this._toastT = dur;
  }

  hitmarker() {
    const h = $('hitmarker');
    h.classList.remove('show'); void h.offsetWidth; h.classList.add('show');
    const c = $('crosshair');
    c.classList.add('hit'); setTimeout(() => c.classList.remove('hit'), 90);
  }

  damageFlash(intensity = 1) {
    const v = $('dmg-vignette');
    v.style.transition = 'opacity .05s'; v.style.opacity = Math.min(0.95, intensity);
    setTimeout(() => { v.style.transition = 'opacity .5s ease'; v.style.opacity = '0'; }, 60);
  }

  // Wall-hug telegraph, driven each frame by the player's cornered meter (0..1):
  // a closing-in vignette, plus a "KEEP MOVING" warning that pulses (faster as it
  // worsens) from within the grace window, before chip damage begins.
  setCorner(frac, dt = 0) {
    $('corner-vignette').style.opacity = Math.min(0.9, frac * 1.05).toFixed(3);
    const warn = $('corner-warn');
    if (frac > 0.22) {
      this._cornerPulse += dt * (7 + 7 * frac);
      const pulse = 0.5 + 0.5 * Math.abs(Math.sin(this._cornerPulse));
      warn.style.opacity = (pulse * Math.min(1, (frac - 0.12) * 1.8)).toFixed(3);
    } else {
      warn.style.opacity = '0';
    }
  }

  setBoss(name, frac) {
    if (frac == null) { this.bossBar.style.opacity = '0'; return; }
    this.bossBar.style.opacity = '1';
    this.bossName.textContent = name;
    this.bossFill.style.transform = `scaleX(${Math.max(0, frac)})`;
  }

  // Chaim Barer's separate pool. `invuln` shows the shield lock; hide with frac == null.
  setBarer(frac, invuln = false) {
    if (frac == null) { this.barerBar.style.opacity = '0'; return; }
    this.barerBar.style.opacity = '1';
    this.barerName.innerHTML = invuln ? '🛡 חיים בערער · CHAIM BARER <span style="color:#c9b98e">(shielded)</span>' : '☠ חיים בערער · CHAIM BARER';
    this.barerFill.style.background = invuln
      ? 'linear-gradient(180deg,#7a8a80,#3a463e)'
      : 'linear-gradient(180deg,#5fe08a,#1a7a3a)';
    this.barerFill.style.transform = `scaleX(${Math.max(0, frac)})`;
  }

  showFinisherPrompt(on) { this.finisherPromptEl.classList.toggle('hidden', !on); }

  lewieBanner() {
    const el = this.lewieEl;
    el.classList.remove('hidden');
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
    setTimeout(() => el.classList.add('hidden'), 2200);
  }

  floaty(x, y, text, opts = {}) {
    const el = document.createElement('div');
    el.className = 'floaty';
    el.textContent = text;
    const size = opts.size || 22;
    el.style.left = x + 'px'; el.style.top = y + 'px';
    el.style.fontSize = size + 'px';
    el.style.color = opts.color || '#f4d878';
    el.style.transform = 'translate(-50%,-50%) scale(0.7)';
    el.style.opacity = '1';
    el.style.transition = 'transform .9s cubic-bezier(.2,.8,.3,1), opacity .9s ease';
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.style.transform = `translate(-50%,-140%) scale(${opts.crit ? 1.3 : 1})`;
      el.style.opacity = '0';
    });
    setTimeout(() => el.remove(), 950);
  }

  setGameOver(stats, flavor) {
    $('go-flavor').textContent = flavor;
    $('go-stats').innerHTML = `
      <span class="k">Hall reached</span><span class="v">${stats.depth}</span>
      <span class="k">Bochurim felled</span><span class="v">${stats.kills}</span>
      <span class="k">Best combo</span><span class="v">${stats.bestCombo}×</span>
      <span class="k">Score</span><span class="v">${Math.floor(stats.score).toLocaleString()}</span>
      <span class="k">Time survived</span><span class="v">${stats.time}</span>`;
  }

  // called each frame to time out transient elements
  update(dt) {
    if (this._toastT > 0) { this._toastT -= dt; if (this._toastT <= 0) $('toast').classList.remove('show'); }
    if (this._objHold) { this._objT += dt; }
  }
}
