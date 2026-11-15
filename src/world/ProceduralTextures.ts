import * as THREE from 'three';

/**
 * Canvas-generated tiling textures for surfaces the Zombie Apocalypse Kit doesn't provide.
 * They're small (256–512 px), generated once at startup and cached.
 */

type Painter = (g: CanvasRenderingContext2D, size: number, rand: () => number) => void;

const cache = new Map<string, THREE.CanvasTexture>();

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function make(key: string, size: number, painter: Painter, srgb = true): THREE.CanvasTexture {
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  painter(g, size, seeded(key.length * 7919 + size));
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  cache.set(key, tex);
  return tex;
}

function speckle(g: CanvasRenderingContext2D, size: number, rand: () => number, count: number, alpha: number): void {
  for (let i = 0; i < count; i++) {
    const v = Math.floor(rand() * 255);
    g.fillStyle = `rgba(${v},${v},${v},${alpha * rand()})`;
    const s = 1 + rand() * 2;
    g.fillRect(rand() * size, rand() * size, s, s);
  }
}

function stains(g: CanvasRenderingContext2D, size: number, rand: () => number, count: number, color: string): void {
  for (let i = 0; i < count; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = size * (0.05 + rand() * 0.15);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

/** Running-bond brick. One tile ≈ 2 m × 2 m. */
export function brickTexture(): THREE.CanvasTexture {
  return make('brick', 512, (g, s, rand) => {
    g.fillStyle = '#5b5550';
    g.fillRect(0, 0, s, s);
    const rows = 16;
    const cols = 8;
    const bh = s / rows;
    const bw = s / cols;
    for (let r = 0; r < rows; r++) {
      const off = r % 2 === 0 ? 0 : bw / 2;
      for (let c = -1; c < cols + 1; c++) {
        const shade = 0.75 + rand() * 0.35;
        const red = Math.floor(150 * shade);
        const green = Math.floor(80 * shade);
        const blue = Math.floor(62 * shade);
        g.fillStyle = `rgb(${red},${green},${blue})`;
        g.fillRect(c * bw + off + 2, r * bh + 2, bw - 4, bh - 4);
      }
    }
    speckle(g, s, rand, 4000, 0.25);
    stains(g, s, rand, 10, 'rgba(20,18,16,0.35)');
  });
}

/** Square sidewalk slabs with cracks. One tile ≈ 4 m. */
export function concreteTexture(): THREE.CanvasTexture {
  return make('concrete', 512, (g, s, rand) => {
    g.fillStyle = '#8a8781';
    g.fillRect(0, 0, s, s);
    speckle(g, s, rand, 9000, 0.22);
    stains(g, s, rand, 8, 'rgba(40,38,34,0.28)');
    g.strokeStyle = 'rgba(40,40,40,0.65)';
    g.lineWidth = 3;
    for (let i = 0; i <= 4; i++) {
      g.beginPath();
      g.moveTo(0, (i * s) / 4);
      g.lineTo(s, (i * s) / 4);
      g.moveTo((i * s) / 4, 0);
      g.lineTo((i * s) / 4, s);
      g.stroke();
    }
    g.lineWidth = 1.5;
    g.strokeStyle = 'rgba(30,30,30,0.5)';
    for (let i = 0; i < 6; i++) {
      let x = rand() * s;
      let y = rand() * s;
      g.beginPath();
      g.moveTo(x, y);
      for (let k = 0; k < 6; k++) {
        x += (rand() - 0.5) * 50;
        y += (rand() - 0.5) * 50;
        g.lineTo(x, y);
      }
      g.stroke();
    }
  });
}

/** Rubble / packed-dirt ground. */
export function groundTexture(): THREE.CanvasTexture {
  return make('ground', 512, (g, s, rand) => {
    g.fillStyle = '#4a4640';
    g.fillRect(0, 0, s, s);
    stains(g, s, rand, 40, 'rgba(90,80,62,0.35)');
    stains(g, s, rand, 30, 'rgba(25,24,22,0.35)');
    speckle(g, s, rand, 14000, 0.3);
    for (let i = 0; i < 160; i++) {
      const v = 70 + Math.floor(rand() * 60);
      g.fillStyle = `rgba(${v},${v - 4},${v - 10},0.7)`;
      g.beginPath();
      g.arc(rand() * s, rand() * s, 1 + rand() * 3, 0, Math.PI * 2);
      g.fill();
    }
  });
}

/** Overgrown grass / weeds for the park. */
export function grassTexture(): THREE.CanvasTexture {
  return make('grass', 512, (g, s, rand) => {
    g.fillStyle = '#3d4a2a';
    g.fillRect(0, 0, s, s);
    stains(g, s, rand, 30, 'rgba(90,82,50,0.35)');
    stains(g, s, rand, 20, 'rgba(20,30,14,0.4)');
    for (let i = 0; i < 9000; i++) {
      const gr = 70 + Math.floor(rand() * 60);
      g.strokeStyle = `rgba(${gr - 20},${gr},${gr - 40},0.5)`;
      const x = rand() * s;
      const y = rand() * s;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (rand() - 0.5) * 4, y - 3 - rand() * 5);
      g.stroke();
    }
  });
}

/** Ribbed corrugated metal (perimeter quarantine wall). */
export function metalTexture(): THREE.CanvasTexture {
  return make('metal', 256, (g, s, rand) => {
    for (let x = 0; x < s; x++) {
      const v = 95 + Math.sin((x / s) * Math.PI * 16) * 22;
      g.fillStyle = `rgb(${v},${v + 3},${v + 6})`;
      g.fillRect(x, 0, 1, s);
    }
    stains(g, s, rand, 14, 'rgba(110,60,30,0.35)');
    speckle(g, s, rand, 2500, 0.2);
  });
}

/** Weathered roof membrane / concrete cap. */
export function roofTexture(): THREE.CanvasTexture {
  return make('roof', 256, (g, s, rand) => {
    g.fillStyle = '#3a3b3e';
    g.fillRect(0, 0, s, s);
    speckle(g, s, rand, 5000, 0.3);
    stains(g, s, rand, 10, 'rgba(15,15,15,0.4)');
  });
}

/** Interior floor boards. */
export function woodFloorTexture(): THREE.CanvasTexture {
  return make('woodfloor', 256, (g, s, rand) => {
    const planks = 8;
    const ph = s / planks;
    for (let i = 0; i < planks; i++) {
      const shade = 0.75 + rand() * 0.3;
      g.fillStyle = `rgb(${Math.floor(120 * shade)},${Math.floor(86 * shade)},${Math.floor(58 * shade)})`;
      g.fillRect(0, i * ph, s, ph - 2);
      g.fillStyle = 'rgba(30,20,10,0.6)';
      g.fillRect(0, i * ph + ph - 2, s, 2);
      g.fillRect(Math.floor(rand() * s), i * ph, 2, ph);
    }
    speckle(g, s, rand, 2000, 0.15);
  });
}

/**
 * Apartment facade: a grid of windows. Returns the colour map and a matching emissive map where
 * roughly a third of the windows glow at night.
 */
export function facadeTextures(): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const cols = 4;
  const rows = 4;
  const lit: boolean[] = [];
  const r0 = seeded(4242);
  for (let i = 0; i < cols * rows; i++) lit.push(r0() < 0.35);

  const map = make('facade', 512, (g, s, rand) => {
    g.fillStyle = '#4c4a48';
    g.fillRect(0, 0, s, s);
    speckle(g, s, rand, 6000, 0.25);
    stains(g, s, rand, 12, 'rgba(20,20,20,0.35)');
    const cw = s / cols;
    const rh = s / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cw + cw * 0.22;
        const y = r * rh + rh * 0.2;
        const w = cw * 0.56;
        const h = rh * 0.58;
        g.fillStyle = '#26282a';
        g.fillRect(x - 4, y - 4, w + 8, h + 10);
        const broken = rand() < 0.15;
        g.fillStyle = broken ? '#0c0d0e' : lit[r * cols + c] ? '#4a4030' : '#1b2026';
        g.fillRect(x, y, w, h);
        g.fillStyle = 'rgba(160,180,200,0.12)';
        g.fillRect(x, y, w * 0.45, h);
        g.fillStyle = '#26282a';
        g.fillRect(x + w / 2 - 2, y, 4, h);
      }
    }
  });

  const emissive = make('facade_emissive', 512, (g, s) => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, s, s);
    const cw = s / cols;
    const rh = s / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!lit[r * cols + c]) continue;
        const x = c * cw + cw * 0.22;
        const y = r * rh + rh * 0.2;
        g.fillStyle = (r + c) % 3 === 0 ? '#ffb070' : '#ffd8a0';
        g.fillRect(x, y, cw * 0.56, rh * 0.58);
      }
    }
  });
  return { map, emissive };
}

/** Returns a clone of a cached texture with its own repeat, so materials can tile independently. */
export function tiled(tex: THREE.Texture, rx: number, ry: number): THREE.Texture {
  const t = tex.clone();
  t.repeat.set(rx, ry);
  t.needsUpdate = true;
  return t;
}
