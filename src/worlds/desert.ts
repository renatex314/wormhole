import * as THREE from 'three';
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
  jitter,
  makeMatrix,
  mixRGB,
  prep,
  smoothstep,
  wormholeCenterFor,
} from '../common';

const MILKY_WAY_NORMAL = new THREE.Vector3(0.35, 0.55, 0.76).normalize();

function cactusGeometry() {
  const green = 0x3d6a3a;
  const cyl = (r: number, h: number) => new THREE.CylinderGeometry(r, r * 1.05, h, 10);
  const cap = (r: number) => new THREE.SphereGeometry(r, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  const parts = [
    cyl(0.38, 5).translate(0, 2.5, 0),
    cap(0.38).translate(0, 5, 0),
    // braço direito
    cyl(0.24, 1.0).rotateZ(Math.PI / 2).translate(0.7, 2.2, 0),
    cyl(0.24, 1.7).translate(1.15, 3.0, 0),
    cap(0.24).translate(1.15, 3.85, 0),
    // braço esquerdo
    cyl(0.22, 0.8).rotateZ(Math.PI / 2).translate(-0.6, 3.0, 0),
    cyl(0.22, 1.2).translate(-0.95, 3.55, 0),
    cap(0.22).translate(-0.95, 4.15, 0),
  ].map((g) => prep(g, green));
  return mergeGeometries(parts)!;
}

function moonTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#e4e2dc';
  ctx.fillRect(0, 0, 256, 256);
  const rnd = mulberry32(7);
  for (let i = 0; i < 70; i++) {
    const r = 4 + Math.pow(rnd(), 2) * 40;
    ctx.fillStyle = `rgba(110,110,120,${0.08 + rnd() * 0.2})`;
    ctx.beginPath();
    ctx.arc(rnd() * 256, rnd() * 256, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function nightSky(moonDir: THREE.Vector3) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uMoonDir: { value: moonDir }, uBand: { value: MILKY_WAY_NORMAL } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uMoonDir;
      uniform vec3 uBand;
      varying vec3 vDir;
      float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float noise(vec3 x) {
        vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 horizon = vec3(0.030, 0.042, 0.075);
        vec3 zenith = vec3(0.002, 0.004, 0.013);
        vec3 col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.45));
        if (h < 0.0) col = horizon * 0.7;
        // Via Láctea
        float bd = dot(d, uBand);
        float band = exp(-bd * bd / 0.018);
        float dust = fbm(d * 6.0);
        float lanes = smoothstep(0.35, 0.65, fbm(d * 11.0 + 3.0));
        col += band * (0.015 + 0.05 * dust) * mix(1.0, 0.35, lanes * exp(-bd * bd / 0.004)) * vec3(0.75, 0.75, 1.0) * smoothstep(-0.05, 0.2, h);
        // brilho em volta da lua
        float md = max(dot(d, uMoonDir), 0.0);
        col += vec3(0.25, 0.32, 0.45) * pow(md, 600.0) * 2.0 + vec3(0.06, 0.08, 0.12) * pow(md, 12.0);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(4500, 64, 32), mat);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  return mesh;
}

