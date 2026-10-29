import * as THREE from 'three';

// Névoa pela distância radial (e não pela profundidade no plano da câmera): assim as seis
// faces do cubemap capturado no buraco de minhoca têm a mesma névoa e não aparecem emendas.
THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = length(mvPosition.xyz);
#endif`;

// ---------------------------------------------------------------------------
// Constantes compartilhadas pelos dois mundos
// ---------------------------------------------------------------------------

/** Altura dos olhos do jogador. */
export const EYE_HEIGHT = 1.7;
/** Posição (x, z) do buraco de minhoca — a mesma nos dois mundos. */
export const WORMHOLE_X = 0;
export const WORMHOLE_Z = -45;
/** O centro fica na altura dos olhos: entra-se pela "linha do equador" da boca. */
export const WORMHOLE_LIFT = EYE_HEIGHT;

/**
 * Geometria do buraco de minhoca (inspirada no "Dneg" de Interstellar, James et al. 2015):
 *   ds² = -dt² + dℓ² + r(ℓ)² dΩ²
 *   r(ℓ) = ρ                         se |ℓ| ≤ a            (garganta cilíndrica de comprimento 2a)
 *   r'(ℓ) = 3t² − 2t³, t = (|ℓ|−a)/W  na zona de transição  (lente)
 *   r'(ℓ) = 1                        além dela             (espaço exatamente plano)
 * Diferente do Dneg original, a curvatura termina a uma distância finita (ρ + W/2 do centro):
 * assim o resto do mundo rasterizado é o espaço plano verdadeiro, sem "rastro" de lente.
 */
export const wormholeParams = {
  rho: 4,
  length: 0.1,
  width: 0.6,
};

export function wormholeGeom() {
  const { rho, length, width } = wormholeParams;
  const W = Math.max(width, 0.02);
  return { rho, a: length / 2, W, rFlat: rho + W / 2 };
}

/** Raio circunferencial r(ℓ). */
export function radiusAt(l: number): number {
  const { rho, a, W, rFlat } = wormholeGeom();
  const t = (Math.abs(l) - a) / W;
  if (t <= 0) return rho;
  if (t >= 1) return rFlat + (Math.abs(l) - a - W);
  return rho + W * (t * t * t - 0.5 * t * t * t * t);
}

/** Inverso de r(ℓ) no lado ℓ > a: dado o raio (distância ao centro), devolve ℓ. */
export function lengthAt(r: number): number {
  const { rho, a, W, rFlat } = wormholeGeom();
  if (r <= rho) return a;
  if (r >= rFlat) return a + W + (r - rFlat);
  const target = (r - rho) / W;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (mid * mid * mid - 0.5 * mid * mid * mid * mid < target) lo = mid;
    else hi = mid;
  }
  return a + W * (lo + hi) * 0.5;
}

export const WORLD_SIZE = 1600;
export const WORLD_SEGS = 400;
/** Raio máximo que o jogador pode percorrer. */
export const WORLD_LIMIT = 680;

export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Distância até a trilha que liga o ponto inicial ao buraco de minhoca (e segue um pouco além). */
export function distToTrail(x: number, z: number): number {
  const cz = clamp(z, WORMHOLE_Z - 30, 12);
  return Math.hypot(x - WORMHOLE_X, z - cz);
}

export type RGB = [number, number, number];

export const mixRGB = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// ---------------------------------------------------------------------------
// Terreno
// ---------------------------------------------------------------------------

export type HeightFn = (x: number, z: number) => number;
/** Recebe posição, altura e componente Y da normal; devolve a cor em sRGB. */
export type ColorFn = (x: number, z: number, h: number, ny: number) => RGB;

export class Terrain {
  readonly mesh: THREE.Mesh;
  private heights: Float32Array;
  private half = WORLD_SIZE / 2;
  private step = WORLD_SIZE / WORLD_SEGS;

