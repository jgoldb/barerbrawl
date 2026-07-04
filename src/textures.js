// Procedural canvas textures — everything is drawn at runtime, no image files.
import * as THREE from 'three';

function cv(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, x: c.getContext('2d') };
}

function tex(canvas, rx = 1, ry = 1) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function noise(x, w, h, amt, alpha = 0.06, dark = true) {
  for (let i = 0; i < (w * h) / 22; i++) {
    const px = Math.random() * w, py = Math.random() * h;
    const s = Math.random() * amt + 0.5;
    x.fillStyle = `rgba(${dark ? '0,0,0' : '255,255,255'},${Math.random() * alpha})`;
    x.fillRect(px, py, s, s);
  }
}

export function woodFloor() {
  const w = 512, h = 512, { c, x } = cv(w, h);
  x.fillStyle = '#3a2413'; x.fillRect(0, 0, w, h);
  const plankH = 64;
  for (let py = 0; py < h; py += plankH) {
    const base = 26 + Math.random() * 26;
    x.fillStyle = `rgb(${58 + base | 0},${34 + base * 0.6 | 0},${16 + base * 0.35 | 0})`;
    x.fillRect(0, py, w, plankH - 2);
    // grain streaks
    for (let g = 0; g < 26; g++) {
      x.strokeStyle = `rgba(30,16,6,${0.05 + Math.random() * 0.12})`;
      x.lineWidth = 0.6 + Math.random();
      x.beginPath();
      const gy = py + Math.random() * plankH;
      x.moveTo(0, gy);
      for (let gx = 0; gx <= w; gx += 32) x.lineTo(gx, gy + Math.sin(gx * 0.05 + g) * 1.6 + (Math.random() - 0.5) * 2);
      x.stroke();
    }
    // plank seam shadow
    x.fillStyle = 'rgba(0,0,0,0.5)'; x.fillRect(0, py + plankH - 2, w, 2);
    x.fillStyle = 'rgba(120,90,50,0.15)'; x.fillRect(0, py, w, 1);
    // random vertical board joints
    if (Math.random() < 0.7) {
      const jx = Math.random() * w;
      x.fillStyle = 'rgba(0,0,0,0.35)'; x.fillRect(jx, py, 1.5, plankH - 2);
    }
  }
  noise(x, w, h, 2, 0.05);
  const t = tex(c, 3, 3);
  return t;
}

export function woodPanel() {
  const w = 256, h = 256, { c, x } = cv(w, h);
  x.fillStyle = '#20140a'; x.fillRect(0, 0, w, h);
  for (let px = 0; px < w; px += 42) {
    const base = 18 + Math.random() * 18;
    x.fillStyle = `rgb(${40 + base | 0},${24 + base * 0.6 | 0},${12 + base * 0.3 | 0})`;
    x.fillRect(px, 0, 40, h);
    x.fillStyle = 'rgba(0,0,0,0.55)'; x.fillRect(px + 40, 0, 2, h);
    x.fillStyle = 'rgba(150,110,60,0.12)'; x.fillRect(px, 0, 1, h);
    for (let g = 0; g < 20; g++) {
      x.strokeStyle = `rgba(20,10,4,${0.05 + Math.random() * 0.1})`;
      x.beginPath(); const gx = px + Math.random() * 40;
      x.moveTo(gx, 0);
      for (let gy = 0; gy <= h; gy += 24) x.lineTo(gx + Math.sin(gy * 0.06 + g) * 1.4, gy);
      x.stroke();
    }
  }
  noise(x, w, h, 2, 0.05);
  return tex(c, 1, 1);
}

export function plaster(tint = [222, 206, 170]) {
  const w = 256, h = 256, { c, x } = cv(w, h);
  const [r, g, b] = tint;
  x.fillStyle = `rgb(${r},${g},${b})`; x.fillRect(0, 0, w, h);
  // subtle mottling
  for (let i = 0; i < 900; i++) {
    const px = Math.random() * w, py = Math.random() * h, s = Math.random() * 18 + 4;
    const d = (Math.random() - 0.5) * 22;
    x.fillStyle = `rgba(${r + d | 0},${g + d | 0},${b + d | 0},0.5)`;
    x.beginPath(); x.arc(px, py, s, 0, 7); x.fill();
  }
  // faint water stains near where a ceiling would be (top)
  for (let i = 0; i < 4; i++) {
    const gx = Math.random() * w;
    const grad = x.createRadialGradient(gx, 0, 4, gx, 0, 60 + Math.random() * 40);
    grad.addColorStop(0, 'rgba(80,60,30,0.14)'); grad.addColorStop(1, 'rgba(80,60,30,0)');
    x.fillStyle = grad; x.fillRect(gx - 80, 0, 160, 120);
  }
  noise(x, w, h, 2, 0.04);
  return tex(c, 2, 1.4);
}

