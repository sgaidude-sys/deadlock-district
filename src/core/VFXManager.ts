import * as THREE from 'three';
import { AssetManager } from './AssetManager';
import type { Surface } from './AudioManager';

interface PooledParticle {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  velocity: THREE.Vector3;
  age: number;
  lifetime: number;
  startScale: number;
  endScale: number;
  gravity: number;
  baseOpacity: number;
  drag: number;
  rotSpeed: number;
  active: boolean;
}

interface PooledTracer {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
  lifetime: number;
  active: boolean;
}

interface SlashArc {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
  lifetime: number;
  active: boolean;
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

interface FogWisp {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  basePos: THREE.Vector3;
  speed: number;
  phase: number;
  scale: number;
}

export interface ObjectiveMarker {
  group: THREE.Group;
  setActive(active: boolean): void;
}

const PARTICLE_POOL_SIZE = 320;
const TRACER_POOL_SIZE = 32;
const SLASH_POOL_SIZE = 4;
const FOG_WISP_COUNT = 22;
const ASH_COUNT = 700;
const ASH_RANGE = 46;
const RAIN_COUNT = 2600;
const RAIN_RANGE = 40;
const RAIN_HEIGHT = 18;

export class VFXManager {
  private scene: THREE.Scene;
  private assets: AssetManager;

  private pool: PooledParticle[] = [];
  private poolCursor = 0;
  private tracerPool: PooledTracer[] = [];
  private tracerCursor = 0;
  private slashPool: SlashArc[] = [];
  private slashCursor = 0;

  private casings: ShellCasing[] = [];
  private fireEmitters: FireEmitter[] = [];
  private fogWisps: FogWisp[] = [];
  private decals: THREE.Object3D[] = [];
  private bulletHoles: THREE.Mesh[] = [];
  private markers: { group: THREE.Group; beam: THREE.Mesh; glow: THREE.Sprite; phase: number }[] = [];

  private muzzleLight: THREE.PointLight;
  private muzzleLightTimer = 0;
  /** Persistent light reused for every explosion (adding/removing lights forces shader recompiles). */
  private blastLight: THREE.PointLight;
  private blastLightLevel = 0;
  private scorches: THREE.Mesh[] = [];
  private scorchGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private holeGeo = new THREE.PlaneGeometry(0.14, 0.14);
  private holeMatDark: THREE.MeshBasicMaterial;
  private holeMatMetal: THREE.MeshBasicMaterial;

  private onCasingLand?: (pos: THREE.Vector3) => void;
  private casingSoundCooldown = 0;

  // Rain: streaks that wrap around the camera, plus short-lived splash rings on the ground
  private rain: THREE.LineSegments;
  private rainMat: THREE.LineBasicMaterial;
  private rainAmount = 0;
  private nightAmount = 0;
  private highQuality = true;
  private splashes: THREE.InstancedMesh;
  private splashLife: Float32Array;
  private splashCursor = 0;

  private softTex: THREE.Texture;
  private ash: THREE.Points;
  private ashVel: Float32Array;

