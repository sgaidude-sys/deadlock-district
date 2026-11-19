import * as THREE from 'three';

/**
 * Rain episodes with lightning. Rain comes and goes on its own schedule (more likely at night);
 * surfaces get wet gradually and dry slowly afterwards.
 */
export class WeatherSystem {
  /** 0 = dry … 1 = downpour (smoothed). */
  public rain = 0;
  /** 0 … 1, lags behind rain: how glossy the streets are. */
  public wetness = 0;
  /** Lightning flash brightness this frame (0 … 1). */
  public flash = 0;

  private target = 0;
  private timer = 35 + Math.random() * 40;
  private lightningTimer = 6;
  private flickers: number[] = [];
  private onLightningCb?: (distance: number) => void;

  private materials: { mat: THREE.MeshStandardMaterial; rough: number; color: THREE.Color }[] = [];
  private appliedWetness = -1;

  public onLightning(cb: (distance: number) => void): void {
    this.onLightningCb = cb;
  }

  /** Remember every opaque surface material so rain can make it glossier and a touch darker. */
  public collectMaterials(scene: THREE.Scene): void {
    const seen = new Set<THREE.Material>();
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (!(m instanceof THREE.MeshStandardMaterial) || m.transparent || seen.has(m)) continue;
        seen.add(m);
        this.materials.push({ mat: m, rough: m.roughness, color: m.color.clone() });
      }
    });
  }

  /** Start a shower right away (used when night falls for drama). */
  public forceRain(): void {
    this.target = 0.7 + Math.random() * 0.3;
    this.timer = 60 + Math.random() * 50;
  }

  public update(dt: number, nightFactor: number): void {
    this.timer -= dt;
    if (this.timer <= 0) {
      if (this.target > 0) {
        this.target = 0;
        this.timer = 60 + Math.random() * 80;
      } else if (Math.random() < 0.35 + 0.4 * nightFactor) {
        this.target = 0.45 + Math.random() * 0.55;
        this.timer = 50 + Math.random() * 70;
      } else {
        this.timer = 30 + Math.random() * 40;
      }
    }
    const rate = this.target > this.rain ? 0.09 : 0.06;
    this.rain += THREE.MathUtils.clamp(this.target - this.rain, -rate * dt, rate * dt);
    this.wetness += (this.rain > this.wetness ? 0.12 : -0.015) * dt;
    this.wetness = THREE.MathUtils.clamp(this.wetness, 0, Math.max(this.rain, this.wetness));

    // Lightning during heavier rain
    this.flash = Math.max(0, this.flash - dt * 6);
    if (this.flickers.length && (this.flickers[0] -= dt) <= 0) {
      this.flickers.shift();
      this.flash = 0.6 + Math.random() * 0.4;
    }
    if (this.rain > 0.55) {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.lightningTimer = 7 + Math.random() * 16;
        this.flash = 1;
        this.flickers = [0.08 + Math.random() * 0.05, 0.12 + Math.random() * 0.1];
        this.onLightningCb?.(150 + Math.random() * 900);
      }
    }

    // Wet look: glossier, slightly darker, and richer sky/streetlamp IBL reflections.
    if (Math.abs(this.wetness - this.appliedWetness) > 0.02) {
      this.appliedWetness = this.wetness;
      const w = this.wetness;
      for (const { mat, rough, color } of this.materials) {
        mat.roughness = rough * (1 - 0.58 * w);
        mat.envMapIntensity = 0.65 + 0.9 * w;
        mat.color.copy(color).multiplyScalar(1 - 0.18 * w);
      }
    }
  }
}