  constructor(heightFn: HeightFn, colorFn: ColorFn, material: THREE.Material) {
    const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, WORLD_SEGS, WORLD_SEGS);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    this.heights = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const h = heightFn(pos.getX(i), pos.getZ(i));
      pos.setY(i, h);
      this.heights[i] = h;
    }
    geo.computeVertexNormals();

    const nrm = geo.attributes.normal as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const [r, g, b] = colorFn(pos.getX(i), pos.getZ(i), pos.getY(i), nrm.getY(i));
      c.setRGB(r, g, b, THREE.SRGBColorSpace);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.receiveShadow = true;
    this.mesh.userData.terrain = true;
  }

  /** Altura exata da malha (mesma triangulação do PlaneGeometry). */
  heightAt(x: number, z: number): number {
    const n = WORLD_SEGS;
    const fx = clamp((x + this.half) / this.step, 0, n - 1e-4);
    const fz = clamp((z + this.half) / this.step, 0, n - 1e-4);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const w = n + 1;
    const ha = this.heights[iz * w + ix];
    const hb = this.heights[(iz + 1) * w + ix];
    const hc = this.heights[(iz + 1) * w + ix + 1];
    const hd = this.heights[iz * w + ix + 1];
    if (tx + tz <= 1) return ha + (hd - ha) * tx + (hb - ha) * tz;
    return hc + (hb - hc) * (1 - tx) + (hd - hc) * (1 - tz);
  }

  slopeAt(x: number, z: number): number {
    const dx = (this.heightAt(x + 1, z) - this.heightAt(x - 1, z)) / 2;
    const dz = (this.heightAt(x, z + 1) - this.heightAt(x, z - 1)) / 2;
    return Math.hypot(dx, dz);
  }
}

// ---------------------------------------------------------------------------
// Colisões simples (troncos, cactos, rochas) num grid espacial
// ---------------------------------------------------------------------------

interface Circle {
  x: number;
  z: number;
  r: number;
}

export class Colliders {
  private cells = new Map<number, Circle[]>();
  private size = 8;

  private key(cx: number, cz: number) {
    return (cx + 1000) * 4096 + (cz + 1000);
  }

  add(x: number, z: number, r: number) {
    const k = this.key(Math.floor(x / this.size), Math.floor(z / this.size));
    let list = this.cells.get(k);
    if (!list) this.cells.set(k, (list = []));
    list.push({ x, z, r });
  }

