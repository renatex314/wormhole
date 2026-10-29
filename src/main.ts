import * as THREE from 'three';
import GUI from 'lil-gui';
import './style.css';
import { EYE_HEIGHT, lengthAt, radiusAt, smoothstep, windUniforms, wormholeGeom, wormholeParams, type World } from './common';
import { addExoticFloor } from './exotic';
import { Player } from './player';
import { WormholeRenderer } from './wormhole';
import { createDesert } from './worlds/desert';
import { createForest } from './worlds/forest';

const overlay = document.getElementById('overlay')!;
const status = document.getElementById('status')!;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const worldLabel = document.getElementById('world-label')!;
const distanceLabel = document.getElementById('distance')!;
const modeLabel = document.getElementById('mode')!;

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// sombras atualizadas manualmente uma vez por renderização de cena (não a cada face de cubemap)
renderer.shadowMap.autoUpdate = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.2, 6000);
const player = new Player(camera);

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/** Estado de quem está dentro da garganta: posição ℓ e direção radial (horizontal) de entrada. */
interface Tunnel {
  from: World;
  to: World;
  u: THREE.Vector3;
  l: number;
}

/**
 * Mapa de direções do mundo de entrada para o de saída: reflexão no plano tangente da
 * boca (o radial para dentro vira radial para fora) seguida do espelho no eixo z da colagem.
 * Duas reflexões = uma rotação. Para u horizontal ela é em torno de y ("para cima" fica igual);
 * entrando pulando (u inclinado) ela também inclina, como deve.
 */
function throughMap(v: THREE.Vector3, u: THREE.Vector3) {
  v.addScaledVector(u, -2 * v.dot(u));
  v.z = -v.z;
  return v;
}

function setupGui(wormhole: WormholeRenderer) {
  const gui = new GUI({ title: 'Buraco de minhoca' });
  gui.add(wormholeParams, 'rho', 1.5, 10, 0.1).name('Raio da garganta ρ (m)').listen();
  gui.add(wormholeParams, 'length', 0, 120, 0.01).name('Comprimento 2a (m)').listen();
  gui.add(wormholeParams, 'width', 0.05, 20, 0.05).name('Suavização das bordas W (m)').listen();
  gui.add(wormhole, 'contactSoftness', 0, 4, 0.05).name('Suavização no chão (m)');
  const presets = {
    interstellar() {
      Object.assign(wormholeParams, { rho: 4, length: 0.02, width: 0.2 });
    },
    suave() {
      Object.assign(wormholeParams, { rho: 4, length: 0.1, width: 6 });
    },
    tunel() {
      Object.assign(wormholeParams, { rho: 4, length: 60, width: 4 });
    },
    padrao() {
      Object.assign(wormholeParams, { rho: 4, length: 0.1, width: 0.6 });
    },
  };
  const f = gui.addFolder('Predefinições');
  f.add(presets, 'interstellar').name('Interstellar (borda nítida)');
  f.add(presets, 'suave').name('Lente larga e suave');
  f.add(presets, 'tunel').name('Túnel longo (60 m)');
  f.add(presets, 'padrao').name('Padrão');
  const q = gui.addFolder('Qualidade do traçado');
  q.add(wormhole, 'resolutionScale', { 'Cheia (100%)': 1, 'Alta (75%)': 0.75, 'Média (50%)': 0.5 })
    .name('Resolução')
    .onChange((v: number) => wormhole.setResolutionScale(v));
  q.add(wormhole, 'maxSamples', 1, 64, 1).name('Amostras acumuladas');
  q.add(wormhole, 'otherFacesPerFrame', 0, 6, 1).name('Outro lado: faces/quadro');
  q.add(wormhole, 'selfFacesPerFrame', 0, 6, 1).name('Este lado: faces/2 quadros');
  gui.domElement.style.zIndex = '20';
  return gui;
}