export function carpet() {
  const w = 128, h = 256, { c, x } = cv(w, h);
  x.fillStyle = '#5a1410'; x.fillRect(0, 0, w, h);
  // border
  x.strokeStyle = '#c8a03a'; x.lineWidth = 6;
  x.strokeRect(9, 9, w - 18, h - 18);
  x.strokeStyle = '#3a0d0a'; x.lineWidth = 2; x.strokeRect(16, 16, w - 32, h - 32);
  // repeating diamond motif
  x.strokeStyle = 'rgba(200,160,58,0.55)'; x.lineWidth = 2;
  for (let cy = 40; cy < h; cy += 56) {
    x.beginPath();
    x.moveTo(w / 2, cy - 18); x.lineTo(w / 2 + 22, cy); x.lineTo(w / 2, cy + 18); x.lineTo(w / 2 - 22, cy);
    x.closePath(); x.stroke();
    x.fillStyle = 'rgba(200,160,58,0.18)'; x.fill();
  }
  noise(x, w, h, 2, 0.08);
  noise(x, w, h, 2, 0.05, 0.05, false);
  return tex(c, 1, 4);
}

export function stone() {
  const w = 256, h = 256, { c, x } = cv(w, h);
  x.fillStyle = '#5b5348'; x.fillRect(0, 0, w, h);
  const bh = 42;
  let off = 0;
  for (let py = 0; py < h; py += bh) {
    off = off ? 0 : 64;
    for (let px = -64; px < w; px += 86) {
      const v = 70 + Math.random() * 40;
      x.fillStyle = `rgb(${v},${v - 6},${v - 16})`;
      x.fillRect(px + off + 2, py + 2, 82, bh - 4);
      x.strokeStyle = 'rgba(20,18,14,0.7)'; x.lineWidth = 3;
      x.strokeRect(px + off + 2, py + 2, 82, bh - 4);
    }
  }
  noise(x, w, h, 3, 0.08);
  return tex(c, 2, 2);
}

// A bookshelf full of sefarim (spines) — used as a texture on shelf boxes.
export function books() {
  const w = 512, h = 512, { c, x } = cv(w, h);
  x.fillStyle = '#read'; // fallback
  x.fillStyle = '#1a0f06'; x.fillRect(0, 0, w, h);
  const rows = 6, rowH = h / rows;
  const spineColors = [
    ['#6b1f16', '#8a2a1e'], ['#123a2a', '#1c5a42'], ['#20263f', '#31406a'],
    ['#5a4410', '#8a6a1a'], ['#3a1230', '#5a1e4a'], ['#4a3520', '#6e5030'],
    ['#101418', '#26303a'], ['#5c1010', '#7a1a1a'],
  ];
  for (let r = 0; r < rows; r++) {
    const y0 = r * rowH;
    // shelf plank shadow
    x.fillStyle = '#0a0603'; x.fillRect(0, y0 + rowH - 8, w, 8);
    x.fillStyle = 'rgba(120,90,50,0.2)'; x.fillRect(0, y0, w, 2);
    let px = 2;
    while (px < w - 4) {
      const bw = 12 + Math.random() * 26;
      const lean = Math.random() < 0.06;
      const [c1, c2] = spineColors[(Math.random() * spineColors.length) | 0];
      const grad = x.createLinearGradient(px, 0, px + bw, 0);
      grad.addColorStop(0, c2); grad.addColorStop(0.5, c1); grad.addColorStop(1, '#000');
      x.save();
      if (lean) { x.translate(px + bw / 2, y0 + rowH / 2); x.rotate(0.14); x.translate(-(px + bw / 2), -(y0 + rowH / 2)); }
      const bh = rowH - 10 - Math.random() * 12;
      x.fillStyle = grad;
      x.fillRect(px, y0 + (rowH - 8 - bh), bw, bh);
      // gold band / title
      if (Math.random() < 0.7) {
        x.fillStyle = 'rgba(210,175,70,0.85)';
        const gy = y0 + rowH * 0.3 + Math.random() * rowH * 0.3;
        x.fillRect(px + 2, gy, bw - 4, 2 + Math.random() * 2);
      }
      // vertical hint of embossing
      x.fillStyle = 'rgba(255,240,200,0.05)'; x.fillRect(px + 1, y0 + (rowH - 8 - bh), 1, bh);
      x.restore();
      px += bw + 1 + Math.random() * 2;
    }
  }
  noise(x, w, h, 2, 0.1);
  return tex(c, 1, 1);
}

