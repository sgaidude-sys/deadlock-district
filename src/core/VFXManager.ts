import * as THREE from 'three';
import { AssetManager } from './AssetManager';

interface Particle {
  sprite: THREE.Sprite;
  velocity: THREE.Vector3;
  age: number;
  lifetime: number;
  startScale: number;
  endScale: number;
  gravity: number;
  baseOpacity: number;
}

interface Tracer {
  mesh: THREE.Mesh;
  age: number;
  lifetime: number;
}

interface ShellCasing {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  angVel: THREE.Vector3;
  age: number;
  lifetime: number;
}

interface FireEmitter {
  position: THREE.Vector3;
  timer: number;
  intensity: number;
}

export class VFXManager {
  private scene: THREE.Scene;
  private assets: AssetManager;

  private particles: Particle[] = [];
  private tracers: Tracer[] = [];
  private casings: ShellCasing[] = [];
  private fireEmitters: FireEmitter[] = [];

  private muzzleLight: THREE.PointLight;
  private muzzleLightTimer = 0;

  private dustPoints: THREE.Points | null = null;
  private casingGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.045, 6);
  private casingMat = new THREE.MeshStandardMaterial({
    color: 0xd9a74a,
    metalness: 0.85,
    roughness: 0.25,
  });

  constructor(scene: THREE.Scene, assets: AssetManager) {
    this.scene = scene;
    this.assets = assets;

    this.muzzleLight = new THREE.PointLight(0xffaa44, 0, 14, 2);
    this.scene.add(this.muzzleLight);

    this.initAmbientDust();
  }

  private initAmbientDust(): void {
    const count = 450;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 140;
      positions[i * 3 + 1] = 0.5 + Math.random() * 9;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 140;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const tex = this.assets.getTexture('vfx_circle');
    const mat = new THREE.PointsMaterial({
      size: 0.22,
      map: tex ?? null,
      color: 0xcbd5e1,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.dustPoints = new THREE.Points(geo, mat);
    this.scene.add(this.dustPoints);
  }

  public registerFireEmitter(position: THREE.Vector3, intensity = 1): void {
    this.fireEmitters.push({ position: position.clone(), timer: Math.random() * 0.1, intensity });
  }

  public createFlashlightConeMesh(): THREE.Mesh {
    const geo = new THREE.ConeGeometry(3.2, 16, 24, 1, true);
    // Shift cone so tip is at origin and extends along +Z
    geo.translate(0, -8, 0);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color(0xfff1c9) },
        uOpacity: { value: 0.13 },
      },
      vertexShader: `
        varying vec3 vNormalView;
        varying vec3 vViewPos;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          vViewPos = -mvPos.xyz;
          vNormalView = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying vec3 vNormalView;
        varying vec3 vViewPos;
        varying vec2 vUv;
        void main() {
          vec3 viewDir = normalize(vViewPos);
          float fresnel = pow(abs(dot(vNormalView, viewDir)), 1.6);
          float distFade = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.35, 1.0, vUv.y));
          float alpha = fresnel * distFade * uOpacity;
          gl_FragColor = vec4(uColor, alpha);
        }
      `,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 5;
    return mesh;
  }

  public spawnMuzzleFlash(origin: THREE.Vector3, direction: THREE.Vector3): void {
    this.muzzleLight.position.copy(origin);
    this.muzzleLight.intensity = 6.5;
    this.muzzleLightTimer = 0.055;

    const tex = this.assets.getTexture('vfx_flare') ?? this.assets.getTexture('vfx_spark');
    const mat = new THREE.SpriteMaterial({
      map: tex ?? null,
      color: 0xffc857,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(origin).addScaledVector(direction, 0.12);
    sprite.scale.setScalar(0.55);
    this.scene.add(sprite);

    this.particles.push({
      sprite,
      velocity: direction.clone().multiplyScalar(2),
      age: 0,
      lifetime: 0.07,
      startScale: 0.6,
      endScale: 0.15,
      gravity: 0,
      baseOpacity: 0.95,
    });
  }

  public spawnTracer(start: THREE.Vector3, end: THREE.Vector3): void {
    const dist = start.distanceTo(end);
    if (dist < 0.2) return;

    const geo = new THREE.CylinderGeometry(0.014, 0.014, dist, 4);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffe082,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(start).lerp(end, 0.5);
    mesh.lookAt(end);
    this.scene.add(mesh);

    this.tracers.push({ mesh, age: 0, lifetime: 0.065 });
  }

  public spawnShellCasing(origin: THREE.Vector3, rightDir: THREE.Vector3): void {
    const mesh = new THREE.Mesh(this.casingGeo, this.casingMat);
    mesh.position.copy(origin);
    mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    this.scene.add(mesh);

    const velocity = rightDir
      .clone()
      .multiplyScalar(2.4 + Math.random() * 1.2)
      .add(new THREE.Vector3((Math.random() - 0.5) * 0.8, 2.2 + Math.random() * 0.8, (Math.random() - 0.5) * 0.8));

    this.casings.push({
      mesh,
      velocity,
      angVel: new THREE.Vector3(Math.random() * 18, Math.random() * 18, Math.random() * 18),
      age: 0,
      lifetime: 2.2,
    });
  }

  public spawnBloodBurst(pos: THREE.Vector3, normalDir: THREE.Vector3, count = 10): void {
    const tex = this.assets.getTexture('vfx_dirt') ?? this.assets.getTexture('vfx_circle');
    for (let i = 0; i < count; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex ?? null,
        color: i % 3 === 0 ? 0x991b1b : 0xdc2626,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.position.copy(pos);
      const scale = 0.22 + Math.random() * 0.28;
      sprite.scale.setScalar(scale);
      this.scene.add(sprite);

      const vel = normalDir
        .clone()
        .multiplyScalar(2.5 + Math.random() * 3.5)
        .add(new THREE.Vector3((Math.random() - 0.5) * 2.8, 1.2 + Math.random() * 2.4, (Math.random() - 0.5) * 2.8));

      this.particles.push({
        sprite,
        velocity: vel,
        age: 0,
        lifetime: 0.35 + Math.random() * 0.25,
        startScale: scale,
        endScale: scale * 1.4,
        gravity: 11,
        baseOpacity: 0.9,
      });
    }
  }

  public spawnImpactSparks(pos: THREE.Vector3, normal: THREE.Vector3): void {
    const tex = this.assets.getTexture('vfx_spark') ?? this.assets.getTexture('vfx_flare');
    for (let i = 0; i < 6; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex ?? null,
        color: 0xfbbf24,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.position.copy(pos);
      sprite.scale.setScalar(0.18);
      this.scene.add(sprite);

      const vel = normal
        .clone()
        .multiplyScalar(2 + Math.random() * 3)
        .add(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2.5, (Math.random() - 0.5) * 3));

      this.particles.push({
        sprite,
        velocity: vel,
        age: 0,
        lifetime: 0.2 + Math.random() * 0.15,
        startScale: 0.2,
        endScale: 0.03,
        gravity: 9.8,
        baseOpacity: 0.9,
      });
    }
  }

  private spawnEmber(pos: THREE.Vector3, intensity: number): void {
    const isSmoke = Math.random() < 0.35;
    const tex = isSmoke
      ? this.assets.getTexture('vfx_smoke') ?? this.assets.getTexture('vfx_circle')
      : this.assets.getTexture('vfx_fire') ?? this.assets.getTexture('vfx_flame');

    const mat = new THREE.SpriteMaterial({
      map: tex ?? null,
      color: isSmoke ? 0x52525b : Math.random() < 0.5 ? 0xf97316 : 0xfacc15,
      transparent: true,
      opacity: isSmoke ? 0.35 : 0.85,
      blending: isSmoke ? THREE.NormalBlending : THREE.AdditiveBlending,
      depthWrite: false,
    });

    const sprite = new THREE.Sprite(mat);
    sprite.position.set(
      pos.x + (Math.random() - 0.5) * 0.35,
      pos.y + 0.15,
      pos.z + (Math.random() - 0.5) * 0.35
    );
    const scale = (isSmoke ? 0.55 : 0.35) * intensity;
    sprite.scale.setScalar(scale);
    this.scene.add(sprite);

    this.particles.push({
      sprite,
      velocity: new THREE.Vector3(
        (Math.random() - 0.5) * 0.45,
        (isSmoke ? 1.4 : 1.9) * intensity,
        (Math.random() - 0.5) * 0.45
      ),
      age: 0,
      lifetime: isSmoke ? 1.1 : 0.55 + Math.random() * 0.35,
      startScale: scale,
      endScale: isSmoke ? scale * 2.1 : scale * 0.2,
      gravity: -0.3,
      baseOpacity: isSmoke ? 0.32 : 0.85,
    });
  }

  public update(dt: number, elapsed: number): void {
    if (this.muzzleLightTimer > 0) {
      this.muzzleLightTimer -= dt;
      if (this.muzzleLightTimer <= 0) {
        this.muzzleLight.intensity = 0;
      }
    }

    // Drift ambient dust
    if (this.dustPoints) {
      this.dustPoints.rotation.y = elapsed * 0.012;
      this.dustPoints.position.y = Math.sin(elapsed * 0.4) * 0.25;
    }

    // Fire emitters
    for (const emitter of this.fireEmitters) {
      emitter.timer -= dt;
      if (emitter.timer <= 0) {
        emitter.timer = 0.08 + Math.random() * 0.06;
        this.spawnEmber(emitter.position, emitter.intensity);
      }
    }

    // Update particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      if (p.age >= p.lifetime) {
        this.scene.remove(p.sprite);
        p.sprite.material.dispose();
        this.particles.splice(i, 1);
        continue;
      }
      const t = p.age / p.lifetime;
      p.velocity.y -= p.gravity * dt;
      p.sprite.position.addScaledVector(p.velocity, dt);
      const scale = THREE.MathUtils.lerp(p.startScale, p.endScale, t);
      p.sprite.scale.setScalar(scale);
      p.sprite.material.opacity = p.baseOpacity * (1 - t);
    }

    // Update tracers
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i];
      tr.age += dt;
      if (tr.age >= tr.lifetime) {
        this.scene.remove(tr.mesh);
        tr.mesh.geometry.dispose();
        (tr.mesh.material as THREE.Material).dispose();
        this.tracers.splice(i, 1);
      } else {
        (tr.mesh.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - tr.age / tr.lifetime);
      }
    }

    // Update shell casings
    for (let i = this.casings.length - 1; i >= 0; i--) {
      const c = this.casings[i];
      c.age += dt;
      if (c.age >= c.lifetime) {
        this.scene.remove(c.mesh);
        this.casings.splice(i, 1);
        continue;
      }
      c.velocity.y -= 14 * dt;
      c.mesh.position.addScaledVector(c.velocity, dt);
      c.mesh.rotation.x += c.angVel.x * dt;
      c.mesh.rotation.y += c.angVel.y * dt;
      if (c.mesh.position.y < 0.03) {
        c.mesh.position.y = 0.03;
        c.velocity.y = Math.abs(c.velocity.y) * 0.4;
        c.velocity.x *= 0.65;
        c.velocity.z *= 0.65;
        c.angVel.multiplyScalar(0.5);
      }
    }
  }
}
