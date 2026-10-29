import * as THREE from 'three';
import { WORMHOLE_LIFT, windUniforms, type World } from './common';
import { exoticGLSL } from './exotic';

/*
 * Buraco de minhoca por traçado de geodésicas nulas, em tempo real e com custo fixo.
 *
 * Métrica (ver common.ts): ds² = -dt² + dℓ² + r(ℓ)² dΩ², garganta cilíndrica |ℓ| ≤ a,
 * zona de lente de largura W e espaço exatamente plano além de r = ρ + W/2.
 *
 * Para cada pixel cujo raio entra na região curva (a esfera r < ρ + W/2):
 *   1. a geodésica é integrada com RK4 adaptativo só dentro dessa casca
 *      (dℓ/ds = p, dp/ds = b² r'/r³, dφ/ds = b/r²) — é aí que toda a curvatura acontece;
 *   2. ao sair para o espaço plano (deste mundo ou do outro) o raio é reto e é percorrido
 *      contra um cubemap de cor + distância capturado no centro de cada boca. Comparar a
 *      distância do ponto do raio com a distância gravada dá a interseção com a cena com
 *      paralaxe correta, independentemente de quantos triângulos ela tem.
 * Se o ponto atingido pertence a este mundo e a câmera o enxerga diretamente, usa-se o pixel
 * rasterizado (mais nítido). Pixels cujo raio não cruza a região curva são a própria imagem
 * rasterizada: ali o espaço é plano.
 *
 * O outro lado é colado por um espelho no eixo z (o eixo da trilha), preservando a orientação.
 */

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