export function ceilingTex() {
  const w = 256, h = 256, { c, x } = cv(w, h);
  x.fillStyle = '#2a1d12'; x.fillRect(0, 0, w, h);
  // coffered beams
  x.strokeStyle = '#160e07'; x.lineWidth = 20;
  for (let i = 0; i <= 256; i += 128) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, h); x.stroke(); x.beginPath(); x.moveTo(0, i); x.lineTo(w, i); x.stroke(); }
  x.fillStyle = 'rgba(120,90,50,0.1)';
  for (let i = 64; i < 256; i += 128) x.fillRect(i - 40, i - 40, 80, 80);
  noise(x, w, h, 2, 0.06);
  return tex(c, 4, 4);
}

// Parchment for banners / signage
export function parchment() {
  const w = 256, h = 128, { c, x } = cv(w, h);
  x.fillStyle = '#d8c79a'; x.fillRect(0, 0, w, h);
  for (let i = 0; i < 400; i++) {
    const px = Math.random() * w, py = Math.random() * h;
    x.fillStyle = `rgba(120,90,40,${Math.random() * 0.08})`;
    x.beginPath(); x.arc(px, py, Math.random() * 10, 0, 7); x.fill();
  }
  x.strokeStyle = 'rgba(90,60,20,0.4)'; x.lineWidth = 4; x.strokeRect(4, 4, w - 8, h - 8);
  return tex(c, 1, 1);
}

// The night beyond a window is drawn as three depth layers stacked inside a
// shadow-box (see props.js): this opaque back plane plus two transparent skyline
// layers (nightSkyline). Real depth between the layers gives real parallax as the
// player moves. Tinted by the room's window-glow color — warm halls glow warm at
// the horizon, a crypt stays cold and blue.

// Layer 1 (deepest): sky gradient, stars, and a single hazy moon. Opaque.
export function nightSky(glowHex = 0xffcf82) {
  const w = 256, h = 384, { c, x } = cv(w, h);
  const gr = (glowHex >> 16) & 255, gg = (glowHex >> 8) & 255, gb = glowHex & 255;
  const cold = gb > gr; // a bluish glow (crypt) -> colder night palette
  const starTint = cold ? '200,220,255' : '255,244,214';

  const sky = x.createLinearGradient(0, 0, 0, h);
  if (cold) {
    sky.addColorStop(0, '#05070f'); sky.addColorStop(0.55, '#0b1226');
    sky.addColorStop(0.82, '#152238'); sky.addColorStop(1, '#20304a');
  } else {
    sky.addColorStop(0, '#080a18'); sky.addColorStop(0.5, '#141026');
    sky.addColorStop(0.8, '#33203a');
    sky.addColorStop(1, `rgb(${Math.min(255, (gr * 0.6 | 0) + 34)},${(gg * 0.45 | 0) + 26},${(gb * 0.4 | 0) + 30})`);
  }
  x.fillStyle = sky; x.fillRect(0, 0, w, h);

  for (let i = 0; i < 165; i++) { // stars, thickest up high
    const sx = Math.random() * w, sy = Math.random() * h * 0.82;
    const a = 0.2 + Math.random() * 0.8, r = Math.random() < 0.12 ? 1.6 : 0.9;
    x.fillStyle = `rgba(${starTint},${a})`;
    x.beginPath(); x.arc(sx, sy, r, 0, 7); x.fill();
  }

  // a single moon with a soft halo and a few craters
  const mx = w * (0.28 + Math.random() * 0.44), my = h * (0.16 + Math.random() * 0.14), mr = 15 + Math.random() * 8;
  const halo = x.createRadialGradient(mx, my, 2, mx, my, mr * 3.4);
  halo.addColorStop(0, cold ? 'rgba(210,225,255,0.5)' : 'rgba(255,240,210,0.5)');
  halo.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = halo; x.beginPath(); x.arc(mx, my, mr * 3.4, 0, 7); x.fill();
  x.fillStyle = cold ? '#dfe8ff' : '#fff4d6'; x.beginPath(); x.arc(mx, my, mr, 0, 7); x.fill();
  x.fillStyle = cold ? 'rgba(150,170,210,0.4)' : 'rgba(210,190,150,0.4)';
  for (let i = 0; i < 4; i++) {
    const a = Math.random() * 7, d = Math.random() * mr * 0.6;
    x.beginPath(); x.arc(mx + Math.cos(a) * d, my + Math.sin(a) * d, 1.5 + Math.random() * 3, 0, 7); x.fill();
  }

  noise(x, w, h, 2, 0.04);
  return tex(c, 1, 1);
}