function stars(rnd: () => number) {
  const count = 9000;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  const v = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    v.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
    if (v.lengthSq() > 1 || v.lengthSq() < 1e-4) {
      i--;
      continue;
    }
    v.normalize();
    // um terço das estrelas se concentra na faixa da Via Láctea
    if (i % 3 === 0) v.addScaledVector(MILKY_WAY_NORMAL, -v.dot(MILKY_WAY_NORMAL) * (0.75 + rnd() * 0.25)).normalize();
    v.multiplyScalar(3800);
    pos.set([v.x, v.y, v.z], i * 3);
    const t = rnd();
    c.setRGB(t < 0.3 ? 0.75 : 1, t < 0.6 ? 0.85 + t * 0.2 : 0.9, t < 0.3 ? 1 : 0.75 + rnd() * 0.25);
    const b = 0.4 + Math.pow(rnd(), 6) * 6;
    col.set([c.r * b, c.g * b, c.b * b], i * 3);
    size[i] = 1.2 + Math.pow(rnd(), 4) * 2.8;
    phase[i] = rnd() * 6.28;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uPixelRatio: { value: Math.min(window.devicePixelRatio, 1.5) } },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aPhase;
      uniform float uTime;
      uniform float uPixelRatio;
      varying vec3 vColor;
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPixelRatio * 1.6;
        float tw = 0.75 + 0.25 * sin(uTime * (1.3 + aPhase * 0.4) + aPhase * 20.0);
        float alt = normalize(position).y;
        vColor = aColor * tw * smoothstep(-0.02, 0.18, alt);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float a = exp(-dot(c, c) * 18.0);
        gl_FragColor = vec4(vColor * a, 1.0);
      }`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  return pts;
}

export function createDesert(): World {
  const scene = new THREE.Scene();
  const n1 = new Simplex2(101);
  const n2 = new Simplex2(202);
  const n3 = new Simplex2(303);
  const n4 = new Simplex2(404);

  // ---------------- Terreno: dunas + mesas no horizonte ----------------
  const mesa = (x: number, z: number) => {
    const r = Math.hypot(x, z) + fbm(n2, x * 0.003, z * 0.003, 3) * 120;
    const m = smoothstep(470, 720, r);
    if (m <= 0) return 0;
    const t = m * 140;
    const step = 26;
    const k = Math.floor(t / step);
    return (k + smoothstep(0.72, 1, t / step - k)) * step;
  };

  const heightFn = (x: number, z: number) => {
    const flat = smoothstep(14, 70, distToTrail(x, z));
    const wx = x + fbm(n1, x * 0.0025, z * 0.0025, 3) * 110;
    const wz = z + fbm(n2, x * 0.0025 + 40, z * 0.0025 - 17, 3) * 110;
    const ridge = 1 - Math.abs(n3.noise(wx * 0.0055, wz * 0.0022));
    const small = 1 - Math.abs(n4.noise(wx * 0.022, wz * 0.01));
    let h = ridge * ridge * ridge * 24 + small * small * 2.2 + fbm(n1, x * 0.0012 + 9, z * 0.0012, 4) * 28;
    h *= flat;
    return h + mesa(x, z);
  };

  const sandA: RGB = [0.84, 0.68, 0.48];
  const sandB: RGB = [0.74, 0.57, 0.39];
  const rockA: RGB = [0.56, 0.31, 0.2];
  const rockB: RGB = [0.68, 0.45, 0.3];

  const colorFn = (x: number, z: number, h: number, ny: number): RGB => {
    let c = mixRGB(sandA, sandB, smoothstep(-0.5, 0.6, fbm(n4, x * 0.01, z * 0.01, 3)));
    const s = 0.9 + 0.1 * n1.noise(x * 0.2, z * 0.2);
    c = [c[0] * s, c[1] * s, c[2] * s];
    if (mesa(x, z) > 2) {
      const band = 0.5 + 0.5 * Math.sin(h * 0.45 + n2.noise(x * 0.01, z * 0.01) * 2);
      const r = mixRGB(rockA, rockB, band);
      c = mixRGB(c, r, smoothstep(0.92, 0.7, ny) + smoothstep(30, 60, h) * 0.5);
    }
    return c;
  };

  const terrain = new Terrain(heightFn, colorFn, new THREE.MeshLambertMaterial({ vertexColors: true }));
  scene.add(terrain.mesh);

  // ---------------- Céu noturno ----------------
  const rnd = mulberry32(4321);
  const moonDir = new THREE.Vector3(-0.32, 0.34, -1).normalize();
  const skyDome = nightSky(moonDir);
  skyDome.userData.sky = true;
  scene.add(skyDome);
  const starField = stars(rnd);
  starField.userData.sky = true;
  scene.add(starField);

  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(70, 32, 16),
    new THREE.MeshBasicMaterial({ map: moonTexture(), color: new THREE.Color(2.4, 2.4, 2.25), fog: false }),
  );
  moon.position.copy(moonDir).multiplyScalar(3000);
  moon.lookAt(0, 0, 0);
  moon.userData.sky = true;
  scene.add(moon);

  scene.fog = new THREE.FogExp2(0x0b1322, 0.0019);

  const moonLight = new THREE.DirectionalLight(0x9db4ff, 2.0);
  scene.add(moonLight, moonLight.target);
  const shadow = new FollowShadow(moonLight, moonDir, 90);
  scene.add(new THREE.HemisphereLight(0x2c4170, 0x2a2016, 0.9));

  // ---------------- Objetos ----------------
  const colliders = new Colliders();
  const nearWormhole = (x: number, z: number, r: number) => Math.hypot(x - WORMHOLE_X, z - WORMHOLE_Z) < r;
  const fire = new THREE.Vector3(6, 0, WORMHOLE_Z - 15);
  fire.y = terrain.heightAt(fire.x, fire.z);
  const nearFire = (x: number, z: number) => Math.hypot(x - fire.x, z - fire.z) < 7;

  const cactusMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const cacti: Instance[] = [];
  for (let i = 0; i < 30000 && cacti.length < 420; i++) {
    const x = (rnd() * 2 - 1) * 520;
    const z = (rnd() * 2 - 1) * 520;
    if (distToTrail(x, z) < 7 || nearWormhole(x, z, 18) || nearFire(x, z) || mesa(x, z) > 0) continue;
    if (terrain.slopeAt(x, z) > 0.45) continue;
    const s = 0.7 + rnd() * 0.7;
    cacti.push({ m: makeMatrix(x, terrain.heightAt(x, z) - 0.2, z, rnd() * 6.28, s, s * (0.8 + rnd() * 0.5), s), c: new THREE.Color().setRGB(0.8 + rnd() * 0.3, 0.85 + rnd() * 0.3, 0.8 + rnd() * 0.3) });
    colliders.add(x, z, 0.45 * s);
  }
  addInstances(scene, cactusGeometry(), cactusMat, cacti, 160, { cast: true });

  const rockGeo = jitter(prep(new THREE.DodecahedronGeometry(1, 1), 0x7a5a45), 0.4, 5);
  const rockMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const rocks: Instance[] = [];
  for (let i = 0; i < 30000 && rocks.length < 900; i++) {
    const x = (rnd() * 2 - 1) * 650;
    const z = (rnd() * 2 - 1) * 650;
    if (distToTrail(x, z) < 3 || nearWormhole(x, z, 9) || nearFire(x, z)) continue;
    const s = 0.3 + Math.pow(rnd(), 3) * 4;
    const g = 0.7 + rnd() * 0.5;
    rocks.push({ m: makeMatrix(x, terrain.heightAt(x, z) - s * 0.35, z, rnd() * 6.28, s * (0.8 + rnd() * 0.6), s * (0.45 + rnd() * 0.4), s, rnd(), rnd()), c: new THREE.Color(g, g * 0.95, g * 0.9) });
    if (s > 1) colliders.add(x, z, s * 0.8);
  }
  addInstances(scene, rockGeo, rockMat, rocks, 160, { cast: true });

  // Arbustos secos
  const twigs: THREE.BufferGeometry[] = [];
  const tr = mulberry32(9);
  for (let i = 0; i < 9; i++) {
    const g = new THREE.CylinderGeometry(0.015, 0.03, 0.7 + tr() * 0.5, 4).translate(0, 0.35, 0);
    g.rotateZ((tr() - 0.5) * 1.6).rotateY(tr() * 6.28);
    twigs.push(prep(g, 0x6b5238));
  }
  twigs.push(jitter(prep(new THREE.IcosahedronGeometry(0.45, 0).scale(1, 0.6, 1).translate(0, 0.35, 0), 0x6e6a3c), 0.2, 3));
  const brushGeo = mergeGeometries(twigs)!;
  const brushMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  addWind(brushMat, 0.05, 0.8);
  const brush: Instance[] = [];
  for (let i = 0; i < 30000 && brush.length < 2200; i++) {
    const x = (rnd() * 2 - 1) * 600;
    const z = (rnd() * 2 - 1) * 600;
    if (distToTrail(x, z) < 2.5 || nearWormhole(x, z, 8) || nearFire(x, z)) continue;
    const s = 0.6 + rnd() * 1.2;
    brush.push({ m: makeMatrix(x, terrain.heightAt(x, z), z, rnd() * 6.28, s) });
  }
  addInstances(scene, brushGeo, brushMat, brush, 160, { cast: true });

  // ---------------- Fogueira ----------------
  const campfire = new THREE.Group();
  campfire.position.copy(fire);
  scene.add(campfire);
  const logMat = new THREE.MeshLambertMaterial({ color: 0x3a2618 });
  for (let i = 0; i < 5; i++) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 1.3, 7), logMat);
    log.rotation.set(Math.PI / 2 - 0.35, (i / 5) * Math.PI * 2, 0);
    log.position.set(Math.cos((i / 5) * Math.PI * 2) * 0.3, 0.25, -Math.sin((i / 5) * Math.PI * 2) * 0.3);
    log.castShadow = true;
    campfire.add(log);
  }
  const stoneMat = new THREE.MeshLambertMaterial({ color: 0x555049, flatShading: true });
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2;
    const st = new THREE.Mesh(jitter(new THREE.DodecahedronGeometry(0.2, 0), 0.08, i), stoneMat);
    st.position.set(Math.cos(a) * 0.95, 0.08, Math.sin(a) * 0.95);
    st.scale.y = 0.7;
    campfire.add(st);
  }
  const flameMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(4.0, 1.5, 0.35),
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const flames: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.32 - i * 0.05, 1.1 - i * 0.12, 10, 1, true), flameMat);
    f.position.set((i - 1.5) * 0.08, 0.6, ((i % 2) - 0.5) * 0.1);
    campfire.add(f);
    flames.push(f);
  }
  const fireLight = new THREE.PointLight(0xff8840, 60, 0, 2);
  fireLight.position.set(0, 1.0, 0);
  campfire.add(fireLight);
  colliders.add(fire.x, fire.z, 1.1);

  const emberCount = 60;
  const emberPos = new Float32Array(emberCount * 3);
  const emberLife = new Float32Array(emberCount).map(() => rnd());
  const emberGeo = new THREE.BufferGeometry();
  emberGeo.setAttribute('position', new THREE.BufferAttribute(emberPos, 3));
  const embers = new THREE.Points(
    emberGeo,
    new THREE.PointsMaterial({ color: new THREE.Color(4, 1.4, 0.3), size: 0.06, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
  );
  embers.frustumCulled = false;
  campfire.add(embers);

  // ---------------- Buraco de minhoca ilumina a areia com a luz do dia do outro lado ----------------
  const wormholeCenter = wormholeCenterFor(terrain);
  const portalLight = new THREE.PointLight(0xd2e6ff, 22, 0, 2);
  portalLight.position.copy(wormholeCenter);
  scene.add(portalLight);

  const starMat = starField.material as THREE.ShaderMaterial;

  return {
    name: 'Deserto · Noite',
    scene,
    exposure: 1.35,
    wormholeCenter,
    terrain,
    colliders,
    update(time, dt, focus) {
      shadow.update(focus);
      starMat.uniforms.uTime.value = time;
      const flick = 0.75 + 0.15 * Math.sin(time * 13) + 0.1 * Math.sin(time * 31 + 1.3) + 0.08 * Math.sin(time * 7.3);
      fireLight.intensity = 60 * flick;
      flames.forEach((f, i) => {
        f.scale.set(1 + 0.1 * Math.sin(time * 9 + i), 0.85 + 0.3 * Math.abs(Math.sin(time * (6 + i * 1.7) + i)), 1);
        f.rotation.y = time * (1 + i * 0.3);
      });
      for (let i = 0; i < emberCount; i++) {
        emberLife[i] += dt * (0.4 + (i % 7) * 0.05);
        if (emberLife[i] > 1) emberLife[i] -= 1;
        const l = emberLife[i];
        const a = i * 2.39996;
        emberPos[i * 3] = Math.cos(a + time * 0.7) * 0.25 * (0.3 + l);
        emberPos[i * 3 + 1] = 0.4 + l * 3.0;
        emberPos[i * 3 + 2] = Math.sin(a + time * 0.7) * 0.25 * (0.3 + l);
      }
      emberGeo.attributes.position.needsUpdate = true;
    },
  };
}
