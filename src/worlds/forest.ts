import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Simplex2, fbm, mulberry32 } from '../noise';
import {
  type Instance,
  type RGB,
  type World,
  Colliders,
  FollowShadow,
  Terrain,
  WORMHOLE_X,
  WORMHOLE_Z,
  addInstances,
  addWind,
  distToTrail,
  grassClump,
  jitter,
  makeMatrix,
  mixRGB,
  prep,
  smoothstep,
  wormholeCenterFor,
} from '../common';

function pineGeometry() {
  const parts = [prep(new THREE.CylinderGeometry(0.22, 0.38, 4, 7).translate(0, 2, 0), 0x5a3d26)];
  const layers: [number, number, number][] = [
    [2.9, 4.2, 4.2],
    [2.3, 3.8, 6.5],
    [1.7, 3.3, 8.6],
    [1.0, 2.6, 10.6],
  ];
  layers.forEach(([r, h, y], i) => {
    parts.push(jitter(prep(new THREE.ConeGeometry(r, h, 9, 2).translate(0, y, 0), i % 2 ? 0x2b5527 : 0x2f5d2b), 0.35, i));
  });
  return mergeGeometries(parts)!;
}

function broadleafGeometry() {
  const parts = [prep(new THREE.CylinderGeometry(0.28, 0.45, 5, 7).translate(0, 2.5, 0), 0x6b4a2f)];
  const blobs: [number, number, number, number, number][] = [
    [2.7, 0, 6.6, 0, 0x3f7a2c],
    [2.0, 1.4, 5.4, 0.7, 0x467f30],
    [1.9, -1.2, 5.8, -0.9, 0x3a7029],
    [1.6, 0.3, 8.0, -0.4, 0x4b8634],
  ];
  blobs.forEach(([r, x, y, z, c], i) => {
    parts.push(jitter(prep(new THREE.IcosahedronGeometry(r, 1).translate(x, y, z), c), 0.55, 10 + i));
  });
  return mergeGeometries(parts)!;
}