// Layers 2 & 3: a silhouetted skyline drawn on transparent glass so the sky (and,
// for the near layer, the far layer) shows through the gaps. `near` sits closer to
// the glass with bigger, darker rooftops + trees; the far layer sits deeper with
// smaller, dimmer buildings. Solid alpha everywhere (an alpha-tested cutout in the
// material) so there is no transparency sorting to get wrong.
export function nightSkyline(glowHex = 0xffcf82, near = false) {
  const w = 256, h = 384, { c, x } = cv(w, h);
  const gr = (glowHex >> 16) & 255, gg = (glowHex >> 8) & 255, gb = glowHex & 255;
  const cold = gb > gr;
  const body = cold ? (near ? '#03050a' : '#060a12') : (near ? '#050308' : '#0a0810');
  const lit = `rgb(${Math.min(255, gr + 30)},${Math.min(255, gg + 12)},${Math.max(34, gb - 18)})`;
  const litDim = `rgb(${gr * 0.5 | 0},${gg * 0.42 | 0},${gb * 0.34 | 0})`;
  const baseY = near ? h * 0.99 : h * 0.8;
  const minH = near ? 55 : 22, maxH = near ? 150 : 66, roofPk = near ? 20 : 11;

  let bx = -12;
  while (bx < w + 12) {
    const bw = near ? (30 + Math.random() * 46) : (18 + Math.random() * 30);
    const bh = minH + Math.random() * (maxH - minH), top = baseY - bh;
    x.fillStyle = body; x.fillRect(bx, top, bw, h - top);
    if (Math.random() < 0.5) { // pitched roof (a shtiebel among the flats)
      x.beginPath(); x.moveTo(bx - 2, top); x.lineTo(bx + bw / 2, top - roofPk - Math.random() * 12); x.lineTo(bx + bw + 2, top); x.closePath(); x.fill();
    }
    if (Math.random() < 0.4) x.fillRect(bx + bw * (0.2 + Math.random() * 0.6), top - 8, 4, 8); // chimney
    for (let wy = top + 6; wy < baseY - 6; wy += 10) { // lit windows
      for (let wxx = bx + 4; wxx < bx + bw - 5; wxx += 9) {
        if (Math.random() < 0.5) { x.fillStyle = Math.random() < 0.72 ? (near ? lit : litDim) : '#000'; x.fillRect(wxx, wy, 4, 5); }
      }
    }
    bx += bw + 2 + Math.random() * 6;
  }

  if (near) { // a grounded foreground: ground strip + a couple of bare-tree silhouettes
    x.fillStyle = body; x.fillRect(0, h * 0.92, w, h * 0.08);
    for (let i = 0; i < 3; i++) {
      const tx = Math.random() * w, ty = h * 0.92, r = 16 + Math.random() * 16;
      x.fillStyle = body; x.beginPath(); x.arc(tx, ty - r * 0.6, r, 0, 7); x.fill();
      x.fillRect(tx - 3, ty - r, 6, r);
    }
  }

  return tex(c, 1, 1); // transparent background preserved (canvas was never filled)
}

// Transparent crack overlay laid over a cracked (not-yet-shattered) pane:
// radial fractures from an off-center impact, a few stress rings, a bright core.
export function glassCracks() {
  const w = 256, h = 256, { c, x } = cv(w, h);
  const ox = w * (0.4 + Math.random() * 0.2), oy = h * (0.4 + Math.random() * 0.2);
  x.lineCap = 'round';
  const spokes = 9 + (Math.random() * 4 | 0);
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2 + Math.random() * 0.3;
    let px = ox, py = oy;
    const len = 40 + Math.random() * 90, steps = 5 + (Math.random() * 4 | 0);
    x.strokeStyle = `rgba(220,235,255,${0.5 + Math.random() * 0.4})`;
    x.lineWidth = 0.8 + Math.random() * 1.4;
    x.beginPath(); x.moveTo(px, py);
    for (let s = 0; s < steps; s++) {
      px += Math.cos(a) * (len / steps) + (Math.random() - 0.5) * 10;
      py += Math.sin(a) * (len / steps) + (Math.random() - 0.5) * 10;
      x.lineTo(px, py);
    }
    x.stroke();
    if (Math.random() < 0.6) { // a branching splinter
      const ba = a + (Math.random() - 0.5) * 1.4;
      x.beginPath(); x.lineWidth = 0.6; x.moveTo(px, py);
      x.lineTo(px + Math.cos(ba) * 30, py + Math.sin(ba) * 30); x.stroke();
    }
  }
  for (let r = 14; r < 70; r += 12 + Math.random() * 10) { // concentric stress rings
    x.strokeStyle = `rgba(210,230,255,${0.1 + 0.25 * Math.random()})`;
    x.lineWidth = 0.7; x.beginPath();
    for (let a = 0; a <= 6.3; a += 0.3) {
      const rr = r + (Math.random() - 0.5) * 5, xx = ox + Math.cos(a) * rr, yy = oy + Math.sin(a) * rr;
      a === 0 ? x.moveTo(xx, yy) : x.lineTo(xx, yy);
    }
    x.stroke();
  }
  x.fillStyle = 'rgba(255,255,255,0.8)'; x.beginPath(); x.arc(ox, oy, 2.5, 0, 7); x.fill();
  return tex(c, 1, 1);
}
