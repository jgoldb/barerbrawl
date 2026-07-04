// Jointed low-poly characters built from primitives, plus the FPS fists view-model.
import * as THREE from 'three';
import { MAT } from './assets.js';

function box(w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true; m.receiveShadow = true; return m;
}
function cyl(rt, rb, h, mat, seg = 8) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.castShadow = true; m.receiveShadow = true; return m;
}
function sph(r, mat, seg = 10) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg, seg), mat);
  m.castShadow = true; m.receiveShadow = true; return m;
}
function cap(r, len, mat, radial = 10, capSeg = 6) {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, capSeg, radial), mat);
  m.castShadow = true; m.receiveShadow = true; return m;
}

// opts: {coat, skin, beard, hat:'fedora'|'homburg'|'big'|'none', bigBeard, glasses}
export function buildCharacter(opts = {}) {
  const coatMat = MAT.black.clone(); coatMat.color.setHex(opts.coat ?? 0x0e0e12);
  const skinMat = MAT.skin.clone(); skinMat.color.setHex(opts.skin ?? 0xc79a74);
  const beardMat = MAT.beard.clone(); beardMat.color.setHex(opts.beard ?? 0x2a1c10);
  const shirt = MAT.shirtWhite, hatMat = MAT.blackHat;

  const root = new THREE.Group();
  const joints = {};

  // ---- pelvis / hips
  const hips = new THREE.Group(); hips.position.y = 0.82; root.add(hips); joints.hips = hips;
  const pelvis = box(0.42, 0.26, 0.28, coatMat); pelvis.position.y = 0; hips.add(pelvis);

  // ---- torso (coat)
  const torso = new THREE.Group(); torso.position.y = 0.13; hips.add(torso); joints.torso = torso;
  const chest = box(0.5, 0.6, 0.32, coatMat); chest.position.y = 0.3; torso.add(chest);
  // flared lower coat (kapote)
  const coatSkirt = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.42, 0.62, 10), coatMat);
  coatSkirt.position.y = -0.18; coatSkirt.castShadow = true; torso.add(coatSkirt);
  // white shirt collar / tzitzis hint
  const collar = box(0.2, 0.16, 0.2, shirt); collar.position.y = 0.55; torso.add(collar);
  const lapelL = box(0.06, 0.5, 0.02, shirt); lapelL.position.set(-0.06, 0.34, 0.17); lapelL.rotation.z = 0.12; torso.add(lapelL);
  const lapelR = lapelL.clone(); lapelR.position.x = 0.06; lapelR.rotation.z = -0.12; torso.add(lapelR);

  // ---- head
  const neck = new THREE.Group(); neck.position.y = 0.62; torso.add(neck); joints.head = neck;
  const head = sph(0.19, skinMat); head.scale.set(1, 1.12, 1.02); head.position.y = 0.12; neck.add(head);
  // eyes
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x1a1410, roughness: 0.4 });
  for (const sx of [-0.07, 0.07]) {
    const e = sph(0.028, eyeMat, 8); e.position.set(sx, 0.14, 0.16); neck.add(e);
    // angry brow
    const brow = box(0.09, 0.02, 0.03, beardMat); brow.position.set(sx, 0.2, 0.16);
    brow.rotation.z = sx < 0 ? -0.4 : 0.4; neck.add(brow);
  }
  // nose
  const nose = box(0.04, 0.06, 0.05, skinMat); nose.position.set(0, 0.1, 0.19); neck.add(nose);
  // beard
  const bigB = opts.bigBeard;
  const beard = new THREE.Mesh(new THREE.ConeGeometry(bigB ? 0.19 : 0.15, bigB ? 0.34 : 0.24, 10), beardMat);
  beard.position.set(0, bigB ? -0.02 : 0.0, 0.06); beard.scale.z = 0.7; neck.add(beard);
  // moustache
  const mous = box(0.14, 0.03, 0.04, beardMat); mous.position.set(0, 0.05, 0.16); neck.add(mous);
  // peyos (side curls)
  for (const sx of [-0.16, 0.16]) {
    const p = cyl(0.02, 0.025, 0.22, beardMat, 5); p.position.set(sx, 0.06, 0.06); neck.add(p);
  }
  // glasses (optional, for the studious ones)
  if (opts.glasses) {
    const gm = new THREE.MeshStandardMaterial({ color: 0x111, roughness: 0.3, metalness: 0.4 });
    for (const sx of [-0.07, 0.07]) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.008, 6, 12), gm);
      r.position.set(sx, 0.14, 0.18); neck.add(r);
    }
  }
  // ---- hat
  if (opts.hat !== 'none') {
    const brimR = opts.hat === 'big' ? 0.34 : 0.28;
    const crownH = opts.hat === 'homburg' ? 0.24 : 0.2;
    const brim = cyl(brimR, brimR, 0.03, hatMat, 18); brim.position.y = 0.24; neck.add(brim);
    const crown = cyl(0.17, 0.19, crownH, hatMat, 16); crown.position.y = 0.24 + crownH / 2; neck.add(crown);
    const band = cyl(0.172, 0.192, 0.05, MAT.woodDark, 16); band.position.y = 0.28; neck.add(band);
    const topc = cyl(0.16, 0.17, 0.02, hatMat, 16); topc.position.y = 0.24 + crownH; neck.add(topc);
  }

  // ---- arms
  function makeArm(side) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.3, 0.5, 0); torso.add(shoulder);
    const upper = cyl(0.075, 0.07, 0.34, coatMat, 7); upper.position.y = -0.17; shoulder.add(upper);
    const elbow = new THREE.Group(); elbow.position.y = -0.34; shoulder.add(elbow);
    const fore = cyl(0.06, 0.055, 0.32, coatMat, 7); fore.position.y = -0.16; elbow.add(fore);
    // white cuff + hand
    const cuff = cyl(0.062, 0.062, 0.05, shirt, 7); cuff.position.y = -0.3; elbow.add(cuff);
    const hand = sph(0.075, skinMat, 8); hand.position.y = -0.35; elbow.add(hand);
    return { shoulder, elbow, hand };
  }
  const armL = makeArm(-1), armR = makeArm(1);
  joints.shoulderL = armL.shoulder; joints.elbowL = armL.elbow; joints.handL = armL.hand;
  joints.shoulderR = armR.shoulder; joints.elbowR = armR.elbow; joints.handR = armR.hand;
  // rest pose: arms slightly down/in
  armL.shoulder.rotation.z = 0.18; armR.shoulder.rotation.z = -0.18;

  // ---- legs (black trousers)
  function makeLeg(side) {
    const thigh = new THREE.Group(); thigh.position.set(side * 0.13, -0.02, 0); hips.add(thigh);
    const upper = cyl(0.09, 0.08, 0.44, coatMat, 7); upper.position.y = -0.22; thigh.add(upper);
    const knee = new THREE.Group(); knee.position.y = -0.44; thigh.add(knee);
    const shin = cyl(0.075, 0.065, 0.4, coatMat, 7); shin.position.y = -0.2; knee.add(shin);
    const shoe = box(0.13, 0.09, 0.26, MAT.woodDark); shoe.position.set(0, -0.42, 0.05); knee.add(shoe);
    return { thigh, knee };
  }
  const legL = makeLeg(-1), legR = makeLeg(1);
  joints.thighL = legL.thigh; joints.kneeL = legL.knee;
  joints.thighR = legR.thigh; joints.kneeR = legR.knee;

  root.userData.joints = joints;
  root.userData.height = 1.75;
  root.userData.mats = { coat: coatMat, skin: skinMat, beard: beardMat };
  return { root, joints };
}

