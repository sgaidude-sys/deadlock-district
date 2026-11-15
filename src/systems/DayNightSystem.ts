import * as THREE from 'three';
import { BurningBarrel, StreetLightNode } from '../world/CityGenerator';
import { DayPhase } from '../types/game';

export class DayNightSystem {
  public dayNumber = 1;
  public timeOfDay = 0.22; // Start in crisp morning/afternoon
  public phase: DayPhase = 'day';

  private cycleDuration = 360; // 4 min day + 2 min night
  private sunLight: THREE.DirectionalLight;
  private hemiLight: THREE.HemisphereLight;
  private fog: THREE.FogExp2;
  private scene: THREE.Scene;
  private streetLights: StreetLightNode[];
  private burningBarrels: BurningBarrel[];

  private daySky = new THREE.Color(0x5a6875);
  private duskSky = new THREE.Color(0x7c4333);
  private nightSky = new THREE.Color(0x090d16);

  private daySunColor = new THREE.Color(0xfff1d6);
  private duskSunColor = new THREE.Color(0xff8c42);
  private nightMoonColor = new THREE.Color(0x4b6b9e);

  private wasNight = false;
  private onNightFallCb?: () => void;

  constructor(
    scene: THREE.Scene,
    sunLight: THREE.DirectionalLight,
    hemiLight: THREE.HemisphereLight,
    fog: THREE.FogExp2,
    streetLights: StreetLightNode[],
    burningBarrels: BurningBarrel[]
  ) {
    this.scene = scene;
    this.sunLight = sunLight;
    this.hemiLight = hemiLight;
    this.fog = fog;
    this.streetLights = streetLights;
    this.burningBarrels = burningBarrels;
  }

  public onNightFall(cb: () => void): void {
    this.onNightFallCb = cb;
  }

  public isNight(): boolean {
    return this.phase === 'night';
  }

  public update(dt: number, elapsed: number): void {
    this.timeOfDay += dt / this.cycleDuration;
    if (this.timeOfDay >= 1) {
      this.timeOfDay -= 1;
      this.dayNumber++;
    }

    // 0.0 - 0.56: Day, 0.56 - 0.667: Dusk, 0.667 - 0.94: Night, 0.94 - 1.0: Dawn
    const t = this.timeOfDay;
    if (t < 0.56) this.phase = 'day';
    else if (t < 0.667) this.phase = 'dusk';
    else if (t < 0.94) this.phase = 'night';
    else this.phase = 'dawn';

    const nightNow = this.phase === 'night';
    if (nightNow && !this.wasNight) {
      this.onNightFallCb?.();
    }
    this.wasNight = nightNow;

    // Sun angle
    const angle = t * Math.PI * 2;
    this.sunLight.position.set(Math.cos(angle) * 55, Math.max(8, Math.abs(Math.sin(angle)) * 65), Math.sin(angle) * 35);

    const skyCol = new THREE.Color();
    if (this.phase === 'day') {
      skyCol.copy(this.daySky);
      this.sunLight.color.copy(this.daySunColor);
      this.sunLight.intensity = 2.0;
      this.hemiLight.intensity = 0.75;
      this.fog.density = 0.011;
    } else if (this.phase === 'dusk') {
      const k = (t - 0.56) / (0.667 - 0.56);
      skyCol.copy(this.daySky).lerp(this.duskSky, k);
      this.sunLight.color.copy(this.daySunColor).lerp(this.duskSunColor, k);
      this.sunLight.intensity = THREE.MathUtils.lerp(2.0, 0.9, k);
      this.hemiLight.intensity = THREE.MathUtils.lerp(0.75, 0.4, k);
      this.fog.density = THREE.MathUtils.lerp(0.011, 0.018, k);
    } else if (this.phase === 'night') {
      skyCol.copy(this.nightSky);
      this.sunLight.color.copy(this.nightMoonColor);
      this.sunLight.intensity = 0.35;
      this.hemiLight.intensity = 0.2;
      this.fog.density = 0.025;
    } else {
      const k = (t - 0.94) / 0.06;
      skyCol.copy(this.nightSky).lerp(this.daySky, k);
      this.sunLight.color.copy(this.nightMoonColor).lerp(this.daySunColor, k);
      this.sunLight.intensity = THREE.MathUtils.lerp(0.35, 2.0, k);
      this.hemiLight.intensity = THREE.MathUtils.lerp(0.2, 0.75, k);
      this.fog.density = THREE.MathUtils.lerp(0.025, 0.011, k);
    }

    this.fog.color.copy(skyCol);
    this.scene.background = skyCol;

    // Streetlights flicker out at night
    for (let i = 0; i < this.streetLights.length; i++) {
      const sl = this.streetLights[i];
      if (this.phase === 'night') {
        const flicker = Math.sin(elapsed * 22 + i * 3.1) > 0.88 ? 0.35 : 0;
        sl.light.intensity = flicker;
        sl.bulbMat.emissiveIntensity = flicker * 2;
      } else if (this.phase === 'dusk') {
        sl.light.intensity = sl.baseIntensity;
        sl.bulbMat.emissiveIntensity = 2.0;
      } else {
        sl.light.intensity = 0.15;
        sl.bulbMat.emissiveIntensity = 0.2;
      }
    }

    // Flickering burning barrels & campfire
    for (const b of this.burningBarrels) {
      b.light.intensity =
        b.baseIntensity +
        Math.sin(elapsed * 11 + b.phase) * 0.45 +
        Math.cos(elapsed * 19 + b.phase) * 0.25;
    }
  }
}