  /** Empurra `pos` para fora de qualquer círculo que ele esteja invadindo. */
  resolve(pos: THREE.Vector3, radius: number) {
    const cx = Math.floor(pos.x / this.size);
    const cz = Math.floor(pos.z / this.size);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const list = this.cells.get(this.key(cx + i, cz + j));
        if (!list) continue;
        for (const c of list) {
          const dx = pos.x - c.x;
          const dz = pos.z - c.z;
          const min = c.r + radius;
          const d2 = dx * dx + dz * dz;
          if (d2 < min * min && d2 > 1e-8) {
            const d = Math.sqrt(d2);
            pos.x = c.x + (dx / d) * min;
            pos.z = c.z + (dz / d) * min;
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Interface dos mundos
// ---------------------------------------------------------------------------

export interface World {
  name: string;
  scene: THREE.Scene;
  exposure: number;
  wormholeCenter: THREE.Vector3;
  terrain: Terrain;
  colliders: Colliders;
  update(time: number, dt: number, focus: THREE.Vector3): void;
}

export function wormholeCenterFor(terrain: Terrain) {
  return new THREE.Vector3(WORMHOLE_X, terrain.heightAt(WORMHOLE_X, WORMHOLE_Z) + WORMHOLE_LIFT, WORMHOLE_Z);
}

// ---------------------------------------------------------------------------
// Luz direcional com sombra que acompanha o jogador
// ---------------------------------------------------------------------------

export class FollowShadow {
  private texel: number;

  constructor(
    readonly light: THREE.DirectionalLight,
    readonly dir: THREE.Vector3,
    private extent = 90,
    mapSize = 2048,
  ) {
    light.castShadow = true;
    light.shadow.mapSize.set(mapSize, mapSize);
    const cam = light.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 1;
    cam.far = 800;
    light.shadow.bias = -0.0004;
    light.shadow.normalBias = 0.6;
    this.texel = (extent * 2) / mapSize;
  }

  update(focus: THREE.Vector3) {
    const s = this.texel * 4;
    const fx = Math.round(focus.x / s) * s;
    const fz = Math.round(focus.z / s) * s;
    this.light.target.position.set(fx, focus.y, fz);
    this.light.position.set(fx, focus.y, fz).addScaledVector(this.dir, 400);
    this.light.target.updateMatrixWorld();
  }

  get size() {
    return this.extent;
  }
}

// ---------------------------------------------------------------------------
// Vento: balança vegetação instanciada no vertex shader
// ---------------------------------------------------------------------------

export const windUniforms = { uTime: { value: 0 } };

export function addWind(material: THREE.Material, strength: number, height: number, normalUp = false) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = windUniforms.uTime;
    // lâminas de grama dupla-face: mantém a normal para cima nos dois lados
    if (normalUp) shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
    shader.vertexShader =
      'uniform float uTime;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        #else
          vec3 ip = vec3(0.0);
        #endif
        float sw = sin(uTime * 1.6 + ip.x * 0.13 + ip.z * 0.09) + 0.45 * sin(uTime * 3.1 + ip.z * 0.31 + ip.x * 0.17);
        float hf = max(position.y, 0.0) / ${height.toFixed(3)};
        hf *= hf;
        transformed.x += sw * ${strength.toFixed(3)} * hf;
        transformed.z += sw * ${(strength * 0.6).toFixed(3)} * hf;`,
      );
  };
}

// ---------------------------------------------------------------------------
// Utilitários de geometria
// ---------------------------------------------------------------------------

/** Converte para não-indexada e aplica uma cor de vértice uniforme. */
export function prep(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

const hash3 = (x: number, y: number, z: number, s: number) => {
  const v = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + s * 4.581) * 43758.5453;
  return v - Math.floor(v);
};

/** Desloca vértices de forma coerente (vértices iguais recebem o mesmo deslocamento). */
export function jitter(geo: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = Math.round(pos.getX(i) * 1000) / 1000;
    const y = Math.round(pos.getY(i) * 1000) / 1000;
    const z = Math.round(pos.getZ(i) * 1000) / 1000;
    pos.setXYZ(
      i,
      x + (hash3(x, y, z, seed) - 0.5) * amount,
      y + (hash3(y, z, x, seed + 1) - 0.5) * amount,
      z + (hash3(z, x, y, seed + 2) - 0.5) * amount,
    );
  }
  geo.computeVertexNormals();
  return geo;
}

export interface Instance {
  m: THREE.Matrix4;
  c?: THREE.Color;
}

/**
 * Distribui instâncias em blocos espaciais (InstancedMesh por bloco)
 * para que o frustum culling funcione em mundos grandes.
 */
export function addInstances(
  scene: THREE.Scene,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  items: Instance[],
  chunk: number,
  opts: { cast?: boolean; receive?: boolean } = {},
): THREE.InstancedMesh[] {
  const buckets = new Map<string, Instance[]>();
  const p = new THREE.Vector3();
  for (const it of items) {
    p.setFromMatrixPosition(it.m);
    const k = `${Math.floor(p.x / chunk)},${Math.floor(p.z / chunk)}`;
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(it);
  }
  const meshes: THREE.InstancedMesh[] = [];
  for (const list of buckets.values()) {
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((it, i) => {
      mesh.setMatrixAt(i, it.m);
      if (it.c) mesh.setColorAt(i, it.c);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = !!opts.cast;
    mesh.receiveShadow = opts.receive ?? true;
    scene.add(mesh);
    meshes.push(mesh);
  }
  return meshes;
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

export function makeMatrix(x: number, y: number, z: number, rotY: number, sx: number, sy = sx, sz = sx, tiltX = 0, tiltZ = 0) {
  _e.set(tiltX, rotY, tiltZ);
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

/** Tufo de grama: várias lâminas triangulares com gradiente de cor e normal para cima. */
export function grassClump(rnd: () => number, base: THREE.ColorRepresentation, tip: THREE.ColorRepresentation, blades = 7) {
  const pos: number[] = [];
  const col: number[] = [];
  const nrm: number[] = [];
  const cb = new THREE.Color(base);
  const ct = new THREE.Color(tip);
  for (let b = 0; b < blades; b++) {
    const a = rnd() * Math.PI * 2;
    const r = rnd() * 0.3;
    const ox = Math.cos(a) * r;
    const oz = Math.sin(a) * r;
    const ang = rnd() * Math.PI;
    const px = Math.cos(ang) * 0.045;
    const pz = Math.sin(ang) * 0.045;
    const h = 0.35 + rnd() * 0.5;
    const lean = (rnd() - 0.5) * 0.35;
    pos.push(ox - px, 0, oz - pz, ox + px, 0, oz + pz, ox + Math.cos(a) * lean, h, oz + Math.sin(a) * lean);
    const tipC = ct.clone().multiplyScalar(0.85 + rnd() * 0.3);
    col.push(cb.r, cb.g, cb.b, cb.r, cb.g, cb.b, tipC.r, tipC.g, tipC.b);
    for (let k = 0; k < 3; k++) nrm.push(0, 1, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}
