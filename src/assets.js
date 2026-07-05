// Central material + palette cache. Call initAssets() once after THREE + textures ready.
import * as THREE from 'three';
import * as T from './textures.js';

export const MAT = {};
export const TEX = {};

// The one exception to "everything is procedural": Chaim Barer's face is a set of
// photographic billboards (default / winding-up / mid-attack). Loaded from disk in
// initAssets(); the encounter first appears at hall 15, far enough in that the images
// are long since decoded by the time they're needed.
export const BARER = { def: null, atk1: null, atk2: null, aspect: 287 / 388 };

function std(opts) { return new THREE.MeshStandardMaterial(opts); }

export function initAssets() {
  // ---- textures
  TEX.floor = T.woodFloor();
  TEX.panel = T.woodPanel();
  TEX.wallWarm = T.plaster([224, 208, 172]);
  TEX.wallCool = T.plaster([206, 202, 190]);
  TEX.wallOld = T.plaster([196, 176, 138]);
  TEX.carpet = T.carpet();
  TEX.stone = T.stone();
  TEX.books = T.books();
  TEX.ceiling = T.ceilingTex();
  TEX.parchment = T.parchment();
  TEX.shekelFace = T.shekelFace();

  // ---- surfaces
  MAT.floor = std({ map: TEX.floor, roughness: 0.72, metalness: 0.02 });
  MAT.panel = std({ map: TEX.panel, roughness: 0.6, metalness: 0.04 });
  MAT.wallWarm = std({ map: TEX.wallWarm, roughness: 0.94 });
  MAT.wallCool = std({ map: TEX.wallCool, roughness: 0.95 });
  MAT.wallOld = std({ map: TEX.wallOld, roughness: 0.96 });
  MAT.carpet = std({ map: TEX.carpet, roughness: 0.97 });
  MAT.stone = std({ map: TEX.stone, roughness: 0.9 });
  MAT.books = std({ map: TEX.books, roughness: 0.85 });
  MAT.ceiling = std({ map: TEX.ceiling, roughness: 0.9 });
  MAT.parchment = std({ map: TEX.parchment, roughness: 0.9, side: THREE.DoubleSide });

  // ---- solid material helpers (furniture, characters)
  MAT.woodDark = std({ color: 0x2c1a0d, roughness: 0.55, metalness: 0.05 });
  MAT.woodMid = std({ color: 0x4a2f18, roughness: 0.6 });
  MAT.woodRed = std({ color: 0x5a2718, roughness: 0.55 });
  MAT.brass = std({ color: 0xb9902f, roughness: 0.32, metalness: 0.85 });
  MAT.brassDark = std({ color: 0x6a5018, roughness: 0.5, metalness: 0.7 });
  MAT.iron = std({ color: 0x2a2a2e, roughness: 0.5, metalness: 0.6 });
  MAT.velvet = std({ color: 0x5a1420, roughness: 0.9 });
  MAT.velvetBlue = std({ color: 0x172a52, roughness: 0.9 });
  MAT.white = std({ color: 0xe8e4d6, roughness: 0.85 });
  MAT.cream = std({ color: 0xd8caa6, roughness: 0.9 });
  MAT.gold = std({ color: 0xd8b44a, roughness: 0.3, metalness: 0.8, emissive: 0x2a1e06, emissiveIntensity: 0.4 });
  MAT.paper = std({ color: 0xcdbb92, roughness: 0.95 });

  // glowing bits (candles / bulbs) — emissive so they read without post-processing
  MAT.flame = new THREE.MeshBasicMaterial({ color: 0xffcf72 });
  MAT.flameCore = new THREE.MeshBasicMaterial({ color: 0xfff2c0 });
  MAT.wax = std({ color: 0xe6dcc0, roughness: 0.7, emissive: 0x3a2c10, emissiveIntensity: 0.2 });
  MAT.bulb = new THREE.MeshStandardMaterial({ color: 0xffdf9a, emissive: 0xffcf72, emissiveIntensity: 1.6, roughness: 0.4 });

  // ---- character materials (shared, but skin/coat vary per-enemy via clones)
  MAT.black = std({ color: 0x0e0e12, roughness: 0.72 });
  MAT.blackHat = std({ color: 0x090909, roughness: 0.55 });
  MAT.shirtWhite = std({ color: 0xe6e2d4, roughness: 0.8 });
  MAT.skin = std({ color: 0xc79a74, roughness: 0.72 });
  MAT.beard = std({ color: 0x2a1c10, roughness: 0.9 });
  MAT.beardGray = std({ color: 0x8a8073, roughness: 0.9 });
  // shared trim for the two later-game archetypes: the Bulvan's fur shtreimel and the
  // Mekubal's draped tallis (cream cloth with dark stripes). Shared MAT.* — cloned per
  // enemy only for the flashed coat/skin/beard, so these are never disposed per-enemy.
  MAT.fur = std({ color: 0x35271a, roughness: 1.0 });
  MAT.tallis = std({ color: 0xeae3cf, roughness: 0.86 });
  MAT.talStripe = std({ color: 0x181820, roughness: 0.78 });

  // fists (player view-model)
  MAT.knuckle = std({ color: 0xc79a74, roughness: 0.68 });
  MAT.sleeve = std({ color: 0xe6e2d4, roughness: 0.8 });
  MAT.sleeveBlack = std({ color: 0x14140f, roughness: 0.7 });

  // pickups
  MAT.kugel = std({ color: 0xcaa03a, roughness: 0.75, emissive: 0x3a2a08, emissiveIntensity: 0.35 });
  MAT.plate = std({ color: 0xd8d4c8, roughness: 0.3, metalness: 0.4 });
  // the shekel — a bright, minted gold coin. Faintly emissive so it catches the eye as it
  // bounces off a fallen boss or skitters across the floor when tossed as a lure. The flat
  // faces carry a struck Hebrew shin (see shekelFace); the edge is plain reeded gold.
  MAT.shekel = std({ color: 0xe8c84e, roughness: 0.32, metalness: 0.9, emissive: 0x4a3808, emissiveIntensity: 0.45 });
  MAT.shekelFace = std({ map: TEX.shekelFace, roughness: 0.3, metalness: 0.9, emissive: 0x2a2006, emissiveIntensity: 0.4 });
  MAT.shekelEdge = std({ color: 0xc7a338, roughness: 0.38, metalness: 0.88, emissive: 0x2a2006, emissiveIntensity: 0.35 });

  // ---- Chaim Barer face billboards (async; ready well before hall 15)
  const loader = new THREE.TextureLoader();
  const loadFace = (file) => {
    const t = loader.load(`./assets/${file}`);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  };
  BARER.def = loadFace('barer-default.png');
  BARER.atk1 = loadFace('barer-attack1.png');
  BARER.atk2 = loadFace('barer-attack2.png');
}

// Character palettes chosen per enemy archetype.
export const COAT_COLORS = [0x0e0e12, 0x14140f, 0x1a1512, 0x101018, 0x0d1210];
export const SKIN_TONES = [0xc79a74, 0xd8ac86, 0xba895f, 0xc99c72, 0xdcb891];
export const BEARD_TONES = [0x2a1c10, 0x3a2818, 0x1a1108, 0x4a3520, 0x6a5a4a, 0x8a8073];
