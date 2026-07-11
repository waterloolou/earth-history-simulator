// biome.js -- JS port of main.py's paleoclimate/biome color functions
// (ocean_pair, biome_color, _warmth_factor, _sea_level, _climate_state).
// See main.py lines 216-349 for the Python originals.

const LAVA_HOT = [255, 148, 18];
const LAVA_DARK = [155, 38, 8];
const OCEAN_SHALLOW = [28, 95, 175];
const OCEAN_DEEP = [8, 30, 80];

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function mix(c1, c2, t) {
  t = clamp(t, 0, 1);
  return [Math.round(lerp(c1[0], c2[0], t)), Math.round(lerp(c1[1], c2[1], t)), Math.round(lerp(c1[2], c2[2], t))];
}

export function warmthFactor(ma) {
  if (ma < 2.6) return 0.90;
  if (ma < 34) return 1.10;
  if (ma < 55) return 1.20;
  if (ma < 90) return 1.30;
  if (ma < 145) return 1.20;
  if (ma < 201) return 1.15;
  if (ma < 252) return 1.05;
  if (ma < 310) return 0.70;
  if (ma < 360) return 0.85;
  if (ma < 385) return 1.05;
  if (ma < 420) return 1.20;
  if (ma < 445) return 0.75;
  if (ma < 485) return 1.20;
  if (ma < 540) return 1.25;
  return 1.10;
}

export function seaLevel(ma) {
  if (ma < 2.6) return 0.05;
  if (ma < 34) return 0.45;
  if (ma < 66) return 0.80;
  if (ma < 100) return 1.00;
  if (ma < 145) return 0.85;
  if (ma < 201) return 0.55;
  if (ma < 252) return 0.30;
  if (ma < 310) return 0.20;
  if (ma < 359) return 0.55;
  if (ma < 419) return 0.90;
  if (ma < 444) return 0.95;
  if (ma < 485) return 0.75;
  return 0.50;
}

export function climateState(ma) {
  const w = warmthFactor(ma);
  if (w >= 1.25) return "HOTHOUSE";
  if (w >= 1.10) return "GREENHOUSE";
  if (w >= 0.95) return "MODERATE";
  if (w >= 0.80) return "COOL";
  if (w >= 0.70) return "ICEHOUSE";
  return "GLACIAL";
}

export function oceanPair(ma) {
  if (ma > 4200) return [LAVA_HOT, LAVA_DARK];
  if (ma > 3800) {
    const t = (4200 - ma) / 400;
    return [mix(LAVA_HOT, OCEAN_SHALLOW, t), mix(LAVA_DARK, OCEAN_DEEP, t)];
  }
  const sl = seaLevel(ma);
  const shallow = mix(OCEAN_SHALLOW, [48, 148, 208], sl * 0.40);
  return [shallow, OCEAN_DEEP];
}

/** cy: 0=N pole, 0.5=equator, 1=S pole (normalised texture y). */
export function biomeColor(cy, ma) {
  const lat = Math.abs(90.0 - cy * 180.0);

  const vPlant = ma < 430;
  const vForest = ma < 385;
  const vAngio = ma < 130;
  const vGrass = ma < 34;

  const warmth = warmthFactor(ma);
  const bandScale = 0.5 + 0.5 * warmth;
  const tPolar = Math.min(88.0, 70.0 * bandScale);
  const tSubpolar = Math.min(tPolar - 8.0, 55.0 * bandScale);
  const tTemperate = Math.min(tSubpolar - 8.0, 35.0 * bandScale);
  const tSubtrop = Math.max(8.0, 22.0 * bandScale);

  if (ma > 2500) {
    if (lat > tPolar) return [98, 90, 80];
    if (lat > tTemperate) return [88, 80, 68];
    return [80, 72, 60];
  }

  if (!vPlant) {
    if (lat > tPolar) return [182, 174, 162];
    if (lat > tTemperate) return [150, 124, 88];
    return [145, 110, 68];
  }

  if (lat > tPolar) {
    if (ma < 2.6) return [230, 240, 255];
    if (vGrass) return [195, 205, 188];
    if (warmth >= 1.10) return [95, 125, 65];
    return [178, 168, 150];
  }

  if (lat > tSubpolar) {
    if (vGrass) return [65, 100, 55];
    if (vAngio) return [78, 115, 60];
    if (vForest) return [88, 112, 60];
    if (warmth >= 1.10) return [88, 118, 65];
    return [105, 108, 70];
  }

  if (lat > tTemperate) {
    if (vGrass) return [108, 150, 75];
    if (vAngio) return [92, 132, 68];
    if (vForest) return [82, 118, 60];
    return [98, 115, 68];
  }

  if (lat > tSubtrop) {
    if (vGrass) return [192, 162, 82];
    if (vAngio) return [148, 135, 72];
    if (vForest) return [118, 128, 65];
    return [138, 115, 75];
  }

  if (vGrass) return [52, 122, 50];
  if (vAngio) return [60, 115, 52];
  if (vForest) return [68, 108, 54];
  return [88, 108, 62];
}