const traceShader = /* glsl */ `
  #define MAX_STEPS 400
  #define MARCH_STEPS 110
  #define REFINE_STEPS 8
  #define MARCH_FAR 500.0
  #define FOOTPRINT_MAX 0.08
  #define GROUND_FLAT_R 12.0
  #define SKY_DIST 3000.0

  uniform sampler2D tScene;
  uniform sampler2D tDepth;
  uniform samplerCube colS;      // cor vista do centro de cada boca
  uniform samplerCube colO;
  uniform samplerCube distS;     // distância até a superfície, vista do centro de cada boca
  uniform samplerCube distO;
  uniform samplerCube skyS;      // céu (no infinito)
  uniform samplerCube skyO;
  uniform samplerCube groundS;   // só terreno + céu: o que está atrás da vegetação vista do centro
  uniform samplerCube groundO;
  uniform mat4 uInvProj;
  uniform mat4 uCamWorld;
  uniform mat4 uViewProj;
  uniform vec3 uCamPos;
  uniform vec3 uCenterS;
  uniform vec3 uEr;
  uniform float uL;
  uniform float uRho;
  uniform float uA;
  uniform float uW;
  uniform float uRFlat;
  uniform float uGroundY;
  uniform float uTunnel;
  uniform float uSelfScale;
  uniform float uOtherScale;
  uniform vec3 uFogCol;
  uniform float uFogDens;
  uniform vec2 uJitter;
  uniform float uDebug;
  uniform float uTime;
  uniform float uExoticR;
  uniform float uExoticS;    // intensidade da matéria exótica deste mundo / do outro
  uniform float uExoticO;
  varying vec2 vUv;

  ${exoticGLSL}
  #define EXOTIC_EXTENT 2.2

  float sceneDistance(vec2 uv) {
    float d = texture(tDepth, uv).x;
    if (d >= 0.999999) return 1e7;
    vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return length(p.xyz / p.w);
  }

  // ---------------- métrica ----------------

  vec2 rdr(float l) {
    float al = abs(l);
    float t = (al - uA) / uW;
    if (t <= 0.0) return vec2(uRho, 0.0);
    if (t >= 1.0) return vec2(uRFlat + al - uA - uW, sign(l));
    float t2 = t * t;
    return vec2(uRho + uW * (t2 * t - 0.5 * t2 * t2), sign(l) * (3.0 * t2 - 2.0 * t2 * t));
  }

  vec3 deriv(float l, float p, float b2, float b) {
    vec2 r = rdr(l);
    float ir = 1.0 / r.x;
    return vec3(p, b2 * r.y * ir * ir * ir, b * ir * ir);
  }

  // ---------------- cena (cubemap com distância) ----------------

  float envDist(float side, vec3 dir) {
    return side > 0.0 ? textureLod(distS, dir, 0.0).r : textureLod(distO, dir, 0.0).r;
  }

  /*
   * Percorre o raio reto o + t·d (relativo ao centro da boca) contra a superfície gravada.
   * O passo cresce com a distância ao centro (passo angular ~constante visto do centro, que é
   * a resolução do cubemap). Quando o ponto passa da frente para trás da superfície, a
   * travessia é refinada por bisseção; se o ponto final está sobre a superfície é uma
   * interseção, senão o raio só passou por trás de um objeto (silhueta) e continua.
   * O chão perto das bocas é plano (o terreno é achatado ali) e é intersectado
   * analiticamente — sem a quantização do cubemap, que serrilhava a borda da boca no chão.
   * Além de MARCH_FAR a paralaxe em relação ao centro é desprezível: cai no cubemap pela direção.
   */
  bool marchEnv(float side, vec3 o, vec3 d, out vec3 hit) {
    float tg = d.y < -1e-5 ? (uGroundY - o.y) / d.y : 1e9;
    vec3 gp = o + d * tg;
    bool groundOk = tg > 0.0 && length(gp.xz) < GROUND_FLAT_R;
    float tMax = groundOk ? tg : 1e9;

    float t = 0.0;
    float prevT = 0.0;
    bool prevFront = true;
    hit = d * 1e4;
    for (int i = 0; i < MARCH_STEPS; i++) {
      vec3 cur = o + d * t;
      float dt = 0.045 * length(cur) + 0.02;
      t = min(t + dt, tMax);
      vec3 p = o + d * t;
      float r = length(p);
      if (r > MARCH_FAR) break;
      float sd = envDist(side, p / r);
      bool front = r <= sd;
      if (!front && prevFront && sd < SKY_DIST) {
        float lo = prevT;
        float hi = t;
        for (int k = 0; k < REFINE_STEPS; k++) {
          float m = 0.5 * (lo + hi);
          vec3 q = o + d * m;
          float rq = length(q);
          if (rq > envDist(side, q / rq)) hi = m; else lo = m;
        }
        vec3 q = o + d * hi;
        float rq = length(q);
        if (abs(rq - envDist(side, q / rq)) < 0.2 + 0.02 * rq + (hi - lo)) {
          hit = q;
          return true;
        }
      }
      prevFront = front;
      prevT = t;
      if (t >= tMax) {
        hit = gp;
        return true;
      }
    }
    // nada perto: direção pura (paisagem distante ou céu, já no cubemap de cor)
    hit = d * 1e4;
    return true;
  }

  // Amostras filtradas pela "pegada" do feixe de raios (gx, gy = variação da direção final
  // entre pixels vizinhos): onde a lente comprime a imagem (anéis do túnel, borda da boca),
  // o pixel cobre um ângulo grande e deve mostrar a média dele — não um ponto (moiré).
  vec3 envColor(float side, vec3 dir, vec3 gx, vec3 gy) {
    return side > 0.0 ? textureGrad(colS, dir, gx, gy).rgb * uSelfScale : textureGrad(colO, dir, gx, gy).rgb * uOtherScale;
  }

  vec3 groundColor(float side, vec3 dir, vec3 gx, vec3 gy) {
    return side > 0.0 ? textureGrad(groundS, dir, gx, gy).rgb * uSelfScale : textureGrad(groundO, dir, gx, gy).rgb * uOtherScale;
  }

  vec3 skyColor(float side, vec3 dir, vec3 gx, vec3 gy) {
    return side > 0.0 ? textureGrad(skyS, dir, gx, gy).rgb * uSelfScale : textureGrad(skyO, dir, gx, gy).rgb * uOtherScale;
  }

  // ---------------- traçado ----------------

  // retorno: 1 = ponto da cena (hit, relativo ao centro do mundo 'side'), 2 = céu (outDir), 3 = preso
  int traceRay(vec3 er, float l0, vec3 dir, out float side, out vec3 hit, out vec3 outDir, out float sweep) {
    float nr = dot(dir, er);
    vec3 t = dir - nr * er;
    float st = length(t);
    vec3 et = st > 1e-6 ? t / st : normalize(cross(er, abs(er.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    float l = l0;
    float r = rdr(l).x;
    float b = r * st;
    float b2 = b * b;
    float p = nr;
    float phi = 0.0;
    float lFlat = uA + uW;
    side = l >= 0.0 ? 1.0 : -1.0;
    outDir = dir;
    hit = vec3(0.0);
    sweep = 0.0;
    vec3 P = r * er;

    for (int i = 0; i < MAX_STEPS; i++) {
      if (abs(l) >= lFlat && p * side >= 0.0) {
        // espaço plano: segue reto contra a cena
        float ph = phi + atan(b / r, abs(p));
        vec3 d = cos(ph) * er + sin(ph) * et;
        vec3 o = P;
        if (side < 0.0) {
          d.z = -d.z;
          o.z = -o.z;
        }
        outDir = d;
        sweep = phi;
        return marchEnv(side, o, d, hit) ? 1 : 2;
      }
      if (abs(l) < uA) {
        // interior cilíndrico: p constante, φ cresce linearmente
        float edge = p > 0.0 ? uA : -uA;
        float dphi = abs(p) < 1e-4 ? 1e9 : b / (uRho * uRho) * (edge - l) / p;
        // o chão dos dois mundos se encontra na parede da garganta (círculo y = uGroundY):
        // procura o primeiro ponto em que o raio desce até ele dentro deste trecho
        float A = er.y;
        float B = et.y;
        float R = sqrt(A * A + B * B);
        float cg = uGroundY / (uRho * max(R, 1e-6));
        if (b > 1e-6 && R > 1e-6 && abs(cg) <= 1.0) {
          float base = atan(B, A) + acos(cg);
          float k = ceil((phi + 1e-4 - base) / 6.2831853);
          float phiG = base + k * 6.2831853;
          if (phiG - phi <= dphi) {
            float lc = l + (abs(p) < 1e-4 ? 0.0 : (phiG - phi) * p * uRho * uRho / b);
            side = lc >= 0.0 ? 1.0 : -1.0;
            hit = uRho * (cos(phiG) * er + sin(phiG) * et);
            if (side < 0.0) hit.z = -hit.z;
            sweep = phiG;
            return 1;
          }
        }
        if (abs(p) < 1e-4) { sweep = 1e3; return 3; }
        phi += dphi;
        l = edge + sign(p) * 1e-4;
        r = uRho;
        side = l >= 0.0 ? 1.0 : -1.0;
        P = r * (cos(phi) * er + sin(phi) * et);
        continue;
      }
      float h = max(0.15 * min(r, 0.5 * uW + 0.9 * (abs(l) - uA)), 1e-3);
      vec3 k1 = deriv(l, p, b2, b);
      vec3 k2 = deriv(l + 0.5 * h * k1.x, p + 0.5 * h * k1.y, b2, b);
      vec3 k3 = deriv(l + 0.5 * h * k2.x, p + 0.5 * h * k2.y, b2, b);
      vec3 k4 = deriv(l + h * k3.x, p + h * k3.y, b2, b);
      vec3 dd = (k1 + 2.0 * k2 + 2.0 * k3 + k4) * (h / 6.0);
      float nl = l + dd.x;
      float nphi = phi + dd.z;
      vec3 Pn = rdr(nl).x * (cos(nphi) * er + sin(nphi) * et);
      // chão dentro da região curva (plano perto das bocas)
      if ((nl >= 0.0) == (l >= 0.0) && Pn.y < uGroundY && P.y >= uGroundY) {
        hit = mix(P, Pn, (P.y - uGroundY) / max(P.y - Pn.y, 1e-6));
        if (side < 0.0) hit.z = -hit.z;
        sweep = nphi;
        return 1;
      }
      l = nl;
      p += dd.y;
      phi = nphi;
      r = rdr(l).x;
      side = l >= 0.0 ? 1.0 : -1.0;
      P = Pn;
    }
    sweep = 1e3;
    return 3;
  }

  vec3 applyFog(vec3 c, float L) {
    float f = 1.0 - exp(-uFogDens * uFogDens * L * L);
    return mix(c, uFogCol, f);
  }

  void main() {
    vec4 fp = uInvProj * vec4((vUv + uJitter) * 2.0 - 1.0, 1.0, 1.0);
    vec3 dir = normalize((uCamWorld * vec4(fp.xyz / fp.w, 0.0)).xyz);

    vec3 er = uEr;
    float l0 = uL;
    float tEntry = 0.0;
    bool traced = true;
    if (uTunnel < 0.5) {
      vec3 rel = uCamPos - uCenterS;
      float D = length(rel);
      if (D > uRFlat) {
        // câmera no espaço plano: só raios que cruzam a esfera curva são afetados
        float tca = -dot(rel, dir);
        float bb = D * D - tca * tca;
        if (tca <= 0.0 || bb >= uRFlat * uRFlat) {
          traced = false;
        } else {
          tEntry = tca - sqrt(uRFlat * uRFlat - bb);
          er = normalize(rel + dir * tEntry);
          l0 = uA + uW;
        }
      }
      if (traced && sceneDistance(vUv) < tEntry) traced = false;
    }
    if (!traced) {
      gl_FragColor = vec4(0.0);
      return;
    }

    float side;
    vec3 hit;
    vec3 outDir;
    float sweep;
    int state = traceRay(er, l0, dir, side, hit, outDir, sweep);

    if (uDebug > 0.5) {
      vec3 c = state == 1 ? (side > 0.0 ? vec3(0.4, 0.0, 0.0) : vec3(0.0, 0.4, 0.0))
             : state == 2 ? (side > 0.0 ? vec3(0.0, 0.0, 0.4) : vec3(0.4, 0.4, 0.0)) : vec3(0.4);
      gl_FragColor = vec4(c, 1.0);
      return;
    }

    // pegada do feixe (derivadas calculadas fora de desvios, em fluxo uniforme)
    vec3 sd = state == 1 ? normalize(hit) : outDir;
    float hr = state == 1 ? length(hit) : SKY_DIST;
    float branch = side * (state == 1 ? 1.0 : 2.0);
    vec3 gx = dFdx(sd);
    vec3 gy = dFdy(sd);
    // vizinho em outro ramo (outro mundo, céu × chão) ou do outro lado de uma silhueta:
    // a derivada mede o salto, não a compressão — não borra
    bool disc = fwidth(branch) > 0.0 || fwidth(log(max(hr, 0.1))) > 0.35;
    float cap = disc ? 0.003 : FOOTPRINT_MAX;
    gx *= min(1.0, cap / max(length(gx), 1e-6));
    gy *= min(1.0, cap / max(length(gy), 1e-6));

    // quantas voltas o raio dá varia muito de um pixel para o vizinho (anéis do túnel,
    // esfera de fótons): o pixel cobre muitas imagens e deve mostrar a média delas
    float spread = fwidth(sweep);
    float meanW = smoothstep(1.0, 3.0, spread);

    // anisotropia do chão na tela: quanto um pixel cobre de chão numa direção vs. na outra
    vec2 hx = dFdx(hit.xz);
    vec2 hy = dFdy(hit.xz);
    float l1 = length(hx);
    float l2 = length(hy);
    float aniso = max(l1, l2) / max(min(l1, l2), 1e-5);
    float exoDetail = 1.0 - smoothstep(2.5, 8.0, aniso) - smoothstep(0.15, 0.6, max(l1, l2));

    vec3 col = vec3(0.0);
    if (state == 1) {
      vec3 hd = sd;
      // ponto escondido (do centro) atrás de vegetação: a captura principal mostraria a
      // vegetação esticada sobre ele; usa a captura só de terreno
      bool hidden = envDist(side, hd) < min(hr, SKY_DIST) - (0.3 + 0.03 * min(hr, 500.0));
      col = hidden ? groundColor(side, hd, gx, gy) : envColor(side, hd, gx, gy);
      // chão perto da boca: terreno da captura sem vegetação + matéria exótica calculada no
      // ponto exato (a captura do centro, rente ao chão, a deixaria esticada)
      if (abs(hit.y - uGroundY) < 0.35 && length(hit.xz) < uExoticR * EXOTIC_EXTENT) {
        float ei = side > 0.0 ? uExoticS * uSelfScale : uExoticO * uOtherScale;
        col = groundColor(side, hd, gx, gy) + exoticColor(hit.xz, uExoticR, uTime, clamp(exoDetail, 0.0, 1.0)) * ei;
      }
      if (side > 0.0) {
        // ponto deste mundo visível diretamente pela câmera: usa o pixel rasterizado
        vec3 hw = uCenterS + hit;
        vec4 clip = uViewProj * vec4(hw, 1.0);
        if (clip.w > 0.0) {
          vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
          if (all(greaterThan(suv, vec2(0.0))) && all(lessThan(suv, vec2(1.0)))) {
            float de = length(hw - uCamPos);
            if (abs(sceneDistance(suv) - de) < 0.01 * de + 0.1) col = texture(tScene, suv).rgb * uSelfScale;
          }
        }
      }
    } else if (state == 2) {
      col = skyColor(side, outDir, gx, gy);
    }
    if (meanW > 0.0 || state == 3) {
      // média sobre o círculo de saída possível do raio (o plano da órbita: er e et)
      vec3 nt = dir - dot(dir, er) * er;
      vec3 et = length(nt) > 1e-6 ? normalize(nt) : normalize(cross(er, vec3(0.0, 1.0, 0.0)));
      vec3 avg = vec3(0.0);
      for (int k = 0; k < 8; k++) {
        float an = float(k) * 0.785398;
        vec3 d = cos(an) * er + sin(an) * et;
        if (side < 0.0) d.z = -d.z;
        avg += side > 0.0 ? textureLod(colS, d, 6.0).rgb * uSelfScale : textureLod(colO, d, 6.0).rgb * uOtherScale;
      }
      col = mix(col, avg / 8.0, state == 3 ? 1.0 : meanW);
    }
    // névoa deste mundo entre a câmera e a boca
    if (side < 0.0) col = applyFog(col, tEntry);
    gl_FragColor = vec4(col, 1.0);
  }`;

