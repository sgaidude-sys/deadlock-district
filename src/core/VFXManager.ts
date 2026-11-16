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
  landed: boolean;
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
const RAIN_COUNT = 2600;
const RAIN_RANGE = 40;
const RAIN_HEIGHT = 18;

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
  /** Persistent light reused for every explosion (adding/removing lights forces shader recompiles). */
  private blastLight: THREE.PointLight;
  private blastLightLevel = 0;
  private scorches: THREE.Mesh[] = [];
  private scorchGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private onCasingLand?: (pos: THREE.Vector3) => void;
  private casingSoundCooldown = 0;

  // Rain: streaks that wrap around the camera, plus short-lived splash rings on the ground
  private rain: THREE.LineSegments;
  private rainMat: THREE.LineBasicMaterial;
  private rainAmount = 0;
  private splashes: THREE.InstancedMesh;
  private splashLife: Float32Array;
  private splashCursor = 0;

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
    this.blastLight = new THREE.PointLight(0xff8a3a, 0, 28, 1.6);
    this.scene.add(this.blastLight);

    // Rain streaks (always in the scene so its shader is compiled up front; opacity 0 when dry)
    const rainPos = new Float32Array(RAIN_COUNT * 6);
    for (let i = 0; i < RAIN_COUNT; i++) {
      const x = (Math.random() - 0.5) * RAIN_RANGE;
      const y = Math.random() * RAIN_HEIGHT;
      const z = (Math.random() - 0.5) * RAIN_RANGE;
      rainPos.set([x, y, z, x + 0.05, y + 0.55, z + 0.02], i * 6);
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
    this.rainMat = new THREE.LineBasicMaterial({ color: 0xaec4d8, transparent: true, opacity: 0, depthWrite: false });
    this.rain = new THREE.LineSegments(rainGeo, this.rainMat);
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);

    const splashMat = new THREE.MeshBasicMaterial({
      color: 0xc8d8e8,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.splashes = new THREE.InstancedMesh(new THREE.RingGeometry(0.03, 0.06, 10).rotateX(-Math.PI / 2), splashMat, 120);
    this.splashes.frustumCulled = false;
    this.splashLife = new Float32Array(120);
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < 120; i++) this.splashes.setMatrixAt(i, hidden);
    this.scene.add(this.splashes);

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

  /** Random texture from the given keys (Brackeys sprites), falling back to the soft circle. */
  private tex(...keys: string[]): THREE.Texture {
    const found = keys.map((k) => this.assets.getTexture(k)).filter((t): t is THREE.Texture => !!t);
    return found.length ? found[Math.floor(Math.random() * found.length)] : this.softTex;
  }

  public setOnCasingLand(cb: (pos: THREE.Vector3) => void): void {
    this.onCasingLand = cb;
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

    const tex = this.tex('vfx_muzzle_01', 'vfx_muzzle_02', 'vfx_muzzle_04');
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
      map: this.tex('vfx_smoke_01', 'vfx_smoke_04', 'vfx_smoke_07'),
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
      landed: false,
    });
  }

  public spawnBloodBurst(pos: THREE.Vector3, normalDir: THREE.Vector3, count = 10): void {
    const tex = this.tex('vfx_dirt_01', 'vfx_dirt_03');
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
    const tex = this.tex('vfx_spark_01', 'vfx_spark_04');
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
    decal.position.set(pos.x, 0.07, pos.z);
    decal.rotation.y = Math.random() * Math.PI * 2;
    decal.scale.setScalar(0.45 + Math.random() * 0.35);
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
      ? this.tex('vfx_smoke_01', 'vfx_smoke_04')
      : this.tex('vfx_flame_02', 'vfx_flame_03', 'vfx_flame_05', 'vfx_fire_01');

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

  /** Big fiery explosion: flash, fireball, sparks, debris, rising smoke and a scorch mark. */
  public spawnExplosion(pos: THREE.Vector3, scale = 1): void {
    this.blastLight.position.copy(pos).add(new THREE.Vector3(0, 1.2, 0));
    this.blastLightLevel = 1;

    const add = (
      tex: THREE.Texture,
      color: number,
      p: THREE.Vector3,
      vel: THREE.Vector3,
      s0: number,
      s1: number,
      life: number,
      opacity: number,
      additive: boolean,
      gravity = 0,
      drag = 0
    ) => {
      const mat = new THREE.SpriteMaterial({
        map: tex,
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        rotation: Math.random() * Math.PI * 2,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.position.copy(p);
      sprite.scale.setScalar(s0);
      this.scene.add(sprite);
      this.particles.push({ sprite, velocity: vel, age: 0, lifetime: life, startScale: s0, endScale: s1, gravity, baseOpacity: opacity, drag });
    };
    const rnd = (k: number) => (Math.random() - 0.5) * k;

    // Core flash
    add(this.tex('vfx_star_06'), 0xffe2a8, pos.clone().setY(pos.y + 1), new THREE.Vector3(), 1.4 * scale, 4.5 * scale, 0.14, 0.9, true);
    // Fireball
    for (let i = 0; i < 14; i++) {
      const dir = new THREE.Vector3(rnd(2), Math.random() * 1.4 + 0.2, rnd(2)).normalize();
      add(
        this.tex('vfx_flame_02', 'vfx_flame_03', 'vfx_flame_05', 'vfx_fire_01'),
        [0xffb347, 0xff7a1a, 0xffd36b][i % 3],
        pos.clone().add(new THREE.Vector3(rnd(0.6), 0.6 + Math.random() * 0.6, rnd(0.6))),
        dir.multiplyScalar((3 + Math.random() * 4) * scale),
        (0.8 + Math.random() * 0.8) * scale,
        (2.2 + Math.random() * 1.5) * scale,
        0.45 + Math.random() * 0.3,
        0.95,
        true,
        -1.5,
        3
      );
    }
    // Sparks & debris
    for (let i = 0; i < 26; i++) {
      const dir = new THREE.Vector3(rnd(2), Math.random() * 1.2 + 0.4, rnd(2)).normalize();
      add(
        this.tex('vfx_spark_01', 'vfx_spark_04'),
        i % 4 === 0 ? 0x3a3530 : 0xffc56b,
        pos.clone().setY(pos.y + 0.8),
        dir.multiplyScalar((7 + Math.random() * 9) * scale),
        i % 4 === 0 ? 0.25 : 0.18,
        0.05,
        0.7 + Math.random() * 0.6,
        1,
        i % 4 !== 0,
        14
      );
    }
    // Rolling smoke column
    for (let i = 0; i < 12; i++) {
      add(
        this.tex('vfx_smoke_01', 'vfx_smoke_04', 'vfx_smoke_07'),
        i < 4 ? 0x2b2622 : 0x4a4540,
        pos.clone().add(new THREE.Vector3(rnd(1.5), 0.8 + Math.random(), rnd(1.5))),
        new THREE.Vector3(rnd(1.2), 1.5 + Math.random() * 2, rnd(1.2)).multiplyScalar(scale),
        (1.4 + Math.random()) * scale,
        (4.5 + Math.random() * 2.5) * scale,
        2.5 + Math.random() * 2,
        0.55,
        false,
        -0.25,
        0.6
      );
    }
    // Ground shockwave ring
    add(this.tex('vfx_circle_05'), 0xffd9a0, pos.clone().setY(0.3), new THREE.Vector3(), 0.5, 9 * scale, 0.3, 0.6, true);
    this.spawnScorch(pos, 3.2 * scale);
  }

  /** Persistent burn mark on the ground (capped). */
  public spawnScorch(pos: THREE.Vector3, size: number): void {
    const mat = new THREE.MeshBasicMaterial({
      map: this.tex('vfx_scorch_01', 'vfx_scorch_02'),
      color: 0x000000,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    const m = new THREE.Mesh(this.scorchGeo, mat);
    m.position.set(pos.x, pos.y < -5 ? pos.y : 0.075, pos.z); // (shader warm-up spawns far below the map)
    m.rotation.y = Math.random() * Math.PI * 2;
    m.scale.setScalar(size);
    m.renderOrder = 1;
    this.scene.add(m);
    this.scorches.push(m);
    if (this.scorches.length > 16) {
      const old = this.scorches.shift()!;
      this.scene.remove(old);
      (old.material as THREE.Material).dispose();
    }
  }

  /** Soft additive glow for a light source (street lamps, fire). Returns it so callers can dim it. */
  public createGlow(pos: THREE.Vector3, color: number, size: number): THREE.Sprite {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.tex('vfx_light_01'),
        color,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    sprite.position.copy(pos);
    sprite.scale.setScalar(size);
    this.scene.add(sprite);
    return sprite;
  }

  public setRain(amount: number): void {
    this.rainAmount = THREE.MathUtils.clamp(amount, 0, 1);
  }

  private updateRain(dt: number, focus: THREE.Vector3): void {
    this.rainMat.opacity = 0.24 * this.rainAmount;
    if (this.rainAmount <= 0.01) return;
    const pos = this.rain.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = pos.array as Float32Array;
    const fall = 22 * dt;
    const drift = 3 * dt;
    const half = RAIN_RANGE / 2;
    for (let i = 0; i < RAIN_COUNT; i++) {
      const o = i * 6;
      let x = a[o] + drift;
      let y = a[o + 1] - fall;
      let z = a[o + 2];
      if (y < 0) y += RAIN_HEIGHT;
      if (x - focus.x > half) x -= RAIN_RANGE;
      else if (x - focus.x < -half) x += RAIN_RANGE;
      if (z - focus.z > half) z -= RAIN_RANGE;
      else if (z - focus.z < -half) z += RAIN_RANGE;
      a[o] = x;
      a[o + 1] = y;
      a[o + 2] = z;
      a[o + 3] = x + 0.08;
      a[o + 4] = y + 0.55;
      a[o + 5] = z + 0.02;
    }
    pos.needsUpdate = true;

    // Splash rings near the player
    const m = new THREE.Matrix4();
    const spawn = Math.floor(90 * this.rainAmount * dt + Math.random());
    for (let k = 0; k < spawn; k++) {
      const i = this.splashCursor++ % this.splashLife.length;
      this.splashLife[i] = 0.35;
      m.makeTranslation(focus.x + (Math.random() - 0.5) * 16, 0.08, focus.z + (Math.random() - 0.5) * 16);
      this.splashes.setMatrixAt(i, m);
    }
    const tmp = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    for (let i = 0; i < this.splashLife.length; i++) {
      if (this.splashLife[i] <= 0) continue;
      this.splashLife[i] -= dt;
      this.splashes.getMatrixAt(i, m);
      m.decompose(tmp, q, sc);
      const t = Math.max(0, this.splashLife[i]) / 0.35;
      const s = t > 0 ? 0.6 + (1 - t) * 1.8 : 0;
      m.compose(tmp, q, sc.set(s, s, s));
      this.splashes.setMatrixAt(i, m);
    }
    this.splashes.instanceMatrix.needsUpdate = true;
  }

  public update(dt: number, elapsed: number, focus?: THREE.Vector3): void {
    this.casingSoundCooldown = Math.max(0, this.casingSoundCooldown - dt);
    if (this.blastLightLevel > 0) {
      this.blastLightLevel = Math.max(0, this.blastLightLevel - dt * 2.2);
      this.blastLight.intensity = 40 * this.blastLightLevel * this.blastLightLevel;
    }
    if (focus) this.updateRain(dt, focus);
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
      if (c.mesh.position.y < 0.08) {
        if (!c.landed) {
          c.landed = true;
          if (this.casingSoundCooldown <= 0) {
            this.casingSoundCooldown = 0.07;
            this.onCasingLand?.(c.mesh.position);
          }
        }
        c.mesh.position.y = 0.08;
        c.velocity.y = Math.abs(c.velocity.y) * 0.4;
        c.velocity.x *= 0.65;
        c.velocity.z *= 0.65;
        c.angVel.multiplyScalar(0.5);
      }
    }
  }
}
