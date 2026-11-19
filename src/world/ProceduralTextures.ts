import * as THREE from 'three';

/**
 * Procedural PBR texture suite (albedo + tangent-space normal map + roughness map) for surfaces
 * the Zombie Apocalypse Kit doesn't provide. Generated once at startup from deterministic height
 * fields via Sobel gradients and cached for zero runtime overhead.
 */

type Painter = (g: CanvasRenderingContext2D, size: number, rand: () => number) => void;

export interface PBRSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

const cache = new Map<string, THREE.Texture>();
const pbrCache = new Map<string, PBRSet>();

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeCanvas(size: number, painter: Painter, seedKey: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  painter(g, size, seeded(seedKey.length * 7919 + size + seedKey.charCodeAt(0) * 131));
  return c;
}

function wrapTexture(canvas: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return tex;
}

function make(key: string, size: number, painter: Painter, srgb = true): THREE.Texture {
  const hit = cache.get(key);
  if (hit) return hit;
  const tex = wrapTexture(makeCanvas(size, painter, key), srgb);
  cache.set(key, tex);
  return tex;
}

/** Converts a grayscale height canvas into a seamless tangent-space normal map using a 3x3 Sobel filter. */
function heightToNormal(heightCanvas: HTMLCanvasElement, strength = 2.4): THREE.CanvasTexture {
  const size = heightCanvas.width;
  const srcCtx = heightCanvas.getContext('2d')!;
  const src = srcCtx.getImageData(0, 0, size, size).data;

  const out = document.createElement('canvas');
  out.width = out.height = size;
  const outCtx = out.getContext('2d')!;
  const img = outCtx.createImageData(size, size);
  const dst = img.data;

  const hAt = (x: number, y: number): number => {
    const wx = (x + size) & (size - 1);
    const wy = (y + size) & (size - 1);
    return src[(wy * size + wx) * 4] / 255;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = hAt(x - 1, y - 1);
      const t = hAt(x, y - 1);
      const tr = hAt(x + 1, y - 1);
      const l = hAt(x - 1, y);
      const r = hAt(x + 1, y);
      const bl = hAt(x - 1, y + 1);
      const b = hAt(x, y + 1);
      const br = hAt(x + 1, y + 1);

      const dx = (tr + 2 * r + br - (tl + 2 * l + bl)) * strength;
      const dy = (bl + 2 * b + br - (tl + 2 * t + tr)) * strength;
      const dz = 1.0;
      const invLen = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);

      const i = (y * size + x) * 4;
      dst[i] = Math.round((-dx * invLen * 0.5 + 0.5) * 255);
      dst[i + 1] = Math.round((dy * invLen * 0.5 + 0.5) * 255);
      dst[i + 2] = Math.round((dz * invLen * 0.5 + 0.5) * 255);
      dst[i + 3] = 255;
    }
  }
  outCtx.putImageData(img, 0, 0);
  return wrapTexture(out, false);
}

/** Derives a roughness map from a height/albedo canvas with configurable min/max roughness range. */
function heightToRoughness(
  heightCanvas: HTMLCanvasElement,
  lowRough = 0.55,
  highRough = 0.96,
  invert = true
): THREE.CanvasTexture {
  const size = heightCanvas.width;
  const src = heightCanvas.getContext('2d')!.getImageData(0, 0, size, size).data;
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const outCtx = out.getContext('2d')!;
  const img = outCtx.createImageData(size, size);
  const dst = img.data;

  for (let i = 0; i < src.length; i += 4) {
    const n = src[i] / 255;
    const t = invert ? 1 - n : n;
    const v = Math.round(THREE.MathUtils.lerp(lowRough, highRough, t) * 255);
    dst[i] = dst[i + 1] = dst[i + 2] = v;
    dst[i + 3] = 255;
  }
  outCtx.putImageData(img, 0, 0);
  return wrapTexture(out, false);
}