const accumulateShader = /* glsl */ `
  uniform sampler2D tCurrent;
  uniform sampler2D tHistory;
  uniform float uWeight;
  varying vec2 vUv;
  void main() {
    gl_FragColor = mix(texture(tHistory, vUv), texture(tCurrent, vUv), uWeight);
  }`;

const compositeShader = /* glsl */ `
  uniform sampler2D tScene;
  uniform sampler2D tDepth;
  uniform sampler2D tTrace;
  uniform mat4 uInvProj;
  uniform mat4 uCamWorld;
  uniform vec3 uCamPos;
  uniform vec3 uCenterS;
  uniform float uRFlat;
  uniform float uTunnel;
  uniform float uSelfScale;
  uniform float uVignette;
  uniform float uGroundY;
  uniform float uContact;    // altura (m) da transição suave onde a boca encosta no chão
  varying vec2 vUv;

  float sceneDistance(vec2 uv) {
    float d = texture(tDepth, uv).x;
    if (d >= 0.999999) return 1e7;
    vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return length(p.xyz / p.w);
  }

  void main() {
    vec3 col = texture(tScene, vUv).rgb * uSelfScale;
    // máscara da região curva em resolução cheia (contorno nítido mesmo com traçado reduzido)
    bool traced = true;
    float blend = 1.0;
    if (uTunnel < 0.5) {
      vec4 fp = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
      vec3 dir = normalize((uCamWorld * vec4(fp.xyz / fp.w, 0.0)).xyz);
      vec3 rel = uCamPos - uCenterS;
      float D = length(rel);
      if (D > uRFlat) {
        float tca = -dot(rel, dir);
        float bb = D * D - tca * tca;
        if (tca <= 0.0 || bb >= uRFlat * uRFlat) traced = false;
        else {
          float tEntry = tca - sqrt(uRFlat * uRFlat - bb);
          if (sceneDistance(vUv) < tEntry) traced = false;
          // contato com o chão: quanto mais rente ao chão o raio entra na boca, mais ele se
          // mistura com o chão real deste lado (transição suave em vez de uma linha dura)
          float h = (rel + dir * tEntry).y - uGroundY;
          blend = smoothstep(0.0, max(uContact, 1e-3), h);
          blend = uContact > 0.0 ? blend * blend * (3.0 - 2.0 * blend) : 1.0;
        }
      }
    }
    if (traced) {
      // cor pré-multiplicada pela cobertura: desfaz para não escurecer pixels de borda
      vec4 tr = texture(tTrace, vUv);
      if (tr.a > 1e-3) col = mix(col, tr.rgb / tr.a, blend);
    }
    float v = length(vUv - 0.5) * 1.414;
    col *= 1.0 - uVignette * smoothstep(0.4, 1.0, v);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

/** Grava a distância de cada superfície até um centro (inclui instâncias). */
const distanceMaterial = new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  uniforms: { uCenter: { value: new THREE.Vector3() } },
  vertexShader: /* glsl */ `
    #include <common>
    varying vec3 vWorld;
    void main() {
      #include <begin_vertex>
      vec4 p = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        p = instanceMatrix * p;
      #endif
      vec4 wp = modelMatrix * p;
      vWorld = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uCenter;
    varying vec3 vWorld;
    void main() {
      gl_FragColor = vec4(length(vWorld - uCenter));
    }`,
});

function halton(i: number, base: number) {
  let f = 1;
  let r = 0;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

export interface WormholeView {
  self: World;
  other: World;
  /** coordenada ℓ da câmera */
  l: number;
  /** direção radial (do centro para a câmera), no referencial de `self` */
  er: THREE.Vector3;
  tunnel: boolean;
  exposure: number;
  rho: number;
  a: number;
  W: number;
  rFlat: number;
}

interface Env {
  color: THREE.CubeTexture;
  dist: THREE.CubeTexture;
  sky: THREE.CubeTexture;
  ground: THREE.CubeTexture;
  /** câmera e alvo da captura de cor, reaproveitados para atualizar faces a cada quadro */
  colorCam: THREE.CubeCamera;
  colorRT: THREE.WebGLCubeRenderTarget;
  nextFace: number;
}

export class WormholeRenderer {
  private target: THREE.WebGLRenderTarget;
  private envs = new Map<World, Env>();
  private material: THREE.ShaderMaterial;
  private accumMat: THREE.ShaderMaterial;
  private compositeMat: THREE.ShaderMaterial;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private viewProj = new THREE.Matrix4();
  private traceRT: THREE.WebGLRenderTarget;
  private history: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private frame = 0;
  private lastKey: number[] = [];
  private lastSelf: World | null = null;
  private fullSize = new THREE.Vector2();
  /** Fração da resolução usada no traçado (1 = resolução cheia). */
  resolutionScale = 1;
  /** Janela do acúmulo com a câmera parada (média móvel: animações continuam visíveis). */
  maxSamples = 1;
  /** Faces do cubemap de cor do outro mundo regravadas por quadro (6 = tudo, todo quadro). */
  otherFacesPerFrame = 2;
  /** Faces do cubemap de cor deste mundo regravadas a cada 2 quadros. */
  selfFacesPerFrame = 1;
  private tick = 0;

  /** Altura (m) da transição suave onde a boca encosta no chão (0 = borda dura). */
  get contactSoftness() {
    return this.compositeMat.uniforms.uContact.value as number;
  }
  set contactSoftness(v: number) {
    this.compositeMat.uniforms.uContact.value = v;
  }
  private frustum = new THREE.Frustum();
  private sphere = new THREE.Sphere();

  constructor(
    private renderer: THREE.WebGLRenderer,
    worlds: World[],
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
      depthTexture: new THREE.DepthTexture(size.x, size.y),
    });

    for (const w of worlds) this.envs.set(w, this.captureEnv(w));

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: traceShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tScene: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        colS: { value: null },
        colO: { value: null },
        distS: { value: null },
        distO: { value: null },
        skyS: { value: null },
        groundS: { value: null },
        groundO: { value: null },
        skyO: { value: null },
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uViewProj: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uCenterS: { value: new THREE.Vector3() },
        uEr: { value: new THREE.Vector3(0, 0, 1) },
        uL: { value: 0 },
        uRho: { value: 4 },
        uA: { value: 0 },
        uW: { value: 1 },
        uRFlat: { value: 5 },
        uGroundY: { value: -WORMHOLE_LIFT },
        uTunnel: { value: 0 },
        uSelfScale: { value: 1 },
        uOtherScale: { value: 1 },
        uFogCol: { value: new THREE.Color() },
        uFogDens: { value: 0 },
        uJitter: { value: new THREE.Vector2() },
        uDebug: { value: new URLSearchParams(location.search).has('debug') ? 1 : 0 },
        uTime: windUniforms.uTime,
        uExoticR: { value: 4 },
        uExoticS: { value: 0 },
        uExoticO: { value: 0 },
      },
    });

    const rtOpts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.traceRT = new THREE.WebGLRenderTarget(size.x, size.y, rtOpts);
    this.history = [new THREE.WebGLRenderTarget(size.x, size.y, rtOpts), new THREE.WebGLRenderTarget(size.x, size.y, rtOpts)];

    this.accumMat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: accumulateShader,
      depthTest: false,
      depthWrite: false,
      uniforms: { tCurrent: { value: this.traceRT.texture }, tHistory: { value: null }, uWeight: { value: 1 } },
    });
    const tu = this.material.uniforms;
    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: compositeShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tScene: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        tTrace: { value: null },
        uInvProj: tu.uInvProj,
        uCamWorld: tu.uCamWorld,
        uCamPos: tu.uCamPos,
        uCenterS: tu.uCenterS,
        uRFlat: tu.uRFlat,
        uTunnel: tu.uTunnel,
        uSelfScale: { value: 1 },
        uVignette: { value: 0.2 },
        uGroundY: tu.uGroundY,
        uContact: { value: 1.2 },
      },
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.postScene.add(this.quad);
    this.setSize(size.x, size.y);
  }

  /**
   * Captura, do centro da boca: cor (com luz, sombra e névoa), distância até a superfície e
   * só o céu. O mundo é estático, então basta uma vez.
   */
  private captureEnv(world: World): Env {
    const r = this.renderer;
    const center = world.wormholeCenter;
    world.update(0, 0, center);

    const cube = (size: number, opts: THREE.RenderTargetOptions) => {
      const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, ...opts });
      const cam = new THREE.CubeCamera(0.05, 10000, rt);
      cam.position.copy(center);
      cam.updateMatrixWorld();
      return { rt, cam };
    };
    const hideWhere = (pred: (o: THREE.Object3D) => boolean) => {
      const hidden: THREE.Object3D[] = [];
      world.scene.traverse((o) => {
        const renderable = (o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints;
        if (renderable && o.visible && pred(o)) {
          o.visible = false;
          hidden.push(o);
        }
      });
      return () => hidden.forEach((o) => (o.visible = true));
    };

    // cor
    const color = cube(1024, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    r.shadowMap.needsUpdate = true;
    color.cam.update(r, world.scene);

    // distância (partículas e chamas aditivas não são superfícies)
    const dist = cube(1024, { generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const restore = hideWhere((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material;
      return (o as THREE.Points).isPoints || m.blending === THREE.AdditiveBlending || o.userData.sky;
    });
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    const prevFog = world.scene.fog;
    r.setClearColor(new THREE.Color(1e4, 1e4, 1e4), 1);
    world.scene.overrideMaterial = distanceMaterial;
    world.scene.fog = null;
    distanceMaterial.uniforms.uCenter.value.copy(center);
    dist.cam.update(r, world.scene);
    world.scene.overrideMaterial = null;
    world.scene.fog = prevFog;
    r.setClearColor(prevClear, prevAlpha);
    restore();

    // céu
    const sky = cube(512, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    const restoreSky = hideWhere((o) => !o.userData.sky);
    sky.cam.update(r, world.scene);
    restoreSky();

    // só terreno (+ céu): o que fica atrás da vegetação vista do centro
    const ground = cube(1024, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    const restoreGround = hideWhere((o) => !o.userData.terrain && !o.userData.sky);
    ground.cam.update(r, world.scene);
    restoreGround();

    return { color: color.rt.texture, dist: dist.rt.texture, sky: sky.rt.texture, ground: ground.rt.texture, colorCam: color.cam, colorRT: color.rt, nextFace: 0 };
  }

  /**
   * Regrava `count` faces da captura de cor (rodízio), para que o que se vê através da boca
   * esteja em tempo real: chamas, grama ao vento, estrelas, luz da fogueira.
   */
  private refreshColor(world: World, count: number) {
    const env = this.envs.get(world)!;
    const faces = env.colorCam.children as THREE.Camera[];
    const tex = env.colorRT.texture;
    const mip = tex.generateMipmaps;
    for (let k = 0; k < count; k++) {
      const f = env.nextFace;
      env.nextFace = (f + 1) % 6;
      // mipmaps só depois da última face deste quadro
      tex.generateMipmaps = mip && k === count - 1;
      this.renderer.setRenderTarget(env.colorRT, f);
      this.renderer.render(world.scene, faces[f]);
    }
    tex.generateMipmaps = mip;
  }

  private pass(material: THREE.Material, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.postScene, this.postCam);
  }

  setSize(w: number, h: number) {
    this.fullSize.set(w, h);
    this.target.setSize(w, h);
    const tw = Math.max(1, Math.round(w * this.resolutionScale));
    const th = Math.max(1, Math.round(h * this.resolutionScale));
    this.traceRT.setSize(tw, th);
    this.history[0].setSize(tw, th);
    this.history[1].setSize(tw, th);
    this.frame = 0;
  }

  setResolutionScale(scale: number) {
    this.resolutionScale = scale;
    this.setSize(this.fullSize.x, this.fullSize.y);
  }

  /** Recomeça o acúmulo quando algo que muda a imagem traçada muda. */
  private updateAccumulation(camera: THREE.PerspectiveCamera, view: WormholeView) {
    const key = [
      ...camera.matrixWorld.elements,
      ...camera.projectionMatrix.elements,
      view.l, view.rho, view.a, view.W, view.exposure,
      view.tunnel ? 1 : 0, view.self === this.lastSelf ? 0 : 1,
    ];
    this.lastSelf = view.self;
    let same = key.length === this.lastKey.length;
    for (let i = 0; same && i < key.length; i++) same = Math.abs(key[i] - this.lastKey[i]) < 1e-6;
    this.lastKey = key;
    if (!same) this.frame = 0;
  }

  render(camera: THREE.PerspectiveCamera, view: WormholeView) {
    const u = this.material.uniforms;
    const es = this.envs.get(view.self)!;
    const eo = this.envs.get(view.other)!;
    u.colS.value = es.color;
    u.colO.value = eo.color;
    u.distS.value = es.dist;
    u.distO.value = eo.dist;
    u.skyS.value = es.sky;
    u.skyO.value = eo.sky;
    u.groundS.value = es.ground;
    u.groundO.value = eo.ground;
    const exS = view.self.scene.userData.exotic;
    const exO = view.other.scene.userData.exotic;
    u.uExoticS.value = exS ? exS.material.uniforms.uIntensity.value : 0;
    u.uExoticO.value = exO ? exO.material.uniforms.uIntensity.value : 0;
    if (exS) u.uExoticR.value = exS.radius;
    const fog = view.self.scene.fog as THREE.FogExp2 | null;
    if (fog) u.uFogCol.value.copy(fog.color);
    u.uFogDens.value = fog ? fog.density : 0;

    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(camera.matrixWorld);
    u.uViewProj.value.copy(this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    u.uCenterS.value.copy(view.self.wormholeCenter);
    u.uEr.value.copy(view.er);
    u.uL.value = view.l;
    u.uRho.value = view.rho;
    u.uA.value = view.a;
    u.uW.value = view.W;
    u.uRFlat.value = view.rFlat;
    u.uTunnel.value = view.tunnel ? 1 : 0;
    u.uSelfScale.value = view.self.exposure / view.exposure;
    u.uOtherScale.value = view.other.exposure / view.exposure;

    this.renderer.toneMappingExposure = view.exposure;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(view.self.scene, camera);

    // capturas de cor em tempo real, só quando a região curva está na tela
    this.frustum.setFromProjectionMatrix(this.viewProj);
    this.sphere.set(view.self.wormholeCenter, view.rFlat);
    if (view.tunnel || this.frustum.intersectsSphere(this.sphere)) {
      this.tick++;
      if (this.otherFacesPerFrame > 0) this.refreshColor(view.other, this.otherFacesPerFrame);
      if (this.selfFacesPerFrame > 0 && this.tick % 2 === 0) this.refreshColor(view.self, this.selfFacesPerFrame);
    }

    // 1. traçado com jitter subpixel (Halton 2,3; a 1ª amostra fica no centro do pixel)
    this.updateAccumulation(camera, view);
    const n = this.frame;
    const jx = n === 0 ? 0 : halton(n, 2) - 0.5;
    const jy = n === 0 ? 0 : halton(n, 3) - 0.5;
    u.uJitter.value.set(jx / this.traceRT.width, jy / this.traceRT.height);
    this.pass(this.material, this.traceRT);
    // 2. média progressiva
    const [prev, next] = this.history;
    this.accumMat.uniforms.tHistory.value = prev.texture;
    this.accumMat.uniforms.uWeight.value = 1 / (Math.min(n, this.maxSamples - 1) + 1);
    this.pass(this.accumMat, next);
    this.history = [next, prev];
    this.frame++;

    // 3. composição com a imagem rasterizada em resolução cheia, tom e espaço de cor
    this.compositeMat.uniforms.tTrace.value = this.history[0].texture;
    this.compositeMat.uniforms.uSelfScale.value = view.self.exposure / view.exposure;
    this.pass(this.compositeMat, null);
  }
}
