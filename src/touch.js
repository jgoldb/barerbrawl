// On-screen touch controls for phones/tablets: a left analog stick for movement,
// a right drag zone for looking, and action buttons — all feeding the same Input
// buffers the keyboard/mouse use, so the game logic stays input-agnostic.

const STICK_R = 62;   // max knob travel from the stick origin, px
const LOOK_SCALE = 1.7; // touch drag → look delta multiplier (on top of Input.sensitivity)

export class TouchControls {
  constructor(input, opts = {}) {
    this.input = input;
    this.onPause = opts.onPause || (() => {});
    this.onOrientation = opts.onOrientation || (() => {});

    this.moveId = null; this.moveOrigin = null;
    this.lookId = null;  this.lookLast = null;
    this.portrait = false;

    this._build();
    this._wireOrientation();
  }

  // ---------------------------------------------------------------- DOM
  _build() {
    const root = document.createElement('div');
    root.id = 'touch';
    root.className = 'hidden';

    // movement joystick (left) — the base is placed wherever the thumb lands
    this.moveZone = el('div', 'tc-move', root);
    this.stick = el('div', 'tc-stick', this.moveZone);
    this.knob = el('div', 'tc-knob', this.stick);
    this.stick.style.opacity = '0';

    // look drag zone (right)
    this.lookZone = el('div', 'tc-look', root);

    // action buttons (appended last so they stack above the look zone)
    this.btnJump = this._button('jump', 'JUMP', () => { this.input.jumpQueued = true; }, root);
    this.btnShove = this._button('shove', 'SHOVE', () => { this.input.shoveQueued = true; }, root);
    this.btnHeavy = this._button('heavy', 'HAYMAKER', () => { this.input.heavyQueued = true; }, root);
    this.btnJab = this._button('jab', 'JAB', () => { this.input.lightQueued = true; }, root);

    // pause (top-right)
    this.btnPause = this._button('pause', 'II', () => this.onPause(), root, false);

    document.getElementById('app').appendChild(root);
    this.root = root;

    this._wireStick();
    this._wireLook();
  }

  _button(kind, label, fn, parent, preventLook = true) {
    const b = el('div', 'tc-btn tc-' + kind, parent);
    b.textContent = label;
    const press = (e) => {
      e.preventDefault();
      if (preventLook) e.stopPropagation();
      b.classList.add('down');
      fn();
    };
    const release = () => b.classList.remove('down');
    b.addEventListener('pointerdown', press);
    b.addEventListener('pointerup', release);
    b.addEventListener('pointercancel', release);
    b.addEventListener('pointerleave', release);
    return b;
  }

  // ---------------------------------------------------------------- joystick
  _wireStick() {
    const z = this.moveZone;
    z.addEventListener('pointerdown', (e) => {
      if (this.moveId !== null) return;
      this.moveId = e.pointerId;
      try { z.setPointerCapture(e.pointerId); } catch (err) {}
      this.moveOrigin = { x: e.clientX, y: e.clientY };
      this.stick.style.left = e.clientX + 'px';
      this.stick.style.top = e.clientY + 'px';
      this.stick.style.opacity = '1';
      this._updateStick(e.clientX, e.clientY);
      e.preventDefault();
    });
    z.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.moveId) return;
      this._updateStick(e.clientX, e.clientY);
    });
    const end = (e) => {
      if (e.pointerId !== this.moveId) return;
      this.moveId = null;
      this.stick.style.opacity = '0';
      this.knob.style.transform = 'translate(-50%,-50%)';
      this.input.touchMove.x = 0; this.input.touchMove.z = 0;
      this.input.touchSprint = false;
    };
    z.addEventListener('pointerup', end);
    z.addEventListener('pointercancel', end);
  }

  _updateStick(cx, cy) {
    let dx = cx - this.moveOrigin.x, dy = cy - this.moveOrigin.y;
    const mag = Math.hypot(dx, dy) || 0;
    if (mag > STICK_R) { dx = dx / mag * STICK_R; dy = dy / mag * STICK_R; }
    this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    // screen up (−dy) = forward (−z); screen right (+dx) = strafe right (+x)
    this.input.touchMove.x = dx / STICK_R;
    this.input.touchMove.z = dy / STICK_R;
    this.input.touchSprint = mag > STICK_R * 0.92;
  }

  // ---------------------------------------------------------------- look
  _wireLook() {
    const z = this.lookZone;
    z.addEventListener('pointerdown', (e) => {
      if (this.lookId !== null) return;
      this.lookId = e.pointerId;
      try { z.setPointerCapture(e.pointerId); } catch (err) {}
      this.lookLast = { x: e.clientX, y: e.clientY };
      e.preventDefault();
    });
    z.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookId) return;
      this.input.addLook((e.clientX - this.lookLast.x) * LOOK_SCALE, (e.clientY - this.lookLast.y) * LOOK_SCALE);
      this.lookLast.x = e.clientX; this.lookLast.y = e.clientY;
    });
    const end = (e) => { if (e.pointerId === this.lookId) this.lookId = null; };
    z.addEventListener('pointerup', end);
    z.addEventListener('pointercancel', end);
  }

  // ---------------------------------------------------------------- orientation
  _wireOrientation() {
    this.rotateEl = document.getElementById('rotate');
    const check = () => {
      const p = window.innerHeight > window.innerWidth;
      const changed = p !== this.portrait;
      this.portrait = p;
      if (this.rotateEl) this.rotateEl.classList.toggle('show', p);
      if (p) this.setVisible(false);
      if (changed) this.onOrientation(p);
    };
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    check();
  }

  isPortrait() { return this.portrait; }

  // ---------------------------------------------------------------- visibility
  setVisible(on) {
    // never show the sticks over a portrait "rotate device" screen
    if (on && this.portrait) on = false;
    this.root.classList.toggle('hidden', !on);
    if (!on) this._resetActive();
  }

  _resetActive() {
    this.moveId = null; this.lookId = null;
    this.stick.style.opacity = '0';
    this.knob.style.transform = 'translate(-50%,-50%)';
    for (const b of [this.btnJab, this.btnHeavy, this.btnShove, this.btnJump, this.btnPause]) b.classList.remove('down');
    this.input.touchMove.x = 0; this.input.touchMove.z = 0; this.input.touchSprint = false;
  }
}

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}
