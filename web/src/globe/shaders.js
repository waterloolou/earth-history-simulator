// shaders.js -- GLSL vertex/fragment shaders for the deep-time globe.
//
// Photographic-blend layers (Scotese keyframe crossfade, Blue Marble blend +
// plate-drift displacement, cloud scroll) live here as cheap per-fragment
// texture ops driven by scalar uniforms recomputed from `ma` every frame --
// see PLAN.md's "deep-time globe mode" section for the rationale.
//
// Lighting formula (`color * (0.10 + 0.90*ndotl)`) and the rim-glow band
// (`r^2 > 0.84`, blend strength 0.80) are a direct port of main.py's
// _build_proj_tables()/_ortho_project() (main.py lines 1029-1098).

export const vertexShader = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormalView;

void main() {
  vUv = uv;
  vNormalView = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const fragmentShader = /* glsl */ `
precision highp float;
varying vec2 vUv;
varying vec3 vNormalView;

uniform sampler2D uStructuralTex;   // procedural texture, meaningful only when uUseScotese ~ 0
uniform sampler2D uScoteseLoTex;
uniform sampler2D uScoteseHiTex;
uniform float uScoteseFrac;         // blend factor between Lo/Hi keyframes
uniform float uUseScotese;          // 0.0 (ma>750, use structural) or 1.0 (ma<=750)

uniform sampler2D uBlueMarbleTex;
uniform sampler2D uPlateOffsetTex;
uniform float uBMWeight;            // 0..1, Blue Marble blend weight (ma<65)
uniform float uPlateFrac;           // 0..1, plate-drift displacement fraction (ma/65)

uniform sampler2D uCloudTex;
uniform float uCloudOpacity;
uniform float uCloudScrollU;        // 0..1 horizontal scroll offset

uniform vec3 uLightDir;             // fixed, screen/view-space light direction
uniform float uLonOffset;           // initial texture longitude alignment

vec2 wrapUv(vec2 uv) {
  return vec2(fract(uv.x), clamp(uv.y, 0.0, 1.0));
}

void main() {
  vec2 uv = wrapUv(vUv + vec2(uLonOffset, 0.0));

  vec3 structuralColor = texture2D(uStructuralTex, uv).rgb;

  vec3 scoteseLo = texture2D(uScoteseLoTex, uv).rgb;
  vec3 scoteseHi = texture2D(uScoteseHiTex, uv).rgb;
  vec3 scoteseColor = mix(scoteseLo, scoteseHi, uScoteseFrac);

  vec3 baseColor = mix(structuralColor, scoteseColor, uUseScotese);

  // Blue Marble blend with plate-drift displacement (ma < 65), only relevant
  // when uUseScotese ~ 1 (Blue Marble only ever overlays the Scotese branch).
  if (uBMWeight > 0.001) {
    vec2 offset = (texture2D(uPlateOffsetTex, uv).rg - 0.5) / 4.0;
    vec2 displacedUv = wrapUv(uv - offset * uPlateFrac);
    vec3 bm = texture2D(uBlueMarbleTex, displacedUv).rgb;
    baseColor = mix(baseColor, bm, uBMWeight);
  }

  // Cloud layer, scrolled horizontally, blended toward white.
  vec2 cloudUv = wrapUv(uv + vec2(uCloudScrollU, 0.0));
  float cloud = texture2D(uCloudTex, cloudUv).r;
  float cloudAlpha = cloud * uCloudOpacity;
  baseColor = mix(baseColor, vec3(1.0), cloudAlpha);

  // Lambertian shading -- direct port of _build_proj_tables()'s
  // shade = 0.10 + 0.90*max(dot(n,l),0), computed in view space so the light
  // stays screen-locked as the globe mesh rotates (a sphere's view-space
  // normal field from a fixed orthographic camera is rotation-invariant).
  vec3 n = normalize(vNormalView);
  float ndotl = max(dot(n, normalize(uLightDir)), 0.0);
  float shade = 0.10 + 0.90 * ndotl;

  // Atmospheric rim glow -- r^2 = nx^2+ny^2 (screen-space radius^2); Three.js
  // gives us this directly as 1 - n.z^2 for a unit sphere viewed orthographically.
  float r2 = clamp(1.0 - n.z * n.z, 0.0, 1.0);
  float rimT = clamp((r2 - 0.84) / 0.16, 0.0, 1.0);
  float rimBlend = rimT * 0.80;
  vec3 atm = vec3(80.0, 150.0, 255.0) / 255.0;

  vec3 finalColor = baseColor * shade * (1.0 - rimBlend) + atm * rimBlend;
  gl_FragColor = vec4(finalColor, 1.0);
}
`;