function makePBR(
  key: string,
  size: number,
  albedoPainter: Painter,
  heightPainter: Painter,
  normalStrength = 2.4,
  lowRough = 0.55,
  highRough = 0.96,
  invertRough = true
): PBRSet {
  const hit = pbrCache.get(key);
  if (hit) return hit;

  const albedoCanvas = makeCanvas(size, albedoPainter, key);
  const heightCanvas = makeCanvas(size, heightPainter, `${key}_h`);
  const set: PBRSet = {
    map: wrapTexture(albedoCanvas, true),
    normalMap: heightToNormal(heightCanvas, normalStrength),
    roughnessMap: heightToRoughness(heightCanvas, lowRough, highRough, invertRough),
  };
  cache.set(key, set.map);
  pbrCache.set(key, set);
  return set;
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

/** Running-bond brick with recessed mortar normals & worn grime. One tile ≈ 2 m × 2 m. */
export function brickPBR(): PBRSet {
  return makePBR(
    'brick',
    512,
    (g, s, rand) => {
      g.fillStyle = '#534d47';
      g.fillRect(0, 0, s, s);
      const rows = 16;
      const cols = 8;
      const bh = s / rows;
      const bw = s / cols;
      for (let r = 0; r < rows; r++) {
        const off = r % 2 === 0 ? 0 : bw / 2;
        for (let c = -1; c < cols + 1; c++) {
          const shade = 0.72 + rand() * 0.38;
          const red = Math.floor(156 * shade);
          const green = Math.floor(82 * shade);
          const blue = Math.floor(62 * shade);
          g.fillStyle = `rgb(${red},${green},${blue})`;
          g.fillRect(c * bw + off + 2.5, r * bh + 2.5, bw - 5, bh - 5);
        }
      }
      speckle(g, s, rand, 4500, 0.26);
      stains(g, s, rand, 12, 'rgba(18,16,14,0.38)');
    },
    (g, s, rand) => {
      g.fillStyle = '#242424';
      g.fillRect(0, 0, s, s);
      const rows = 16;
      const cols = 8;
      const bh = s / rows;
      const bw = s / cols;
      for (let r = 0; r < rows; r++) {
        const off = r % 2 === 0 ? 0 : bw / 2;
        for (let c = -1; c < cols + 1; c++) {
          const h = Math.floor(175 + rand() * 65);
          g.fillStyle = `rgb(${h},${h},${h})`;
          g.fillRect(c * bw + off + 2.5, r * bh + 2.5, bw - 5, bh - 5);
        }
      }
      speckle(g, s, rand, 5000, 0.2);
    },
    2.8,
    0.68,
    0.98
  );
}

export function brickTexture(): THREE.Texture {
  return brickPBR().map;
}

/** Sidewalk concrete slabs with recessed joints, micro-aggregate grain, and cracks. */
export function concretePBR(): PBRSet {
  const crackSeed = seeded(9187);
  const cracks: [number, number][][] = [];
  for (let i = 0; i < 8; i++) {
    let x = crackSeed() * 512;
    let y = crackSeed() * 512;
    const pts: [number, number][] = [[x, y]];
    for (let k = 0; k < 6; k++) {
      x += (crackSeed() - 0.5) * 52;
      y += (crackSeed() - 0.5) * 52;
      pts.push([x, y]);
    }
    cracks.push(pts);
  }

  return makePBR(
    'concrete',
    512,
    (g, s, rand) => {
      g.fillStyle = '#898680';
      g.fillRect(0, 0, s, s);
      speckle(g, s, rand, 10000, 0.24);
      stains(g, s, rand, 10, 'rgba(34,32,28,0.3)');
      g.strokeStyle = 'rgba(35,35,35,0.68)';
      g.lineWidth = 3;
      for (let i = 0; i <= 4; i++) {
        g.beginPath();
        g.moveTo(0, (i * s) / 4);
        g.lineTo(s, (i * s) / 4);
        g.moveTo((i * s) / 4, 0);
        g.lineTo((i * s) / 4, s);
        g.stroke();
      }
      g.lineWidth = 1.6;
      g.strokeStyle = 'rgba(26,26,26,0.55)';
      for (const pts of cracks) {
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0], pts[k][1]);
        g.stroke();
      }
    },
    (g, s, rand) => {
      g.fillStyle = '#c8c8c8';
      g.fillRect(0, 0, s, s);
      speckle(g, s, rand, 10000, 0.25);
      stains(g, s, rand, 8, 'rgba(90,90,90,0.35)'); // subtle puddle depressions
      g.strokeStyle = '#303030';
      g.lineWidth = 4;
      for (let i = 0; i <= 4; i++) {
        g.beginPath();
        g.moveTo(0, (i * s) / 4);
        g.lineTo(s, (i * s) / 4);
        g.moveTo((i * s) / 4, 0);
        g.lineTo((i * s) / 4, s);
        g.stroke();
      }
      g.strokeStyle = '#202020';
      g.lineWidth = 2.2;
      for (const pts of cracks) {
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0], pts[k][1]);
        g.stroke();
      }
    },
    2.2,
    0.52,
    0.96
  );
}

