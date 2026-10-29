import * as THREE from 'three';
import { windUniforms, type World } from './common';

/*
 * "Matéria exótica": disco de energia sob a boca do buraco de minhoca (no modelo de
 * Morris–Thorne a garganta só fica aberta com energia negativa). É um objeto real da cena,
 * então aparece igual na imagem rasterizada, nas capturas de cubemap e nos raios curvos
 * que atravessam a garganta.
 */

const vertexShader = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

/** Padrão de energia (cor HDR) num ponto do chão; q = posição relativa ao centro (xz). */
export const exoticGLSL = /* glsl */ `
  float exHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float exNoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(exHash(i), exHash(i + vec2(1, 0)), f.x), mix(exHash(i + vec2(0, 1)), exHash(i + vec2(1, 1)), f.x), f.y);
  }
  float exFbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { s += a * exNoise(p); p = p * 2.03 + 17.0; a *= 0.5; }
    return s;
  }
  // radius = círculo onde a boca toca o chão; a energia se espalha para fora até ~2.2x
  // (o chão dentro desse círculo fica dentro da boca: não existe no espaço do buraco)
  // detail = 1: padrão completo. Onde a lente estica muito o chão (detail → 0), os filamentos
  // finos virariam riscos; ficam só o brilho suave e a cor variando ao redor da boca.
  vec3 exoticColor(vec2 q, float radius, float t, float detail) {
    float r = length(q) / radius;
    if (r > 2.2) return vec3(0.0);
    // redemoinho: gira mais rápido perto do centro
    float ang = t * 0.35 + 1.6 / (r + 0.35);
    vec2 p = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * q;
    float n = exFbm(p * 0.9 + vec2(0.0, -t * 0.25));
    float m = exFbm(p * 2.1 - vec2(t * 0.4, 0.0) + n * 2.0);
    // filamentos finos de energia
    float fil = pow(1.0 - abs(sin((n + 0.5 * m) * 9.0 - t * 1.3)), 10.0);
    // pulsos radiais saindo do centro
    float pulse = pow(0.5 + 0.5 * sin(r * 9.0 - t * 3.0), 6.0);
    vec3 cyan = vec3(0.15, 0.75, 1.6);
    vec3 violet = vec3(0.95, 0.35, 1.7);
    vec3 col = mix(cyan, violet, smoothstep(0.35, 0.75, m));
    float energy = 0.08 + 0.35 * n * n + 1.6 * fil + 0.5 * pulse;
    if (detail < 1.0) {
      float a = atan(q.y, q.x);
      float g = exFbm(vec2(a * 2.5 + t * 0.15, t * 0.2));
      vec3 gcol = mix(cyan, violet, g);
      col = mix(gcol, col, detail);
      energy = mix(0.25 + 0.35 * g, energy, detail);
    }
    // anel fino no limite da garganta e halo curto para fora
    float ring = exp(-pow((r - 1.0) * 22.0, 2.0)) * (0.6 + 0.2 * sin(t * 2.0 + atan(q.y, q.x) * 6.0));
    // corpo: forte junto à boca, apagando para fora
    float body = smoothstep(2.2, 1.0, r);
    body *= body;
    return col * energy * body + mix(cyan, vec3(1.4, 1.2, 2.0), 0.5) * ring;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uCenter;
  uniform float uRadius;
  uniform float uIntensity;
  varying vec3 vWorld;
  ${exoticGLSL}
  void main() {
    gl_FragColor = vec4(exoticColor(vWorld.xz - uCenter.xz, uRadius, uTime, 1.0) * uIntensity, 1.0);
  }`;

export function addExoticFloor(world: World, radius: number, intensity: number, lightIntensity: number) {
  const c = world.wormholeCenter;
  const groundY = world.terrain.heightAt(c.x, c.z);
  const mat = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    uniforms: {
      uTime: windUniforms.uTime,
      uCenter: { value: c.clone() },
      uRadius: { value: radius },
      uIntensity: { value: intensity },
    },
  });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(radius * 2.25, 160).rotateX(-Math.PI / 2), mat);
  disc.position.set(c.x, groundY + 0.03, c.z);
  disc.renderOrder = 1;
  world.scene.add(disc);

  // a energia ilumina o chão em volta
  const light = new THREE.PointLight(0x7f8cff, lightIntensity, 0, 2);
  light.position.set(c.x, groundY + 0.6, c.z);
  world.scene.add(light);

  // o traçado dentro da garganta recalcula o padrão no ponto exato do chão (ver wormhole.ts)
  world.scene.userData.exotic = { material: mat, radius };
  return { disc, material: mat, light };
}