// ------------------------------------------------------------------ FPS fists
// Returns a group meant to live in a separate view-scene attached to the camera.
export function buildFists() {
  const root = new THREE.Group();

  // Local frame: forward (punch direction) = -Z, up = +Y. The fist sits at the front
  // (-Z), the forearm runs back toward the viewer (+Z). Built from capsules/spheres
  // for a rounded, higher-fidelity clenched fist.
  function makeFist(side) {
    const skin = MAT.knuckle, sleeveMat = MAT.sleeve;
    const arm = new THREE.Group();

    // ---- forearm: rolled white sleeve, smooth & tapered ----
    const sleeve = cyl(0.1, 0.072, 0.52, sleeveMat, 20);
    sleeve.rotation.x = Math.PI / 2; sleeve.position.set(0, -0.005, 0.18);
    arm.add(sleeve);
    const elbowCap = sph(0.1, sleeveMat, 16); elbowCap.scale.set(1, 1, 0.85); elbowCap.position.set(0, -0.005, 0.43); arm.add(elbowCap);
    // rolled cuff (two overlapping rings)
    const cuff = cyl(0.11, 0.108, 0.07, sleeveMat, 20); cuff.rotation.x = Math.PI / 2; cuff.position.set(0, -0.005, -0.03); arm.add(cuff);
    const cuff2 = cyl(0.106, 0.104, 0.05, sleeveMat, 20); cuff2.rotation.x = Math.PI / 2; cuff2.position.set(0, -0.005, 0.05); arm.add(cuff2);

    // ---- wrist ----
    const wrist = cap(0.07, 0.05, skin, 14); wrist.rotation.x = Math.PI / 2; wrist.position.set(0, -0.01, -0.1); arm.add(wrist);

    // ---- hand group (posed/positioned as a unit) ----
    const hand = new THREE.Group(); hand.position.set(0, 0, -0.2); arm.add(hand);
    // back-of-hand (metacarpal) mass + palm fill
    const backHand = sph(0.098, skin, 18); backHand.scale.set(0.94, 0.64, 1.02); backHand.position.set(0, 0.012, 0.015); hand.add(backHand);
    const palm = sph(0.09, skin, 16); palm.scale.set(0.88, 0.72, 0.96); palm.position.set(0, -0.032, -0.005); hand.add(palm);

    // ---- four curled fingers (knuckle + folded finger + tucked tip) ----
    const fx = [-0.057, -0.019, 0.019, 0.057];
    const knH = [0.05, 0.06, 0.056, 0.044];
    const fLen = [0.055, 0.072, 0.066, 0.05];
    for (let i = 0; i < 4; i++) {
      const x = fx[i];
      const kn = sph(0.031, skin, 12); kn.scale.set(1.06, 0.96, 1.06);
      kn.position.set(x, knH[i] - 0.018, -0.078); hand.add(kn);
      const fg = cap(0.026, fLen[i], skin, 12);
      fg.position.set(x, (knH[i] - 0.018) - fLen[i] * 0.5 - 0.02, -0.098);
      fg.rotation.x = 0.26; hand.add(fg);
      const tip = sph(0.024, skin, 10);
      tip.position.set(x, -0.058, -0.052); hand.add(tip);
    }

    // ---- thumb wrapping across the inner-front, over the fingers ----
    const thumbBase = cap(0.033, 0.045, skin, 12);
    thumbBase.position.set(-side * 0.078, 0.0, -0.01);
    thumbBase.rotation.set(0.1, 0, side * 1.05); hand.add(thumbBase);
    const thumbMid = cap(0.03, 0.05, skin, 12);
    thumbMid.position.set(-side * 0.03, -0.018, -0.07);
    thumbMid.rotation.set(1.15, side * 0.5, side * 0.35); hand.add(thumbMid);
    const thumbTip = sph(0.028, skin, 10); thumbTip.position.set(-side * 0.004, -0.03, -0.1); hand.add(thumbTip);

    // ---- rest pose: low in view, forearm rising from below, angled inward ----
    arm.position.set(side * 0.28, -0.33, -0.5);
    arm.rotation.set(0.34, side * -0.16, side * 0.12);
    return arm;
  }
  const left = makeFist(-1);
  const right = makeFist(1);
  root.add(left); root.add(right);
  return { root, left, right };
}