export function concreteTexture(): THREE.Texture {
  return concretePBR().map;
}

/** Rubble / packed-dirt asphalt sub-base with pebbles. */
export function groundPBR(): PBRSet {
  return makePBR(
    'ground',
    512,
    (g, s, rand) => {
      g.fillStyle = '#47433d';
      g.fillRect(0, 0, s, s);
      stains(g, s, rand, 40, 'rgba(90,80,62,0.35)');
      stains(g, s, rand, 30, 'rgba(22,21,19,0.38)');
      speckle(g, s, rand, 15000, 0.32);
      for (let i = 0; i < 180; i++) {
        const v = 68 + Math.floor(rand() * 64);
        g.fillStyle = `rgba(${v},${v - 4},${v - 10},0.75)`;
        g.beginPath();
        g.arc(rand() * s, rand() * s, 1 + rand() * 3.2, 0, Math.PI * 2);
        g.fill();
      }
    },
    (g, s, rand) => {
      g.fillStyle = '#808080';
      g.fillRect(0, 0, s, s);
      stains(g, s, rand, 24, 'rgba(40,40,40,0.45)');
      speckle(g, s, rand, 15000, 0.35);
      for (let i = 0; i < 180; i++) {
        const v = 160 + Math.floor(rand() * 80);
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.beginPath();
        g.arc(rand() * s, rand() * s, 1.5 + rand() * 3.2, 0, Math.PI * 2);
        g.fill();
      }
    },
    2.6,
    0.72,
    0.99
  );
}

export function groundTexture(): THREE.Texture {
  return groundPBR().map;
}

/** Overgrown yard grass / weeds with blade relief. */
export function grassPBR(): PBRSet {
  return makePBR(
    'grass',
    512,
    (g, s, rand) => {
      g.fillStyle = '#3b4828';
      g.fillRect(0, 0, s, s);
      stains(g, s, rand, 30, 'rgba(92,82,48,0.35)');
      stains(g, s, rand, 22, 'rgba(18,28,12,0.42)');
      for (let i = 0; i < 9500; i++) {
        const gr = 68 + Math.floor(rand() * 64);
        g.strokeStyle = `rgba(${gr - 20},${gr},${gr - 40},0.52)`;
        const x = rand() * s;
        const y = rand() * s;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + (rand() - 0.5) * 4, y - 3 - rand() * 5);
        g.stroke();
      }
    },
    (g, s, rand) => {
      g.fillStyle = '#606060';
      g.fillRect(0, 0, s, s);
      for (let i = 0; i < 8000; i++) {
        const v = 110 + Math.floor(rand() * 130);
        g.strokeStyle = `rgba(${v},${v},${v},0.6)`;
        const x = rand() * s;
        const y = rand() * s;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + (rand() - 0.5) * 4, y - 3 - rand() * 5);
        g.stroke();
      }
    },
    2.1,
    0.78,
    0.99
  );
}

