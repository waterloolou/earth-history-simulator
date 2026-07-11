// shaders.js -- GLSL vertex/fragment shaders for the deep-time globe.
//
// The globe now renders through ONE pipeline for the entire timeline (see
// structuralTexture.js for why) -- this shader's job is just to map that
// Canvas2D texture onto the sphere, blend a scrolling cloud layer over it, and
// apply consistent Lambertian shading + atmospheric rim-glow so lighting never
// changes character as you scrub through time.

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

uniform sampler2D uStructuralTex;

uniform sampler2D uCloudTex;
uniform float uCloudOpacity;
uniform float uCloudScrollU;

uniform vec3 uLightDir;
uniform float uLonOffset;

vec2 wrapUv(vec2 uv) {
  return vec2(fract(uv.x), clamp(uv.y, 0.0, 1.0));
}

void main() {
  vec2 uv = wrapUv(vUv + vec2(uLonOffset, 0.0));

  vec3 baseColor = texture2D(uStructuralTex, uv).rgb;

  // Cloud layer, scrolled horizontally, blended toward white.
  vec2 cloudUv = wrapUv(uv + vec2(uCloudScrollU, 0.0));
  float cloud = texture2D(uCloudTex, cloudUv).r;
  float cloudAlpha = cloud * uCloudOpacity;
  baseColor = mix(baseColor, vec3(1.0), cloudAlpha);

  // Lambertian shading, computed in view space so the light stays
  // screen-locked as the globe mesh rotates (a sphere's view-space normal
  // field from a fixed orthographic camera is rotation-invariant).
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
