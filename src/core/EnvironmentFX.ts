import * as THREE from 'three';

/** Shared shader uniforms updated once per frame for all swaying foliage and rim-lit characters. */
export const envUniforms = {
  uWindTime: { value: 0 },
  uWindPower: { value: 1.0 },
  uRimNightBoost: { value: 0.35 },
};

export function updateEnvironmentUniforms(elapsed: number, rainAmount: number, nightFactor: number): void {
  envUniforms.uWindTime.value = elapsed;
  envUniforms.uWindPower.value = 0.75 + rainAmount * 2.1;
  envUniforms.uRimNightBoost.value = 0.32 + nightFactor * 0.78;
}

/**
 * Generates a lightweight procedural urban PMREM environment map for PBR IBL reflections.
 * Gives wet asphalt, vehicle paint, gun metal, shell casings, and glass realistic sky/horizon highlights.
 */
export function createUrbanEnvironmentMap(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const envScene = new THREE.Scene();

  // Gradient dome: cool overcast sky above, warm sodium-haze horizon, dark asphalt below
  const skyGeo = new THREE.SphereGeometry(24, 24, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vPos;
      void main() {
        float y = vPos.y;
        vec3 ground = vec3(0.05, 0.055, 0.065);
        vec3 horizon = vec3(0.45, 0.42, 0.38);
        vec3 zenith = vec3(0.24, 0.35, 0.52);
        vec3 col = y > 0.0
          ? mix(horizon, zenith, pow(max(y, 0.0001), 0.55))
          : mix(horizon * 0.55, ground, pow(max(-y, 0.0001), 0.45));
        // Subtle warm city fire/streetlamp glow along horizon bands
        float cityGlow = exp(-abs(y - 0.04) * 14.0) * (0.5 + 0.5 * sin(vPos.x * 5.0 + vPos.z * 3.0));
        col += vec3(0.55, 0.32, 0.14) * cityGlow * 0.45;
        // Soft sun/moon key specular card
        float keyCard = pow(max(dot(vPos, normalize(vec3(0.45, 0.65, 0.35))), 0.0001), 18.0);
        col += vec3(1.1, 1.05, 0.95) * keyCard;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  envScene.add(new THREE.Mesh(skyGeo, skyMat));

  // Add subtle bright reflection cards for crisp specular streaks on wet vehicles & metal
  const cardMat1 = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.0, 1.7) });
  const card1 = new THREE.Mesh(new THREE.PlaneGeometry(8, 3), cardMat1);
  card1.position.set(10, 8, 8);
  card1.lookAt(0, 0, 0);
  envScene.add(card1);

  const cardMat2 = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 1.3, 2.0) });
  const card2 = new THREE.Mesh(new THREE.PlaneGeometry(10, 4), cardMat2);
  card2.position.set(-12, 9, -8);
  card2.lookAt(0, 0, 0);
  envScene.add(card2);

  const rt = pmrem.fromScene(envScene, 0.04);
  pmrem.dispose();
  skyGeo.dispose();
  skyMat.dispose();
  card1.geometry.dispose();
  cardMat1.dispose();
  card2.geometry.dispose();
  cardMat2.dispose();

  return rt.texture;
}

/**
 * Injects GPU vertex wind-sway into static foliage (dead trees, bushes, grass clumps).
 * Uses world-space object origin (modelMatrix[3].xz) for organic per-plant phase variation
 * while sharing a single compiled shader program across all foliage instances.
 */
export function applyWindSway(root: THREE.Object3D, amplitude = 0.075): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!(mat instanceof THREE.MeshStandardMaterial)) continue;
      if (mat.userData.__windPatched) continue;
      mat.userData.__windPatched = true;
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uWindTime = envUniforms.uWindTime;
        shader.uniforms.uWindPower = envUniforms.uWindPower;
        shader.uniforms.uWindAmp = { value: amplitude };
        shader.vertexShader =
          `uniform float uWindTime;\nuniform float uWindPower;\nuniform float uWindAmp;\n` +
          shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          float wH = max(0.0, position.y);
          float wMask = smoothstep(0.04, 1.2, wH) * wH;
          float wPhase = modelMatrix[3].x * 0.43 + modelMatrix[3].z * 0.37;
          float wGust = sin(uWindTime * 1.85 + wPhase + position.x * 0.7) * 0.65
                      + cos(uWindTime * 3.1 + wPhase * 1.7 + position.z * 0.9) * 0.35;
          transformed.x += wGust * uWindAmp * uWindPower * wMask;
          transformed.z += cos(uWindTime * 1.4 + wPhase) * uWindAmp * 0.5 * uWindPower * wMask;`
        );
      };
      mat.customProgramCacheKey = () => `wind_sway_${amplitude.toFixed(3)}`;
    }
  });
}

/**
 * Injects a subtle view-dependent Fresnel silhouette rim light into MeshStandardMaterials
 * on characters and zombies so silhouettes stay legible against midnight fog & rain.
 */
export function applySilhouetteRim(
  root: THREE.Object3D,
  rimColorHex: number,
  strength = 0.55,
  power = 3.2
): void {
  const rimCol = new THREE.Color(rimColorHex);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!(mat instanceof THREE.MeshStandardMaterial)) continue;
      if (mat.userData.__rimPatched) continue;
      mat.userData.__rimPatched = true;
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uRimColor = { value: rimCol };
        shader.uniforms.uRimStrength = { value: strength };
        shader.uniforms.uRimPower = { value: power };
        shader.uniforms.uRimNightBoost = envUniforms.uRimNightBoost;
        shader.fragmentShader =
          `uniform vec3 uRimColor;\nuniform float uRimStrength;\nuniform float uRimPower;\nuniform float uRimNightBoost;\n` +
          shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          `vec3 rimViewDir = normalize(vViewPosition + vec3(0.0, 0.0, 1e-5));
          float rimNdotV = clamp(dot(normalize(normal + vec3(0.0, 1e-5, 0.0)), rimViewDir), 0.0, 1.0);
          float rimFresnel = pow(max(1.0 - rimNdotV, 0.0001), uRimPower);
          outgoingLight += uRimColor * rimFresnel * uRimStrength * uRimNightBoost;
          #include <opaque_fragment>`
        );
      };
      mat.customProgramCacheKey = () => `rim_${rimColorHex}_${strength.toFixed(2)}`;
    }
  });
}