export function grassTexture(): THREE.Texture {
  return grassPBR().map;
}

/** Ribbed corrugated metal (perimeter quarantine wall & reinforced sheets) with crisp rib normals. */
export function metalPBR(): PBRSet {
  return makePBR(
    'metal',
    256,
    (g, s, rand) => {
      for (let x = 0; x < s; x++) {
        const v = 96 + Math.sin((x / s) * Math.PI * 16) * 24;
        g.fillStyle = `rgb(${v},${v + 3},${v + 7})`;
        g.fillRect(x, 0, 1, s);
      }
      stains(g, s, rand, 16, 'rgba(116,58,26,0.38)');
      speckle(g, s, rand, 2800, 0.2);
    },
    (g, s, rand) => {
      for (let x = 0; x < s; x++) {
        const v = Math.round(128 + Math.sin((x / s) * Math.PI * 16) * 100);
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.fillRect(x, 0, 1, s);
      }
      speckle(g, s, rand, 1800, 0.14);
    },
    3.2,
    0.32,
    0.78
  );
}

export function metalTexture(): THREE.Texture {
  return metalPBR().map;
}

/** Weathered tar-and-gravel roof membrane. */
export function roofPBR(): PBRSet {
  return makePBR(
    'roof',
    256,
    (g, s, rand) => {
      g.fillStyle = '#3a3b3e';
      g.fillRect(0, 0, s, s);
      speckle(g, s, rand, 5500, 0.32);
      stains(g, s, rand, 12, 'rgba(14,14,16,0.44)');
    },
    (g, s, rand) => {
      g.fillStyle = '#909090';
      g.fillRect(0, 0, s, s);
      speckle(g, s, rand, 6500, 0.38);
      stains(g, s, rand, 10, 'rgba(40,40,40,0.4)');
    },
    2.0,
    0.62,
    0.96
  );
}

export function roofTexture(): THREE.Texture {
  return roofPBR().map;
}

/** Interior wood floor planks with seam grooves and grain variation. */
export function woodFloorPBR(): PBRSet {
  return makePBR(
    'woodfloor',
    256,
    (g, s, rand) => {
      const planks = 8;
      const ph = s / planks;
      for (let i = 0; i < planks; i++) {
        const shade = 0.72 + rand() * 0.32;
        g.fillStyle = `rgb(${Math.floor(124 * shade)},${Math.floor(88 * shade)},${Math.floor(58 * shade)})`;
        g.fillRect(0, i * ph, s, ph - 2);
        // Subtle grain streaks
        for (let k = 0; k < 10; k++) {
          g.fillStyle = `rgba(38,24,12,${0.08 + rand() * 0.12})`;
          g.fillRect(0, i * ph + rand() * (ph - 3), s, 1.2);
        }
        g.fillStyle = 'rgba(26,16,8,0.7)';
        g.fillRect(0, i * ph + ph - 2, s, 2);
        g.fillRect(Math.floor(rand() * s), i * ph, 2, ph);
      }
      speckle(g, s, rand, 2000, 0.14);
    },
    (g, s, rand) => {
      const planks = 8;
      const ph = s / planks;
      for (let i = 0; i < planks; i++) {
        const h = Math.floor(175 + rand() * 45);
        g.fillStyle = `rgb(${h},${h},${h})`;
        g.fillRect(0, i * ph, s, ph - 2.5);
        g.fillStyle = '#181818';
        g.fillRect(0, i * ph + ph - 2.5, s, 2.5);
      }
      speckle(g, s, rand, 1600, 0.16);
    },
    2.6,
    0.48,
    0.88
  );
}

export function woodFloorTexture(): THREE.Texture {
  return woodFloorPBR().map;
}