async function start() {
  await nextFrame();
  const forest = createForest();
  status.textContent = 'Gerando deserto…';
  await nextFrame();
  const desert = createDesert();
  status.textContent = 'Capturando o espaço-tempo…';
  await nextFrame();
  // matéria exótica sob as bocas (antes das capturas, para aparecer através da garganta)
  // círculo onde a esfera da boca (raio ρ) toca o chão
  const { rho: rho0 } = wormholeGeom();
  const exoticR = Math.sqrt(Math.max(rho0 * rho0 - EYE_HEIGHT * EYE_HEIGHT, 1));
  const exotic = [
    { ...addExoticFloor(forest, exoticR, 0.9, 25), base: 0.9, baseLight: 25 },
    { ...addExoticFloor(desert, exoticR, 0.45, 10), base: 0.45, baseLight: 10 },
  ];
  const exoticCtl = { brilho: 1 };
  const wormhole = new WormholeRenderer(renderer, [forest, desert]);
  const params = new URLSearchParams(location.search);


  let current: World = forest;
  let other: World = desert;
  let tunnel: Tunnel | null = null;
  player.position.set(0, forest.terrain.heightAt(0, 8), 8);

  const rel = new THREE.Vector3();
  const er = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  function enterTunnel(u: THREE.Vector3) {
    tunnel = { from: current, to: other, u: u.clone(), l: wormholeGeom().a };
    worldLabel.textContent = `Garganta · ${current.name.split(' ·')[0]} → ${other.name.split(' ·')[0]}`;
  }

  /** Sai da garganta pelo lado `side` (+1 volta ao mundo de entrada, -1 chega ao outro). */
  function exitTunnel(t: Tunnel, side: number) {
    const r = radiusAt(t.l) + 0.01;
    if (side > 0) {
      const eye = t.from.wormholeCenter.clone().addScaledVector(t.u, r);
      player.position.set(eye.x, eye.y - EYE_HEIGHT, eye.z);
    } else {
      const out = t.u.clone().setZ(-t.u.z); // posição angular colada pelo espelho em z
      const eye = t.to.wormholeCenter.clone().addScaledVector(out, r);
      player.position.set(eye.x, eye.y - EYE_HEIGHT, eye.z);
      throughMap(player.velocity, t.u);
      // olhar: mapeia a direção 3D completa (guinada e inclinação), não só a horizontal
      const cp = Math.cos(player.pitch);
      const f = throughMap(tmp.set(-Math.sin(player.yaw) * cp, Math.sin(player.pitch), -Math.cos(player.yaw) * cp), t.u);
      player.yaw = Math.atan2(-f.x, -f.z);
      player.pitch = Math.asin(THREE.MathUtils.clamp(f.y, -1, 1));
      current = t.to;
      other = t.from;
    }
    const g = current.terrain.heightAt(player.position.x, player.position.z);
    if (player.position.y < g) player.position.y = g;
    tunnel = null;
    worldLabel.textContent = current.name;
    // reposiciona a câmera já neste quadro (senão um quadro sai com a câmera no lado antigo)
    player.update(0, current);
  }

  worldLabel.textContent = current.name;

  if (params.has('contact')) wormhole.contactSoftness = +params.get('contact')!;
  if (params.has('faces')) wormhole.otherFacesPerFrame = +params.get('faces')!;
  const scaleParam = params.get('scale');
  if (scaleParam) wormhole.setResolutionScale(+scaleParam);
  // ?view=desert,x,z,yaw,pitch[&l=ℓ][&p=ρ,2a,W] — posiciona a câmera sem pointer lock (útil para depurar)
  const view = params.get('view');
  if (view) {
    const [w, x, z, yaw, pitch] = view.split(',');
    if (w === 'desert') [current, other] = [desert, forest];
    worldLabel.textContent = current.name;
    player.position.set(+x || 0, current.terrain.heightAt(+x || 0, +z || 8), +z || 8);
    player.yaw = +yaw || 0;
    player.pitch = +pitch || 0;
    overlay.classList.add('hidden');
    if (params.has('p')) {
      const [rho, length, width] = params.get('p')!.split(',').map(Number);
      Object.assign(wormholeParams, { rho, length, width });
    }
    if (params.has('l')) {
      enterTunnel(new THREE.Vector3(0, 0, 1));
      tunnel!.l = +params.get('l')!;
    }
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    const s = renderer.getDrawingBufferSize(new THREE.Vector2());
    wormhole.setSize(s.x, s.y);
  });

  playBtn.disabled = false;
  playBtn.textContent = 'Clique para jogar';
  status.textContent = 'Siga a trilha até o buraco de minhoca.';
  playBtn.addEventListener('click', () => renderer.domElement.requestPointerLock());
  renderer.domElement.addEventListener('click', () => {
    if (!player.locked) renderer.domElement.requestPointerLock();
  });
  document.addEventListener('pointerlockchange', () => {
    player.locked = document.pointerLockElement === renderer.domElement;
    overlay.classList.toggle('hidden', player.locked);
    if (!player.locked) status.textContent = 'Pausado — ajuste os parâmetros no painel à direita.';
  });

  // ?walk=s — começa a andar para frente sozinho depois de s segundos (depuração)
  const walkAfter = params.has('walk') ? +(params.get('walk') || 0) : Infinity;
  // ?jump=s — pula uma vez depois de s segundos (depuração)
  let jumpAt = params.has('jump') ? +(params.get('jump') || 0) : Infinity;

  const gui = setupGui(wormhole);
  gui
    .add(exoticCtl, 'brilho', 0, 3, 0.05)
    .name('Matéria exótica (brilho)')
    .onChange((v: number) => {
      for (const e of exotic) {
        e.material.uniforms.uIntensity.value = e.base * v;
        e.light.intensity = e.baseLight * v;
      }
    });

  const clock = new THREE.Clock();
  let time = 0;
  let fps = 60;

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    player.autoForward = time > walkAfter;
    if (time > jumpAt) {
      jumpAt = Infinity;
      player.velocity.y = 8.5;
    }
    const step = player.locked || player.autoForward ? dt : 0;
    time += dt;
    windUniforms.uTime.value = time;
    const { rho, a, W, rFlat } = wormholeGeom();

    if (!tunnel) {
      player.update(step, current);
      rel.subVectors(player.eye, current.wormholeCenter);
      // tocou a boca indo para dentro: começa a percorrer a garganta
      if (rel.length() <= rho && player.velocity.dot(rel) < 0) {
        // direção radial 3D real (pulando, os olhos estão acima do centro da boca)
        const u = rel.clone();
        if (u.lengthSq() < 1e-6) u.set(Math.sin(player.yaw), 0, Math.cos(player.yaw));
        enterTunnel(u.normalize());
      }
    }
    if (tunnel) {
      const t: Tunnel = tunnel;
      player.update(step, t.from, true);
      t.l = Math.min(t.l, a + 0.5);
      // movimento radial muda ℓ; o tangencial anda sobre a esfera de raio r(ℓ) (contorna a garganta)
      const vr = player.velocity.dot(t.u);
      t.l += vr * step;
      const vt = tmp.copy(player.velocity).addScaledVector(t.u, -vr);
      const ang = (vt.length() * step) / radiusAt(t.l);
      if (ang > 1e-7) {
        // transporte paralelo: gira posição angular, velocidade e olhar pela mesma rotação
        const axis = new THREE.Vector3().crossVectors(t.u, vt).normalize();
        const q = new THREE.Quaternion().setFromAxisAngle(axis, ang);
        t.u.applyQuaternion(q).normalize();
        player.velocity.applyQuaternion(q);
        const cp = Math.cos(player.pitch);
        const look = new THREE.Vector3(-Math.sin(player.yaw) * cp, Math.sin(player.pitch), -Math.cos(player.yaw) * cp).applyQuaternion(q);
        player.yaw = Math.atan2(-look.x, -look.z);
        player.pitch = Math.asin(THREE.MathUtils.clamp(look.y, -1, 1));
        player.update(0, t.from, true);
      }
      if (t.l > a + 0.02) exitTunnel(t, 1);
      else if (t.l < -a - 0.02) exitTunnel(t, -1);
    }

    camera.updateMatrixWorld();
    // o outro mundo também é visto (pela garganta): mantém luzes e animações dele em dia
    const seen = tunnel ? [tunnel.from, tunnel.to] : [current, other];
    seen[1].update(time, dt, seen[1].wormholeCenter);

    if (tunnel) {
      seen[0].update(time, dt, player.position);
      const t: Tunnel = tunnel;
      // adaptação do olho entre a exposição dos dois mundos ao longo da garganta
      const k = a > 0 ? smoothstep(a, -a, t.l) : t.l < 0 ? 1 : 0;
      const exposure = Math.exp(THREE.MathUtils.lerp(Math.log(t.from.exposure), Math.log(t.to.exposure), k));
      wormhole.render(camera, { self: t.from, other: t.to, l: t.l, er: t.u, tunnel: true, exposure, rho, a, W, rFlat });
      const left = t.l + a;
      distanceLabel.textContent = `Dentro da garganta · ${left.toFixed(1)} m até a saída`;
    } else {
      current.update(time, dt, player.position);
      rel.subVectors(camera.position, current.wormholeCenter);
      const D = Math.max(rel.length(), rho);
      er.copy(rel).normalize();
      wormhole.render(camera, {
        self: current,
        other,
        l: lengthAt(D),
        er,
        tunnel: false,
        exposure: current.exposure,
        rho,
        a,
        W,
        rFlat,
      });
      distanceLabel.textContent = `Buraco de minhoca: ${Math.max(0, D - rho).toFixed(0)} m`;
    }
    if (dt > 0) fps += (1 / dt - fps) * 0.05;
    (window as unknown as { __fps: number }).__fps = fps;
    modeLabel.textContent = `${fps.toFixed(0)} FPS${player.fly ? ' · Modo voo (F para sair)' : ''}`;
  });
}

start();