export function createForest(): World {
  const scene = new THREE.Scene();
  const n1 = new Simplex2(11);
  const n2 = new Simplex2(23);
  const n3 = new Simplex2(37);
  const n4 = new Simplex2(51);

  // ---------------- Terreno ----------------
  const heightFn = (x: number, z: number) => {
    const flat = smoothstep(14, 60, distToTrail(x, z));
    let h = fbm(n1, x * 0.0022, z * 0.0022, 5) * 34 + fbm(n2, x * 0.011, z * 0.011, 3) * 4.5;
    h += Math.pow(Math.max(0, fbm(n3, x * 0.0014 + 3.1, z * 0.0014 - 7.2, 4)), 1.6) * 70;
    h *= flat;
    const r = Math.hypot(x, z);
    const m = smoothstep(480, 790, r);
    h += m * m * (160 + fbm(n4, x * 0.004, z * 0.004, 5) * 90);
    return h;
  };

  const grassA: RGB = [0.29, 0.43, 0.14];
  const grassB: RGB = [0.4, 0.5, 0.17];
  const dry: RGB = [0.5, 0.5, 0.24];
  const dirt: RGB = [0.45, 0.35, 0.22];
  const rock: RGB = [0.44, 0.43, 0.4];
  const snow: RGB = [0.93, 0.95, 1.0];

  const colorFn = (x: number, z: number, h: number, ny: number): RGB => {
    let c = mixRGB(grassA, grassB, smoothstep(-0.4, 0.5, fbm(n2, x * 0.02, z * 0.02, 3)));
    c = mixRGB(c, dry, smoothstep(0.3, 0.8, fbm(n3, x * 0.008, z * 0.008, 2)) * 0.6);
    const shade = 0.85 + 0.15 * n4.noise(x * 0.15, z * 0.15);
    c = [c[0] * shade, c[1] * shade, c[2] * shade];
    const trail = 1 - smoothstep(1.8, 3.2 + n1.noise(x * 0.3, z * 0.3) * 0.8, distToTrail(x, z));
    c = mixRGB(c, dirt, trail);
    c = mixRGB(c, rock, smoothstep(0.78, 0.65, ny));
    c = mixRGB(c, snow, smoothstep(165, 185, h + n1.noise(x * 0.02, z * 0.02) * 20) * smoothstep(0.55, 0.75, ny));
    return c;
  };

  const terrain = new Terrain(heightFn, colorFn, new THREE.MeshLambertMaterial({ vertexColors: true }));
  scene.add(terrain.mesh);

  // ---------------- Céu, luz e névoa ----------------
  const sunDir = new THREE.Vector3(0.55, 0.62, -0.56).normalize();
  const sky = new Sky();
  sky.scale.setScalar(4500);
  const su = sky.material.uniforms;
  su.turbidity.value = 4.5;
  su.rayleigh.value = 1.1;
  su.mieCoefficient.value = 0.004;
  su.mieDirectionalG.value = 0.82;
  su.sunPosition.value.copy(sunDir);
  sky.userData.sky = true;
  scene.add(sky);

  scene.fog = new THREE.FogExp2(0xa9c4dc, 0.0017);

  const sun = new THREE.DirectionalLight(0xfff0d8, 3.2);
  scene.add(sun, sun.target);
  const shadow = new FollowShadow(sun, sunDir, 90);
  scene.add(new THREE.HemisphereLight(0xbcd6ff, 0x4a5a2a, 1.1));

  // ---------------- Vegetação ----------------
  const colliders = new Colliders();
  const rnd = mulberry32(1234);
  const wormholeClear = (x: number, z: number, r: number) => Math.hypot(x - WORMHOLE_X, z - WORMHOLE_Z) < r;

  const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  addWind(treeMat, 0.25, 11);

  const pines: Instance[] = [];
  const broad: Instance[] = [];
  for (let i = 0; i < 200000 && (pines.length < 4200 || broad.length < 2800); i++) {
    const x = (rnd() * 2 - 1) * 740;
    const z = (rnd() * 2 - 1) * 740;
    if (Math.hypot(x, z) > 760) continue;
    if (distToTrail(x, z) < 9 || wormholeClear(x, z, 24)) continue;
    const h = terrain.heightAt(x, z);
    if (h > 150 || terrain.slopeAt(x, z) > 0.7) continue;
    const dens = fbm(n2, x * 0.006 + 13, z * 0.006, 3);
    if (rnd() > 0.3 + dens * 1.1) continue;
    const isPine = rnd() < 0.45 + smoothstep(10, 90, h) * 0.5;
    const list = isPine ? pines : broad;
    if (list.length >= (isPine ? 4200 : 2800)) continue;
    const s = 0.75 + rnd() * 0.75;
    const tint = new THREE.Color().setRGB(0.8 + rnd() * 0.35, 0.85 + rnd() * 0.3, 0.75 + rnd() * 0.3);
    list.push({ m: makeMatrix(x, h - 0.2, z, rnd() * Math.PI * 2, s, s * (0.85 + rnd() * 0.35), s, (rnd() - 0.5) * 0.08, (rnd() - 0.5) * 0.08), c: tint });
    colliders.add(x, z, 0.45 * s);
  }
  addInstances(scene, pineGeometry(), treeMat, pines, 160, { cast: true });
  addInstances(scene, broadleafGeometry(), treeMat, broad, 160, { cast: true });

  // Arbustos
  const bushGeo = jitter(prep(new THREE.IcosahedronGeometry(1, 1).scale(1.2, 0.8, 1.2).translate(0, 0.45, 0), 0x3b6c2a), 0.3, 99);
  const bushMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  addWind(bushMat, 0.08, 1.2);
  const bushes: Instance[] = [];
  for (let i = 0; i < 40000 && bushes.length < 3000; i++) {
    const x = (rnd() * 2 - 1) * 650;
    const z = (rnd() * 2 - 1) * 650;
    if (distToTrail(x, z) < 4 || wormholeClear(x, z, 9)) continue;
    const h = terrain.heightAt(x, z);
    if (h > 140 || terrain.slopeAt(x, z) > 0.6) continue;
    const s = 0.5 + rnd() * 1.1;
    bushes.push({ m: makeMatrix(x, h, z, rnd() * 6.28, s), c: new THREE.Color().setRGB(0.8 + rnd() * 0.4, 0.85 + rnd() * 0.3, 0.7 + rnd() * 0.3) });
  }
  addInstances(scene, bushGeo, bushMat, bushes, 160, { cast: true });

  // Rochas
  const rockGeo = jitter(prep(new THREE.DodecahedronGeometry(1, 1), 0x8a8780), 0.35, 77);
  const rockMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const rocks: Instance[] = [];
  for (let i = 0; i < 20000 && rocks.length < 900; i++) {
    const x = (rnd() * 2 - 1) * 700;
    const z = (rnd() * 2 - 1) * 700;
    if (distToTrail(x, z) < 3.5 || wormholeClear(x, z, 9)) continue;
    const h = terrain.heightAt(x, z);
    const s = 0.4 + Math.pow(rnd(), 3) * 3;
    const g = 0.75 + rnd() * 0.4;
    rocks.push({ m: makeMatrix(x, h - s * 0.3, z, rnd() * 6.28, s * (0.8 + rnd() * 0.5), s * (0.5 + rnd() * 0.4), s, rnd(), rnd()), c: new THREE.Color(g, g, g * 0.95) });
    if (s > 1) colliders.add(x, z, s * 0.8);
  }
  addInstances(scene, rockGeo, rockMat, rocks, 160, { cast: true });

  // Grama (blocos próximos ao jogador ficam visíveis)
  const grassGeo = grassClump(rnd, 0x1f3a0f, 0x7da13a);
  const grassMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  addWind(grassMat, 0.12, 0.8, true);
  const grass: Instance[] = [];
  for (let i = 0; i < 160000 && grass.length < 65000; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * 320;
    const x = Math.cos(a) * r;
    const z = WORMHOLE_Z * 0.5 + Math.sin(a) * r;
    if (distToTrail(x, z) < 1.6) continue;
    // clareira em volta da boca: vegetação fina colada ao ponto de captura do buraco de
    // minhoca vira rastro quando vista de outro ângulo pela garganta
    if (wormholeClear(x, z, 7 + rnd() * 2)) continue;
    const h = terrain.heightAt(x, z);
    if (terrain.slopeAt(x, z) > 0.55 || h > 130) continue;
    if (fbm(n3, x * 0.03, z * 0.03, 2) < -0.35) continue;
    const s = 0.7 + rnd() * 0.8;
    grass.push({ m: makeMatrix(x, h - 0.05, z, rnd() * 6.28, s, s * (0.8 + rnd() * 0.6), s) });
  }
  const grassMeshes = addInstances(scene, grassGeo, grassMat, grass, 40, { receive: true });
  // no traçado de raios (ver trace.ts) só entra a grama até 120 m da boca
  for (const m of grassMeshes) m.userData.traceRadius = 120;

  // Flores
  const flowerGeo = prep(new THREE.IcosahedronGeometry(0.07, 0).translate(0, 0.32, 0), 0xffffff);
  const flowerMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const palette = [0xffffff, 0xffe15a, 0xb28dff, 0xff7aa8, 0x7fc8ff];
  const flowers: Instance[] = [];
  for (let i = 0; i < 30000 && flowers.length < 5000; i++) {
    const x = (rnd() * 2 - 1) * 260;
    const z = WORMHOLE_Z * 0.5 + (rnd() * 2 - 1) * 260;
    if (distToTrail(x, z) < 2 || wormholeClear(x, z, 7) || fbm(n4, x * 0.02, z * 0.02, 2) < 0.15) continue;
    const s = 0.8 + rnd() * 0.6;
    flowers.push({ m: makeMatrix(x, terrain.heightAt(x, z), z, 0, s), c: new THREE.Color(palette[Math.floor(rnd() * palette.length)]) });
  }
  const flowerMeshes = addInstances(scene, flowerGeo, flowerMat, flowers, 40);
  for (const m of flowerMeshes) m.userData.traceRadius = 120;
  const nearOnly = [...grassMeshes, ...flowerMeshes];

  const wormholeCenter = wormholeCenterFor(terrain);

  return {
    name: 'Floresta · Dia',
    scene,
    exposure: 0.75,
    wormholeCenter,
    terrain,
    colliders,
    update(_time, _dt, focus) {
      shadow.update(focus);
      for (const m of nearOnly) {
        const c = m.boundingSphere!.center;
        m.visible = Math.hypot(c.x - focus.x, c.z - focus.z) < 170;
      }
    },
  };
}