/** Rough timber grain for barricades and furniture. */
export function plankPBR(): PBRSet {
  return makePBR(
    'plank',
    256,
    (g, s, rand) => {
      g.fillStyle = '#7c5838';
      g.fillRect(0, 0, s, s);
      for (let y = 0; y < s; y += 2) {
        const n = 0.8 + rand() * 0.35;
        g.fillStyle = `rgba(${Math.floor(110 * n)},${Math.floor(74 * n)},${Math.floor(44 * n)},0.45)`;
        g.fillRect(0, y, s, 2);
      }
      speckle(g, s, rand, 2200, 0.18);
    },
    (g, s, rand) => {
      g.fillStyle = '#9a9a9a';
      g.fillRect(0, 0, s, s);
      for (let y = 0; y < s; y += 3) {
        const v = Math.floor(115 + rand() * 90);
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.fillRect(0, y, s, 2);
      }
    },
    2.4,
    0.66,
    0.94
  );
}

/**
 * Apartment facade: recessed windows with glass specular highlights (low roughness on glass panes,
 * high roughness on concrete walls) and a matching night-time emissive map.
 */
export function facadeTextures(): {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  emissive: THREE.Texture;
} {
  const cols = 4;
  const rows = 4;
  const lit: boolean[] = [];
  const r0 = seeded(4242);
  for (let i = 0; i < cols * rows; i++) lit.push(r0() < 0.35);

  const pbr = makePBR(
    'facade',
    512,
    (g, s, rand) => {
      g.fillStyle = '#4c4a48';
      g.fillRect(0, 0, s, s);
      speckle(g, s, rand, 6500, 0.25);
      stains(g, s, rand, 14, 'rgba(18,18,20,0.38)');
      const cw = s / cols;
      const rh = s / rows;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = c * cw + cw * 0.22;
          const y = r * rh + rh * 0.2;
          const w = cw * 0.56;
          const h = rh * 0.58;
          g.fillStyle = '#242629';
          g.fillRect(x - 4, y - 4, w + 8, h + 10);
          const broken = rand() < 0.15;
          g.fillStyle = broken ? '#0b0c0d' : lit[r * cols + c] ? '#4a4030' : '#1b222a';
          g.fillRect(x, y, w, h);
          g.fillStyle = 'rgba(165,190,215,0.16)';
          g.fillRect(x, y, w * 0.45, h);
          g.fillStyle = '#242629';
          g.fillRect(x + w / 2 - 2, y, 4, h);
        }
      }
    },
    (g, s, rand) => {
      g.fillStyle = '#d4d4d4';
      g.fillRect(0, 0, s, s);
      speckle(g, s, rand, 4000, 0.2);
      const cw = s / cols;
      const rh = s / rows;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = c * cw + cw * 0.22;
          const y = r * rh + rh * 0.2;
          const w = cw * 0.56;
          const h = rh * 0.58;
          g.fillStyle = '#f0f0f0'; // protruding sill/frame
          g.fillRect(x - 5, y - 5, w + 10, h + 12);
          g.fillStyle = '#202020'; // deeply recessed glass pane
          g.fillRect(x, y, w, h);
        }
      }
    },
    3.0,
    0.18, // smooth reflective glass panes (low height -> low roughness when invert=false!)
    0.95,
    false
  );

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

  return { map: pbr.map, normalMap: pbr.normalMap, roughnessMap: pbr.roughnessMap, emissive };
}

/** Returns a clone of a cached texture with its own repeat, so materials can tile independently. */
export function tiled(tex: THREE.Texture, rx: number, ry: number): THREE.Texture {
  const t = tex.clone();
  t.repeat.set(rx, ry);
  t.needsUpdate = true;
  return t;
}

/** Clones an entire PBR texture set with synchronized UV tiling. */
export function tiledPBR(set: PBRSet, rx: number, ry: number): PBRSet {
  return {
    map: tiled(set.map, rx, ry),
    normalMap: tiled(set.normalMap, rx, ry),
    roughnessMap: tiled(set.roughnessMap, rx, ry),
  };
}
