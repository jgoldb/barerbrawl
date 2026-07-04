// Keyboard + mouse input with pointer lock for first-person look.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.locked = false;
    this.sensitivity = 0.0022;

    // edge-triggered action buffers (consumed by game logic)
    this.pressed = new Set();     // keys pressed this frame
    this.lightQueued = false;
    this.heavyQueued = false;
    this.shoveQueued = false;
    this.jumpQueued = false;

    // touch controls feed into these; keyboard/mouse leave them at rest
    this.touchMove = { x: 0, z: 0 }; // analog stick direction (merged into moveVector)
    this.touchSprint = false;        // set when the stick is pushed near max

    this._enabled = false;

    window.addEventListener('keydown', (e) => this._onKey(e, true));
    window.addEventListener('keyup', (e) => this._onKey(e, false));
    window.addEventListener('mousemove', (e) => this._onMove(e));
    window.addEventListener('mousedown', (e) => this._onMouseDown(e));
    window.addEventListener('contextmenu', (e) => { if (this.locked) e.preventDefault(); });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    document.addEventListener('pointerlockerror', () => { this.locked = false; });
  }

  setEnabled(on) {
    this._enabled = on;
    if (!on) {
      this.keys.clear();
      this.touchMove.x = 0; this.touchMove.z = 0; this.touchSprint = false;
      this.jumpQueued = this.lightQueued = this.heavyQueued = this.shoveQueued = false;
    }
  }

  requestLock() {
    if (this.canvas.requestPointerLock) {
      const p = this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    }
  }
  exitLock() { if (document.exitPointerLock) document.exitPointerLock(); }

  _onKey(e, down) {
    const code = e.code;
    if (down) {
      if (!this.keys.has(code)) this.pressed.add(code);
      this.keys.add(code);
      // prevent scroll on space/arrows while playing
      if (this._enabled && (code === 'Space' || code.startsWith('Arrow'))) e.preventDefault();
      if (this._enabled && code === 'Space') this.jumpQueued = true;
      if (this._enabled && code === 'KeyE') this.shoveQueued = true;
    } else {
      this.keys.delete(code);
    }
  }

  _onMove(e) {
    if (!this.locked || !this._enabled) return;
    this.mouseDX += e.movementX || 0;
    this.mouseDY += e.movementY || 0;
  }

  _onMouseDown(e) {
    if (!this.locked || !this._enabled) return;
    if (e.button === 0) this.lightQueued = true;
    else if (e.button === 2) { this.heavyQueued = true; e.preventDefault(); }
  }

  down(code) { return this.keys.has(code); }

  moveVector() {
    let x = 0, z = 0;
    if (this.down('KeyW') || this.down('ArrowUp')) z -= 1;
    if (this.down('KeyS') || this.down('ArrowDown')) z += 1;
    if (this.down('KeyA') || this.down('ArrowLeft')) x -= 1;
    if (this.down('KeyD') || this.down('ArrowRight')) x += 1;
    // touch joystick contributes its analog direction (the player normalizes)
    x += this.touchMove.x; z += this.touchMove.z;
    return { x, z };
  }

  sprinting() { return this.down('ShiftLeft') || this.down('ShiftRight') || this.touchSprint; }

  // touch look feeds the same delta accumulator as the mouse (no pointer lock needed)
  addLook(dx, dy) {
    if (!this._enabled) return;
    this.mouseDX += dx; this.mouseDY += dy;
  }

  // consume mouse deltas, returns {dx,dy}
  consumeMouse() {
    const d = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0; this.mouseDY = 0;
    return d;
  }

  // called at end of frame
  endFrame() { this.pressed.clear(); }

  consumeLight() { const v = this.lightQueued; this.lightQueued = false; return v; }
  consumeHeavy() { const v = this.heavyQueued; this.heavyQueued = false; return v; }
  consumeShove() { const v = this.shoveQueued; this.shoveQueued = false; return v; }
  consumeJump() { const v = this.jumpQueued; this.jumpQueued = false; return v; }
  wasPressed(code) { return this.pressed.has(code); }
}
