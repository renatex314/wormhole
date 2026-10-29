import * as THREE from 'three';
import { EYE_HEIGHT, WORLD_LIMIT, type World } from './common';

const GRAVITY = 24;
const JUMP_SPEED = 8.5;
const RADIUS = 0.35;

export class Player {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  fly = false;
  locked = false;
  /** Anda para frente sozinho (depuração / capturas). */
  autoForward = false;
  private onGround = false;
  private keys = new Set<string>();
  private bob = 0;
  private wish = new THREE.Vector3();

  constructor(private camera: THREE.PerspectiveCamera) {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'KeyF' && this.locked) {
        this.fly = !this.fly;
        this.velocity.set(0, 0, 0);
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0022, -1.55, 1.55);
    });
  }

  get eye() {
    return this.camera.position;
  }

  /** `frozen`: dentro da garganta a posição 3D fica parada; só a velocidade (que move ℓ) e o olhar mudam. */
  update(dt: number, world: World, frozen = false) {
    const k = this.keys;
    const run = k.has('ShiftLeft') || k.has('ShiftRight');
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const ix = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const iz = (k.has('KeyW') || this.autoForward ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    // frente * iz + direita * ix (direita = (-fz, 0, fx))
    this.wish.set(fx * iz - fz * ix, 0, fz * iz + fx * ix);
    if (this.wish.lengthSq() > 0) this.wish.normalize();

    if (frozen) {
      const speed = run ? 11 : 5.5;
      const t = 1 - Math.exp(-(this.fly ? 6 : 12) * dt);
      this.velocity.x += (this.wish.x * speed - this.velocity.x) * t;
      this.velocity.z += (this.wish.z * speed - this.velocity.z) * t;
      // a velocidade vertical (pulo) é preservada: ela também move ao longo da garganta
      this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
      return;
    }

    if (this.fly) {
      const speed = run ? 60 : 20;
      const up = (k.has('Space') ? 1 : 0) - (k.has('KeyC') ? 1 : 0);
      this.velocity.set(this.wish.x * speed, up * speed, this.wish.z * speed);
      this.position.addScaledVector(this.velocity, dt);
      const g = world.terrain.heightAt(this.position.x, this.position.z);
      if (this.position.y < g) this.position.y = g;
    } else {
      const speed = run ? 11 : 5.5;
      const accel = this.onGround ? 12 : 2.5;
      const t = 1 - Math.exp(-accel * dt);
      this.velocity.x += (this.wish.x * speed - this.velocity.x) * t;
      this.velocity.z += (this.wish.z * speed - this.velocity.z) * t;
      this.velocity.y -= GRAVITY * dt;
      if (this.onGround && k.has('Space')) {
        this.velocity.y = JUMP_SPEED;
        this.onGround = false;
      }
      this.position.addScaledVector(this.velocity, dt);
      world.colliders.resolve(this.position, RADIUS);

      const g = world.terrain.heightAt(this.position.x, this.position.z);
      if (this.position.y <= g) {
        this.position.y = g;
        this.velocity.y = 0;
        this.onGround = true;
      } else if (this.position.y - g > 0.25 || this.velocity.y > 0) {
        this.onGround = false;
      } else {
        // acompanha descidas suaves sem "voar"
        this.position.y = g;
      }
    }

    const r = Math.hypot(this.position.x, this.position.z);
    if (r > WORLD_LIMIT) {
      this.position.x *= WORLD_LIMIT / r;
      this.position.z *= WORLD_LIMIT / r;
    }

    const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.onGround && !this.fly) this.bob += hSpeed * dt * 1.6;
    const bobY = this.fly ? 0 : Math.sin(this.bob) * 0.04 * Math.min(hSpeed / 5, 1.5);

    this.camera.position.set(this.position.x, this.position.y + EYE_HEIGHT + bobY, this.position.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
