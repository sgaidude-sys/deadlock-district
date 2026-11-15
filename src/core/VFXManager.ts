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
  drag: number;
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

export interface ObjectiveMarker {
  group: THREE.Group;
  setActive(active: boolean): void;
}

const ASH_COUNT = 700;
const ASH_RANGE = 46;

export class VFXManager {
  private scene: THREE.Scene;
  private assets: AssetManager;

  private particles: Particle[] = [];
  private tracers: Tracer[] = [];
  private casings: ShellCasing[] = [];
  private fireEmitters: FireEmitter[] = [];
  private decals: THREE.Object3D[] = [];
  private markers: { group: THREE.Group; beam: THREE.Mesh; glow: THREE.Sprite; phase: number }[] = [];

  private muzzleLight: THREE.PointLight;
  private muzzleLightTimer = 0;

  private softTex: THREE.Texture;
  private ash: THREE.Points;
  private ashVel: Float32Array;

  private tracerGeo = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true).rotateX(Math.PI / 2);
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

    this.softTex = VFXManager.makeSoftCircleTexture();

    // Falling ash: a box of particles that wraps around the camera
    const positions = new Float32Array(ASH_COUNT * 3);
    this.ashVel = new Float32Array(ASH_COUNT);
    for (let i = 0; i < ASH_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * ASH_RANGE;
      positions[i * 3 + 1] = Math.random() * 14;
      positions[i * 3 + 2] = (Math.random() - 0.5) * ASH_RANGE;
      this.ashVel[i] = 0.25 + Math.random() * 0.55;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.ash = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 0.09,
        map: this.softTex,
        color: 0xc9c2b8,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      })
    );
    this.ash.frustumCulled = false;
    this.scene.add(this.ash);
  }

  /** Radial-gradient sprite texture; avoids square artefacts from hard-edged PNGs. */
  private static makeSoftCircleTexture(): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.75)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  public getSoftTexture(): THREE.Texture {
    return this.softTex;
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
        uOpacity: { value: 0.1 },
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

  /** Vertical light shaft + glow used to mark objectives (no real lights → no shader recompiles). */
  public createObjectiveMarker(pos: THREE.Vector3, colorHex: number): ObjectiveMarker {
    const group = new THREE.Group();
    group.position.copy(pos);

    const beamMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color(colorHex) }, uOpacity: { value: 0.55 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying vec2 vUv;
        void main(){ float a = pow(1.0 - vUv.y, 1.6) * (0.55 + 0.45 * sin(vUv.x * 6.2831)); gl_FragColor = vec4(uColor, a * uOpacity); }`,
    });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.42, 9, 16, 1, true), beamMat);
    beam.position.y = 4.5;
    group.add(beam);

    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.softTex,
        color: colorHex,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    glow.scale.setScalar(1.6);
    glow.position.y = 0.6;
    group.add(glow);

    this.scene.add(group);
    const entry = { group, beam, glow, phase: Math.random() * 6 };
    this.markers.push(entry);
    return {
      group,
      setActive: (active: boolean) => {
        group.visible = active;
      },
    };
  }

  public spawnMuzzleFlash(origin: THREE.Vector3, direction: THREE.Vector3, big = false): void {
    this.muzzleLight.position.copy(origin);
    this.muzzleLight.intensity = big ? 9 : 6.5;
    this.muzzleLightTimer = 0.055;

    const tex = this.assets.getTexture('vfx_flare') ?? this.softTex;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      color: 0xffc857,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      rotation: Math.random() * Math.PI,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(origin).addScaledVector(direction, 0.12);
    const s = big ? 0.9 : 0.6;
    sprite.scale.setScalar(s);
    this.scene.add(sprite);
    this.particles.push({
      sprite,
      velocity: direction.clone().multiplyScalar(2),
      age: 0,
      lifetime: 0.06,
      startScale: s,
      endScale: s * 0.3,
      gravity: 0,
      baseOpacity: 0.95,
      drag: 0,
    });

    // Lingering gun smoke
    this.spawnPuff(origin.clone().addScaledVector(direction, 0.25), direction.clone().multiplyScalar(0.8), 0x9ca3af, 0.18, big ? 0.9 : 0.55, 0.25);
  }

  private spawnPuff(
    pos: THREE.Vector3,
    vel: THREE.Vector3,
    color: number,
    startScale: number,
    endScale: number,
    opacity: number,
    lifetime = 0.7
  ): void {
    const mat = new THREE.SpriteMaterial({
      map: this.assets.getTexture('vfx_smoke') ?? this.softTex,
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      rotation: Math.random() * Math.PI * 2,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(pos);
    sprite.scale.setScalar(startScale);
    this.scene.add(sprite);
    this.particles.push({
      sprite,
      velocity: vel.add(new THREE.Vector3(0, 0.35, 0)),
      age: 0,
      lifetime,
      startScale,
      endScale,
      gravity: -0.2,
      baseOpacity: opacity,
      drag: 2.2,
    });
  }

  public spawnTracer(start: THREE.Vector3, end: THREE.Vector3): void {
    const dist = start.distanceTo(end);
    if (dist < 0.3) return;
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffe9a8,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.tracerGeo, mat);
    mesh.position.copy(start).lerp(end, 0.5);
    mesh.scale.set(0.012, 0.012, dist);
    mesh.lookAt(end);
    this.scene.add(mesh);
    this.tracers.push({ mesh, age: 0, lifetime: 0.06 });
  }

  public spawnShellCasing(origin: THREE.Vector3, rightDir: THREE.Vector3): void {
    if (this.casings.length > 40) {
      const old = this.casings.shift()!;
      this.scene.remove(old.mesh);
    }
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
    const tex = this.assets.getTexture('vfx_dirt') ?? this.softTex;
    for (let i = 0; i < count; i++) {
      const mat = new THREE.SpriteMaterial({
        map: i % 2 === 0 ? tex : this.softTex,
        color: i % 3 === 0 ? 0x5b0a0a : 0x9b1111,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        rotation: Math.random() * Math.PI * 2,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.position.copy(pos);
      const scale = 0.14 + Math.random() * 0.22;
      sprite.scale.setScalar(scale);
      this.scene.add(sprite);

      const vel = normalDir
        .clone()
        .multiplyScalar(1.5 + Math.random() * 3)
        .add(new THREE.Vector3((Math.random() - 0.5) * 2.6, 0.8 + Math.random() * 2.2, (Math.random() - 0.5) * 2.6));

      this.particles.push({
        sprite,
        velocity: vel,
        age: 0,
        lifetime: 0.35 + Math.random() * 0.3,
        startScale: scale,
        endScale: scale * 1.6,
        gravity: 12,
        baseOpacity: 0.95,
        drag: 0.6,
      });
    }
    // Fine mist
    this.spawnPuff(pos.clone(), normalDir.clone().multiplyScalar(0.6), 0x7f1d1d, 0.25, 0.9, 0.45, 0.45);
  }

  public spawnImpactSparks(pos: THREE.Vector3, normal: THREE.Vector3): void {
    const tex = this.assets.getTexture('vfx_spark') ?? this.softTex;
    for (let i = 0; i < 6; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex,
        color: 0xfbbf24,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.position.copy(pos);
      sprite.scale.setScalar(0.16);
      this.scene.add(sprite);

      const vel = normal
        .clone()
        .multiplyScalar(2 + Math.random() * 3)
        .add(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2.5, (Math.random() - 0.5) * 3));

      this.particles.push({
        sprite,
        velocity: vel,
        age: 0,
        lifetime: 0.18 + Math.random() * 0.15,
        startScale: 0.18,
        endScale: 0.03,
        gravity: 9.8,
        baseOpacity: 0.9,
        drag: 0,
      });
    }
    // Concrete dust puff
    this.spawnPuff(pos.clone().addScaledVector(normal, 0.05), normal.clone().multiplyScalar(0.9), 0xa8a29e, 0.15, 0.7, 0.4, 0.6);
  }

  /** Persistent blood pool on the ground (capped). */
  public spawnBloodDecal(pos: THREE.Vector3): void {
    const keys = ['prop_blood1', 'prop_blood2', 'prop_blood3'].filter((k) => this.assets.hasModel(k));
    if (keys.length === 0) return;
    const decal = this.assets.cloneModel(keys[Math.floor(Math.random() * keys.length)]);
    decal.position.set(pos.x, 0.035, pos.z);
    decal.rotation.y = Math.random() * Math.PI * 2;
    decal.scale.setScalar(0.9 + Math.random() * 0.6);
    decal.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = true;
    });
    this.scene.add(decal);
    this.decals.push(decal);
    if (this.decals.length > 40) {
      this.scene.remove(this.decals.shift()!);
    }
  }

  private spawnEmber(pos: THREE.Vector3, intensity: number): void {
    const isSmoke = Math.random() < 0.35;
    const tex = isSmoke
      ? this.assets.getTexture('vfx_smoke') ?? this.softTex
      : this.assets.getTexture('vfx_fire') ?? this.assets.getTexture('vfx_flame') ?? this.softTex;

    const mat = new THREE.SpriteMaterial({
      map: tex,
      color: isSmoke ? 0x3f3f46 : Math.random() < 0.5 ? 0xf97316 : 0xfacc15,
      transparent: true,
      opacity: isSmoke ? 0.35 : 0.85,
      blending: isSmoke ? THREE.NormalBlending : THREE.AdditiveBlending,
      depthWrite: false,
      rotation: Math.random() * Math.PI * 2,
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
      lifetime: isSmoke ? 1.4 : 0.55 + Math.random() * 0.35,
      startScale: scale,
      endScale: isSmoke ? scale * 2.6 : scale * 0.2,
      gravity: -0.3,
      baseOpacity: isSmoke ? 0.32 : 0.85,
      drag: 0,
    });
  }

  public update(dt: number, elapsed: number, focus?: THREE.Vector3): void {
    if (this.muzzleLightTimer > 0) {
      this.muzzleLightTimer -= dt;
      if (this.muzzleLightTimer <= 0) {
        this.muzzleLight.intensity = 0;
      }
    }

    // Falling ash wraps around the focus point
    const pos = this.ash.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const fx = focus?.x ?? 0;
    const fz = focus?.z ?? 0;
    const half = ASH_RANGE / 2;
    for (let i = 0; i < ASH_COUNT; i++) {
      const ix = i * 3;
      arr[ix] += Math.sin(elapsed * 0.6 + i) * 0.15 * dt + 0.25 * dt;
      arr[ix + 1] -= this.ashVel[i] * dt;
      arr[ix + 2] += Math.cos(elapsed * 0.5 + i * 1.3) * 0.15 * dt;
      if (arr[ix + 1] < 0) arr[ix + 1] += 14;
      if (arr[ix] - fx > half) arr[ix] -= ASH_RANGE;
      else if (arr[ix] - fx < -half) arr[ix] += ASH_RANGE;
      if (arr[ix + 2] - fz > half) arr[ix + 2] -= ASH_RANGE;
      else if (arr[ix + 2] - fz < -half) arr[ix + 2] += ASH_RANGE;
    }
    pos.needsUpdate = true;

    // Objective beacons pulse
    for (const m of this.markers) {
      if (!m.group.visible) continue;
      const pulse = 0.75 + Math.sin(elapsed * 3 + m.phase) * 0.25;
      (m.glow.material as THREE.SpriteMaterial).opacity = 0.6 * pulse + 0.2;
      m.glow.scale.setScalar(1.3 + pulse * 0.5);
      (m.beam.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 0.35 + pulse * 0.25;
      m.beam.rotation.y = elapsed * 0.6;
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
      if (p.drag > 0) p.velocity.multiplyScalar(Math.max(0, 1 - p.drag * dt));
      p.sprite.position.addScaledVector(p.velocity, dt);
      if (p.gravity > 0 && p.sprite.position.y < 0.05) {
        p.sprite.position.y = 0.05;
        p.velocity.set(0, 0, 0);
      }
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
        (tr.mesh.material as THREE.Material).dispose();
        this.tracers.splice(i, 1);
      } else {
        (tr.mesh.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - tr.age / tr.lifetime);
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