  private tracerGeo = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true).rotateX(Math.PI / 2);
  private slashGeo = new THREE.RingGeometry(0.55, 1.35, 18, 1, -Math.PI * 0.42, Math.PI * 0.84).rotateX(-Math.PI / 2);
  private casingGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.045, 6);
  private casingMat = new THREE.MeshStandardMaterial({
    color: 0xe3b354,
    metalness: 0.9,
    roughness: 0.22,
  });

  // Scratch vectors to avoid per-frame allocations
  private tmpMat4 = new THREE.Matrix4();
  private tmpVec3 = new THREE.Vector3();
  private tmpQuat = new THREE.Quaternion();
  private tmpScale = new THREE.Vector3();

  constructor(scene: THREE.Scene, assets: AssetManager) {
    this.scene = scene;
    this.assets = assets;

    this.softTex = VFXManager.makeSoftCircleTexture();

    this.holeMatDark = new THREE.MeshBasicMaterial({
      map: this.softTex,
      color: 0x09090b,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
    });
    this.holeMatMetal = new THREE.MeshBasicMaterial({
      map: this.softTex,
      color: 0x2a2d33,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
    });

    this.muzzleLight = new THREE.PointLight(0xffaa44, 0, 16, 1.9);
    this.scene.add(this.muzzleLight);
    this.blastLight = new THREE.PointLight(0xff8a3a, 0, 32, 1.5);
    this.scene.add(this.blastLight);

    // Pre-allocate sprite particle pool (eliminates GC spikes during combat & explosions)
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.softTex,
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.frustumCulled = false;
      this.scene.add(sprite);
      this.pool.push({
        sprite,
        mat,
        velocity: new THREE.Vector3(),
        age: 0,
        lifetime: 1,
        startScale: 1,
        endScale: 1,
        gravity: 0,
        baseOpacity: 1,
        drag: 0,
        rotSpeed: 0,
        active: false,
      });
    }

    // Pre-allocate bullet tracer pool
    for (let i = 0; i < TRACER_POOL_SIZE; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffe9a8,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.tracerGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.tracerPool.push({ mesh, mat, age: 0, lifetime: 0.06, active: false });
    }

    // Pre-allocate melee slash arc pool
    for (let i = 0; i < SLASH_POOL_SIZE; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xfef3c7,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.slashGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.slashPool.push({ mesh, mat, age: 0, lifetime: 0.16, active: false });
    }

    // Drifting low-lying ground fog wisps for nocturnal & stormy depth
    for (let i = 0; i < FOG_WISP_COUNT; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.softTex,
        color: 0x9aa9bc,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      const scale = 6 + (i % 5) * 2.2;
      sprite.scale.set(scale * 1.4, scale * 0.55, 1);
      const basePos = new THREE.Vector3((Math.random() - 0.5) * 90, 0.7 + Math.random() * 0.7, (Math.random() - 0.5) * 90);
      sprite.position.copy(basePos);
      this.scene.add(sprite);
      this.fogWisps.push({
        sprite,
        mat,
        basePos,
        speed: 0.5 + Math.random() * 0.8,
        phase: Math.random() * Math.PI * 2,
        scale,
      });
    }

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
      opacity: 0.18,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.splashes = new THREE.InstancedMesh(new THREE.RingGeometry(0.03, 0.06, 10).rotateX(-Math.PI / 2), splashMat, 120);
    this.splashes.frustumCulled = false;
    this.splashLife = new Float32Array(120);
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < 120; i++) this.splashes.setMatrixAt(i, hidden);
    this.scene.add(this.splashes);

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
        size: 0.095,
        map: this.softTex,
        color: 0xd4cdc3,
        transparent: true,
        opacity: 0.58,
        depthWrite: false,
      })
    );
    this.ash.frustumCulled = false;
    this.scene.add(this.ash);
  }

  public setQuality(high: boolean): void {
    this.highQuality = high;
    this.ash.visible = true;
    for (let i = 0; i < this.fogWisps.length; i++) {
      this.fogWisps[i].sprite.visible = high || i % 2 === 0;
    }
  }

  public setAtmosphere(nightAmount: number, rainAmount: number): void {
    this.nightAmount = THREE.MathUtils.clamp(nightAmount, 0, 1);
    this.rainAmount = THREE.MathUtils.clamp(rainAmount, 0, 1);
  }

  /** Acquires a particle slot from the fixed pool without heap allocation. */
  private emit(
    tex: THREE.Texture,
    color: number,
    pos: THREE.Vector3,
    vel: THREE.Vector3,
    startScale: number,
    endScale: number,
    lifetime: number,
    opacity: number,
    additive: boolean,
    gravity = 0,
    drag = 0,
    rotSpeed = 0
  ): void {
    // Search briefly for an inactive slot, otherwise overwrite oldest at cursor
    let p = this.pool[this.poolCursor];
    for (let tries = 0; tries < 16; tries++) {
      const idx = (this.poolCursor + tries) % PARTICLE_POOL_SIZE;
      if (!this.pool[idx].active) {
        p = this.pool[idx];
        this.poolCursor = (idx + 1) % PARTICLE_POOL_SIZE;
        break;
      }
      if (tries === 15) {
        this.poolCursor = (this.poolCursor + 1) % PARTICLE_POOL_SIZE;
      }
    }

    p.active = true;
    p.age = 0;
    p.lifetime = lifetime;
    p.startScale = startScale;
    p.endScale = endScale;
    p.gravity = gravity;
    p.baseOpacity = opacity;
    p.drag = drag;
    p.rotSpeed = rotSpeed;
    p.velocity.copy(vel);

    p.mat.map = tex;
    p.mat.color.setHex(color);
    p.mat.opacity = opacity;
    const blend = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    if (p.mat.blending !== blend) {
      p.mat.blending = blend;
      p.mat.needsUpdate = true;
    }
    p.mat.rotation = Math.random() * Math.PI * 2;
    p.sprite.position.copy(pos);
    p.sprite.scale.setScalar(startScale);
    p.sprite.visible = true;
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
    grad.addColorStop(0.35, 'rgba(255,255,255,0.72)');
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
    geo.translate(0, -8, 0);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color(0xfff1c9) },
        uOpacity: { value: 0.11 },
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
          vec3 viewDir = normalize(vViewPos + vec3(0.0, 0.0, 1e-5));
          float fresnel = pow(max(abs(dot(normalize(vNormalView + vec3(0.0, 1e-5, 0.0)), viewDir)), 0.0001), 1.6);
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

  /** Vertical light shaft + glow used to mark objectives (no real lights -> no shader recompiles). */
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
        void main(){ float a = pow(max(1.0 - vUv.y, 0.0001), 1.6) * (0.55 + 0.45 * sin(vUv.x * 6.2831)); gl_FragColor = vec4(uColor, a * uOpacity); }`,
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
    this.muzzleLight.intensity = big ? 11 : 7.5;
    this.muzzleLightTimer = big ? 0.07 : 0.055;

    const tex = this.tex('vfx_muzzle_01', 'vfx_muzzle_02', 'vfx_muzzle_04');
    const s = big ? 0.98 : 0.64;
    this.emit(
      tex,
      0xffcf6e,
      origin.clone().addScaledVector(direction, 0.12),
      direction.clone().multiplyScalar(2),
      s,
      s * 0.28,
      0.06,
      0.95,
      true
    );

    // Hot incandescent core star + fast sparks on heavy weapons
    if (big) {
      this.emit(this.tex('vfx_star_06'), 0xfff3cc, origin.clone().addScaledVector(direction, 0.1), new THREE.Vector3(), 0.7, 0.15, 0.055, 0.9, true);
      for (let i = 0; i < 4; i++) {
        const sv = direction
          .clone()
          .multiplyScalar(5 + Math.random() * 4)
          .add(new THREE.Vector3((Math.random() - 0.5) * 2.4, (Math.random() - 0.5) * 1.8, (Math.random() - 0.5) * 2.4));
        this.emit(this.tex('vfx_spark_01', 'vfx_spark_04'), 0xffc864, origin, sv, 0.14, 0.03, 0.14, 0.9, true, 8);
      }
    }

    // Lingering gun smoke
    this.spawnPuff(
      origin.clone().addScaledVector(direction, 0.25),
      direction.clone().multiplyScalar(0.85),
      0xa1a8b3,
      0.18,
      big ? 1.05 : 0.6,
      0.26,
      0.75
    );
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
    this.emit(
      this.tex('vfx_smoke_01', 'vfx_smoke_04', 'vfx_smoke_07'),
      color,
      pos,
      vel.clone().add(new THREE.Vector3(0, 0.35, 0)),
      startScale,
      endScale,
      lifetime,
      opacity,
      false,
      -0.2,
      2.2,
      (Math.random() - 0.5) * 1.2
    );
  }

  /** Footstep dust/mud/water spray under the player's boots. */
  public spawnFootstepPuff(pos: THREE.Vector3, surface: Surface, wetness: number, sprinting: boolean): void {
    if (!this.highQuality && !sprinting) return;
    const basePos = pos.clone().setY(0.11);
    if (wetness > 0.28 && surface !== 'wood') {
      // Wet asphalt / puddle spray
      const count = sprinting ? 4 : 2;
      for (let i = 0; i < count; i++) {
        this.emit(
          this.softTex,
          0xc8d9ea,
          basePos,
          new THREE.Vector3((Math.random() - 0.5) * 1.4, 0.7 + Math.random() * 1.1, (Math.random() - 0.5) * 1.4),
          0.08,
          0.22,
          0.28,
          0.35 * wetness,
          false,
          7.5,
          1.2
        );
      }
      return;
    }
    const color = surface === 'grass' ? 0x5c6844 : surface === 'wood' ? 0x8b7258 : 0x9c9891;
    this.emit(
      this.tex('vfx_smoke_01', 'vfx_dirt_01'),
      color,
      basePos,
      new THREE.Vector3((Math.random() - 0.5) * 0.5, 0.25 + (sprinting ? 0.25 : 0), (Math.random() - 0.5) * 0.5),
      sprinting ? 0.18 : 0.11,
      sprinting ? 0.55 : 0.32,
      sprinting ? 0.48 : 0.34,
      sprinting ? 0.28 : 0.16,
      false,
      0.2,
      2.5
    );
  }

  /** Air & dust burst kicked up on tactical dodge dash. */
  public spawnDodgeBurst(pos: THREE.Vector3, moveDir: THREE.Vector3): void {
    const p = pos.clone().setY(0.25);
    const back = moveDir.clone().negate();
    for (let i = 0; i < 6; i++) {
      const vel = back
        .clone()
        .multiplyScalar(1.4 + Math.random() * 1.8)
        .add(new THREE.Vector3((Math.random() - 0.5) * 1.3, 0.35 + Math.random() * 0.6, (Math.random() - 0.5) * 1.3));
      this.emit(this.tex('vfx_smoke_01', 'vfx_smoke_04'), 0xb8b2a8, p, vel, 0.25, 0.95, 0.45, 0.32, false, -0.1, 2.4);
    }
  }

  /** Translucent crescent slash arc for Fire Axe melee swings. */
  public spawnMeleeSlash(origin: THREE.Vector3, forward: THREE.Vector3): void {
    const arc = this.slashPool[this.slashCursor];
    this.slashCursor = (this.slashCursor + 1) % SLASH_POOL_SIZE;
    arc.active = true;
    arc.age = 0;
    arc.lifetime = 0.16;
    arc.mesh.position.copy(origin).add(new THREE.Vector3(0, 0.95, 0)).addScaledVector(forward, 0.35);
    arc.mesh.rotation.set(0.18, Math.atan2(forward.x, forward.z), (Math.random() - 0.5) * 0.3);
    arc.mesh.scale.setScalar(0.85);
    arc.mat.opacity = 0.72;
    arc.mesh.visible = true;
  }

  /** Flying wood splinters + dust when barricades are hammered, pounded, or shattered. */
  public spawnWoodSplinters(pos: THREE.Vector3, normal: THREE.Vector3, count = 8, isMetal = false): void {
    const tex = isMetal ? this.tex('vfx_spark_01', 'vfx_spark_04') : this.tex('vfx_dirt_01', 'vfx_dirt_03');
    for (let i = 0; i < count; i++) {
      const vel = normal
        .clone()
        .multiplyScalar(1.5 + Math.random() * 2.8)
        .add(new THREE.Vector3((Math.random() - 0.5) * 2.6, 0.9 + Math.random() * 2.2, (Math.random() - 0.5) * 2.6));
      this.emit(
        tex,
        isMetal ? 0xfbbf24 : i % 2 === 0 ? 0x9c6e44 : 0x5c3e24,
        pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4)),
        vel,
        0.13 + Math.random() * 0.12,
        0.05,
        0.4 + Math.random() * 0.25,
        0.92,
        isMetal,
        12,
        0.5,
        (Math.random() - 0.5) * 8
      );
    }
    this.spawnPuff(pos, normal.clone().multiplyScalar(0.7), isMetal ? 0xcbd5e1 : 0xa38b72, 0.2, 0.75, 0.32, 0.55);
  }

  /** Subtle rising sparkle burst on item pickup or healing. */
  public spawnPickupBurst(pos: THREE.Vector3, colorHex: number): void {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const vel = new THREE.Vector3(Math.cos(a) * 0.9, 1.4 + Math.random() * 1.1, Math.sin(a) * 0.9);
      this.emit(this.tex('vfx_star_06', 'vfx_light_01'), colorHex, pos.clone().setY(pos.y + 0.4), vel, 0.2, 0.04, 0.55, 0.85, true, -0.4, 1.4);
    }
  }

  public spawnTracer(start: THREE.Vector3, end: THREE.Vector3): void {
    const dist = start.distanceTo(end);
    if (dist < 0.3) return;
    const tr = this.tracerPool[this.tracerCursor];
    this.tracerCursor = (this.tracerCursor + 1) % TRACER_POOL_SIZE;
    tr.active = true;
    tr.age = 0;
    tr.lifetime = 0.06;
    tr.mat.opacity = 0.85;
    tr.mesh.position.copy(start).lerp(end, 0.5);
    tr.mesh.scale.set(0.013, 0.013, dist);
    tr.mesh.lookAt(end);
    tr.mesh.visible = true;
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
    const n = this.highQuality ? count : Math.max(4, Math.round(count * 0.6));
    for (let i = 0; i < n; i++) {
      const scale = 0.14 + Math.random() * 0.22;
      const vel = normalDir
        .clone()
        .multiplyScalar(1.6 + Math.random() * 3.1)
        .add(new THREE.Vector3((Math.random() - 0.5) * 2.6, 0.8 + Math.random() * 2.2, (Math.random() - 0.5) * 2.6));
      this.emit(
        i % 2 === 0 ? tex : this.softTex,
        i % 3 === 0 ? 0x5b0a0a : 0x9b1111,
        pos,
        vel,
        scale,
        scale * 1.6,
        0.35 + Math.random() * 0.3,
        0.95,
        false,
        12,
        0.6
      );
    }
    // Crimson aerosol mist
    this.spawnPuff(pos.clone(), normalDir.clone().multiplyScalar(0.6), 0x7f1d1d, 0.25, 0.95, 0.45, 0.48);
  }

  public spawnImpactSparks(pos: THREE.Vector3, normal: THREE.Vector3, isMetal = false): void {
    const tex = this.tex('vfx_spark_01', 'vfx_spark_04');
    const count = isMetal ? 9 : 6;
    for (let i = 0; i < count; i++) {
      const vel = normal
        .clone()
        .multiplyScalar((isMetal ? 3.2 : 2) + Math.random() * 3.2)
        .add(new THREE.Vector3((Math.random() - 0.5) * 3.2, Math.random() * 2.6, (Math.random() - 0.5) * 3.2));
      this.emit(tex, isMetal ? 0xffe082 : 0xfbbf24, pos, vel, 0.18, 0.03, 0.18 + Math.random() * 0.16, 0.92, true, 9.8);
    }
    this.spawnPuff(pos.clone().addScaledVector(normal, 0.05), normal.clone().multiplyScalar(0.9), isMetal ? 0x94a3b8 : 0xa8a29e, 0.15, 0.72, 0.4, 0.6);
    this.spawnBulletHole(pos, normal, isMetal);
  }

  /** Persistent bullet impact decal oriented flush against walls, streets, or vehicles (capped). */
  public spawnBulletHole(pos: THREE.Vector3, normal: THREE.Vector3, isMetal = false): void {
    if (pos.y < -5) return; // ignore shader warm-up
    const mesh = new THREE.Mesh(this.holeGeo, isMetal ? this.holeMatMetal : this.holeMatDark);
    mesh.position.copy(pos).addScaledVector(normal, 0.015);
    mesh.lookAt(pos.clone().add(normal));
    mesh.rotateZ(Math.random() * Math.PI * 2);
    mesh.scale.setScalar(0.85 + Math.random() * 0.45);
    mesh.renderOrder = 2;
    this.scene.add(mesh);
    this.bulletHoles.push(mesh);
    if (this.bulletHoles.length > 48) {
      this.scene.remove(this.bulletHoles.shift()!);
    }
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
    const scale = (isSmoke ? 0.55 : 0.36) * intensity;
    const p = new THREE.Vector3(pos.x + (Math.random() - 0.5) * 0.35, pos.y + 0.15, pos.z + (Math.random() - 0.5) * 0.35);
    const vel = new THREE.Vector3((Math.random() - 0.5) * 0.45, (isSmoke ? 1.4 : 1.95) * intensity, (Math.random() - 0.5) * 0.45);
    this.emit(
      tex,
      isSmoke ? 0x3f3f46 : Math.random() < 0.5 ? 0xf97316 : 0xfacc15,
      p,
      vel,
      scale,
      isSmoke ? scale * 2.6 : scale * 0.2,
      isSmoke ? 1.4 : 0.55 + Math.random() * 0.35,
      isSmoke ? 0.32 : 0.88,
      !isSmoke,
      -0.3
    );

    // Occasional floating glowing ember cinder
    if (Math.random() < 0.28) {
      this.emit(
        this.tex('vfx_spark_01'),
        0xffa733,
        p,
        new THREE.Vector3((Math.random() - 0.5) * 1.1, 2.2 + Math.random() * 1.4, (Math.random() - 0.5) * 1.1),
        0.1,
        0.02,
        1.1 + Math.random() * 0.6,
        0.95,
        true,
        -0.4,
        0.4
      );
    }
  }

  /** Big fiery explosion: flash, fireball, sparks, debris, rising smoke and a scorch mark. */
  public spawnExplosion(pos: THREE.Vector3, scale = 1): void {
    this.blastLight.position.copy(pos).add(new THREE.Vector3(0, 1.2, 0));
    this.blastLightLevel = 1;
    const rnd = (k: number) => (Math.random() - 0.5) * k;

    // Core flash
    this.emit(this.tex('vfx_star_06'), 0xffe2a8, pos.clone().setY(pos.y + 1), new THREE.Vector3(), 1.5 * scale, 4.8 * scale, 0.14, 0.95, true);

    // Fireball
    for (let i = 0; i < 14; i++) {
      const dir = new THREE.Vector3(rnd(2), Math.random() * 1.4 + 0.2, rnd(2)).normalize();
      this.emit(
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
    for (let i = 0; i < 24; i++) {
      const dir = new THREE.Vector3(rnd(2), Math.random() * 1.2 + 0.4, rnd(2)).normalize();
      this.emit(
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
      this.emit(
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
        0.6,
        (Math.random() - 0.5) * 0.9
      );
    }

    // Ground shockwave ring
    this.emit(this.tex('vfx_circle_05'), 0xffd9a0, pos.clone().setY(0.3), new THREE.Vector3(), 0.5, 9.5 * scale, 0.3, 0.65, true);
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
    m.position.set(pos.x, pos.y < -5 ? pos.y : 0.075, pos.z);
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
    this.rainMat.opacity = 0.25 * this.rainAmount;
    if (this.rainAmount <= 0.01) return;
    const pos = this.rain.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = pos.array as Float32Array;
    const fall = 22 * dt;
    const drift = 3 * dt;
    const half = RAIN_RANGE / 2;
    const count = this.highQuality ? RAIN_COUNT : Math.floor(RAIN_COUNT * 0.5);
    for (let i = 0; i < count; i++) {
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
    const m = this.tmpMat4;
    const spawn = Math.floor((this.highQuality ? 95 : 45) * this.rainAmount * dt + Math.random());
    for (let k = 0; k < spawn; k++) {
      const i = this.splashCursor++ % this.splashLife.length;
      this.splashLife[i] = 0.35;
      m.makeTranslation(focus.x + (Math.random() - 0.5) * 16, 0.08, focus.z + (Math.random() - 0.5) * 16);
      this.splashes.setMatrixAt(i, m);
    }
    for (let i = 0; i < this.splashLife.length; i++) {
      if (this.splashLife[i] <= 0) continue;
      this.splashLife[i] -= dt;
      this.splashes.getMatrixAt(i, m);
      m.decompose(this.tmpVec3, this.tmpQuat, this.tmpScale);
      const t = Math.max(0, this.splashLife[i]) / 0.35;
      const s = t > 0 ? 0.6 + (1 - t) * 1.8 : 0;
      m.compose(this.tmpVec3, this.tmpQuat, this.tmpScale.set(s, s, s));
      this.splashes.setMatrixAt(i, m);
    }
    this.splashes.instanceMatrix.needsUpdate = true;
  }

  public update(dt: number, elapsed: number, focus?: THREE.Vector3): void {
    this.casingSoundCooldown = Math.max(0, this.casingSoundCooldown - dt);
    if (this.blastLightLevel > 0) {
      this.blastLightLevel = Math.max(0, this.blastLightLevel - dt * 2.2);
      this.blastLight.intensity = 44 * this.blastLightLevel * this.blastLightLevel;
    }
    if (focus) this.updateRain(dt, focus);
    if (this.muzzleLightTimer > 0) {
      this.muzzleLightTimer -= dt;
      if (this.muzzleLightTimer <= 0) {
        this.muzzleLight.intensity = 0;
      }
    }

    // Drifting ground fog wisps (subtle during day, rich atmospheric blankets at dusk/night/rain)
    const fogAlpha = 0.025 + this.nightAmount * 0.055 + this.rainAmount * 0.04;
    for (let i = 0; i < this.fogWisps.length; i++) {
      const w = this.fogWisps[i];
      if (!w.sprite.visible) continue;
      w.sprite.position.x = w.basePos.x + Math.sin(elapsed * 0.14 * w.speed + w.phase) * 7;
      w.sprite.position.z = w.basePos.z + Math.cos(elapsed * 0.11 * w.speed + w.phase) * 6;
      w.mat.opacity = fogAlpha * (0.7 + 0.3 * Math.sin(elapsed * 0.4 + w.phase));
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
        emitter.timer = (this.highQuality ? 0.08 : 0.13) + Math.random() * 0.06;
        this.spawnEmber(emitter.position, emitter.intensity);
      }
    }

    // Update pooled sprite particles
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      const p = this.pool[i];
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= p.lifetime) {
        p.active = false;
        p.sprite.visible = false;
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
      if (p.rotSpeed !== 0) p.mat.rotation += p.rotSpeed * dt;
      const scale = THREE.MathUtils.lerp(p.startScale, p.endScale, t);
      p.sprite.scale.setScalar(scale);
      p.mat.opacity = p.baseOpacity * (1 - t);
    }

    // Update pooled tracers
    for (let i = 0; i < TRACER_POOL_SIZE; i++) {
      const tr = this.tracerPool[i];
      if (!tr.active) continue;
      tr.age += dt;
      if (tr.age >= tr.lifetime) {
        tr.active = false;
        tr.mesh.visible = false;
      } else {
        tr.mat.opacity = 0.85 * (1 - tr.age / tr.lifetime);
      }
    }

    // Update melee slash arcs
    for (let i = 0; i < SLASH_POOL_SIZE; i++) {
      const arc = this.slashPool[i];
      if (!arc.active) continue;
      arc.age += dt;
      if (arc.age >= arc.lifetime) {
        arc.active = false;
        arc.mesh.visible = false;
      } else {
        const t = arc.age / arc.lifetime;
        arc.mesh.rotation.y += dt * 11;
        arc.mesh.scale.setScalar(0.85 + t * 0.55);
        arc.mat.opacity = 0.72 * (1 - t);
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
