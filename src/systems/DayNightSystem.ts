import * as THREE from 'three';
import { BurningBarrel, StreetLightNode } from '../world/CityGenerator';
import { DayPhase } from '../types/game';

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FRAG = `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uNight;
varying vec3 vDir;
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, 0.0, 1.0);
  vec3 col = mix(uHorizon, uTop, pow(h, 0.55));
  // Sun / moon glow
  float sd = max(dot(d, normalize(uSunDir)), 0.0);
  col += uSunColor * (pow(sd, 48.0) * 0.6 + pow(sd, 6.0) * 0.12) * (1.0 - uNight * 0.6);
  // Moon disc + stars at night
  float moon = smoothstep(0.9985, 0.9992, sd) * uNight;
  col = mix(col, vec3(0.86, 0.9, 1.0), moon);
  vec3 cell = floor(d * 260.0);
  float star = step(0.9975, hash(cell)) * smoothstep(0.08, 0.35, d.y) * uNight;
  col += vec3(star) * 0.9;
  // Below horizon fades to fog colour
  col = mix(uHorizon, col, smoothstep(-0.05, 0.05, d.y));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export class DayNightSystem {
  public dayNumber = 1;
  public timeOfDay = 0.22; // Start in morning
  public phase: DayPhase = 'day';

  private cycleDuration = 360; // ~4 min of light, ~2 min of night
  private sunLight: THREE.DirectionalLight;
  private hemiLight: THREE.HemisphereLight;
  private fog: THREE.FogExp2;
  private renderer: THREE.WebGLRenderer;
  private streetLights: StreetLightNode[];
  private burningBarrels: BurningBarrel[];
  private windowMaterials: THREE.MeshStandardMaterial[];

  private sky: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;

  private daySky = new THREE.Color(0x8a99a6);
  private dayTop = new THREE.Color(0x4b6a88);
  private duskSky = new THREE.Color(0xb0603e);
  private duskTop = new THREE.Color(0x3b2a4a);
  private nightSky = new THREE.Color(0x121a2a);
  private nightTop = new THREE.Color(0x03060d);

  private daySunColor = new THREE.Color(0xfff1d6);
  private duskSunColor = new THREE.Color(0xff8c42);
  private nightMoonColor = new THREE.Color(0x7d9cd6);

  private wasNight = false;
  private onNightFallCb?: () => void;
  private onDawnCb?: () => void;

  private tmpHorizon = new THREE.Color();
  private tmpTop = new THREE.Color();
  private sunDir = new THREE.Vector3();
  private moonDir = new THREE.Vector3(-0.45, 0.75, -0.35).normalize();

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    sunLight: THREE.DirectionalLight,
    hemiLight: THREE.HemisphereLight,
    fog: THREE.FogExp2,
    streetLights: StreetLightNode[],
    burningBarrels: BurningBarrel[],
    windowMaterials: THREE.MeshStandardMaterial[]
  ) {
    this.renderer = renderer;
    this.sunLight = sunLight;
    this.hemiLight = hemiLight;
    this.fog = fog;
    this.streetLights = streetLights;
    this.burningBarrels = burningBarrels;
    this.windowMaterials = windowMaterials;

    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color() },
        uNight: { value: 0 },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(200, 32, 16), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    scene.add(this.sky);
  }

  public onNightFall(cb: () => void): void {
    this.onNightFallCb = cb;
  }

  public onDawn(cb: () => void): void {
    this.onDawnCb = cb;
  }

  public isNight(): boolean {
    return this.phase === 'night';
  }

  /** 0 at full day, 1 at full night (smooth through dusk/dawn). */
  public nightFactor(): number {
    const t = this.timeOfDay;
    if (t < 0.56) return 0;
    if (t < 0.667) return (t - 0.56) / (0.667 - 0.56);
    if (t < 0.94) return 1;
    return 1 - (t - 0.94) / 0.06;
  }

  public update(dt: number, elapsed: number, focus: THREE.Vector3, cameraPos: THREE.Vector3): void {
    this.timeOfDay += dt / this.cycleDuration;
    if (this.timeOfDay >= 1) {
      this.timeOfDay -= 1;
      this.dayNumber++;
    }

    // 0.0 - 0.56: Day, 0.56 - 0.667: Dusk, 0.667 - 0.94: Night, 0.94 - 1.0: Dawn
    const t = this.timeOfDay;
    const prevPhase = this.phase;
    if (t < 0.56) this.phase = 'day';
    else if (t < 0.667) this.phase = 'dusk';
    else if (t < 0.94) this.phase = 'night';
    else this.phase = 'dawn';

    const nightNow = this.phase === 'night';
    if (nightNow && !this.wasNight) this.onNightFallCb?.();
    if (prevPhase === 'dawn' && this.phase === 'day') this.onDawnCb?.();
    this.wasNight = nightNow;

    const n = this.nightFactor();
    const duskness = this.phase === 'dusk' ? Math.sin(n * Math.PI) : this.phase === 'dawn' ? Math.sin(n * Math.PI) * 0.6 : 0;

    // Sun arcs across the sky during the light part of the cycle; moon is fixed at night.
    const arc = THREE.MathUtils.clamp(t / 0.667, 0, 1) * Math.PI;
    this.sunDir.set(Math.cos(arc), Math.max(0.12, Math.sin(arc)) * 0.95, 0.45).normalize();
    const lightDir = this.sunDir.clone().lerp(this.moonDir, n).normalize();
    this.sunLight.position.copy(focus).addScaledVector(lightDir, 70);
    this.sunLight.target.position.copy(focus);
    this.sunLight.target.updateMatrixWorld();

    // Colours
    this.tmpHorizon.copy(this.daySky).lerp(this.nightSky, n);
    this.tmpTop.copy(this.dayTop).lerp(this.nightTop, n);
    if (duskness > 0) {
      this.tmpHorizon.lerp(this.duskSky, duskness * 0.75);
      this.tmpTop.lerp(this.duskTop, duskness * 0.6);
    }
    const sunCol = this.daySunColor.clone().lerp(this.nightMoonColor, n);
    if (duskness > 0) sunCol.lerp(this.duskSunColor, duskness);

    this.sunLight.color.copy(sunCol);
    this.sunLight.intensity = THREE.MathUtils.lerp(2.3, 0.55, n);
    this.hemiLight.intensity = THREE.MathUtils.lerp(0.85, 0.32, n);
    this.hemiLight.color.copy(this.tmpTop).lerp(new THREE.Color(0xdbeafe), 0.6);
    this.fog.density = THREE.MathUtils.lerp(0.0095, 0.021, n);
    this.fog.color.copy(this.tmpHorizon);
    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(1.0, 1.25, n);

    this.skyMat.uniforms.uTop.value.copy(this.tmpTop);
    this.skyMat.uniforms.uHorizon.value.copy(this.tmpHorizon);
    this.skyMat.uniforms.uSunDir.value.copy(n > 0.5 ? this.moonDir : this.sunDir);
    this.skyMat.uniforms.uSunColor.value.copy(sunCol);
    this.skyMat.uniforms.uNight.value = n;
    this.sky.position.copy(cameraPos);

    // Streetlights: on from dusk; at night the grid browns out and some lamps die.
    const lit = THREE.MathUtils.clamp(n * 1.6, 0, 1);
    for (let i = 0; i < this.streetLights.length; i++) {
      const sl = this.streetLights[i];
      let k = lit;
      if (this.phase === 'night') {
        const flick = Math.sin(elapsed * (sl.failsAtNight ? 23 : 7) + i * 3.1);
        k = sl.failsAtNight ? (flick > 0.93 ? 0.5 : 0) : flick > -0.96 ? 0.85 : 0.15;
      }
      sl.light.intensity = sl.baseIntensity * k;
      sl.bulbMat.emissiveIntensity = 0.15 + 2.2 * k;
    }

    // Lit apartment windows & neon signs
    for (const m of this.windowMaterials) {
      if (m.userData.sign) {
        m.emissiveIntensity = 0.5 + n * 0.9 + (Math.sin(elapsed * 31) > 0.97 ? -0.4 : 0);
      } else {
        m.emissiveIntensity = n * 0.75;
      }
    }

    // Flickering burning barrels & campfire
    for (const b of this.burningBarrels) {
      b.light.intensity =
        b.baseIntensity * (1 + n * 0.4) +
        Math.sin(elapsed * 11 + b.phase) * 0.45 +
        Math.cos(elapsed * 19 + b.phase) * 0.25;
    }
  }
}
