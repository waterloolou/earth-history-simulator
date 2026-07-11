// structuralTexture.js -- Canvas2D procedural equirect texture builder, ONLY
// used for ma > 750 (deep Precambrian, before Scotese/PALEOMAP coverage begins).
//
// Why only ma > 750: in main.py's _make_equirect_tex(), the Scotese texture
// (when available, ma <= 750) fully REPLACES the procedurally-drawn RGB
// (main.py line 958: `raw[:, :, :3] = paleo`) -- so every procedural step
// (polygon/blob continents, mountains, ice caps, terrain noise) is only ever
// visible for ma > 750, where Scotese has no coverage. Porting that dead code
// path for ma <= 750 would be wasted work producing an identical final image
// (Scotese/Blue Marble/clouds, handled entirely in the GLSL layer -- see
// shaders.js) to what a "faithful" but pointless port would produce, so this
// module only implements the ma > 750 branch.
//
// Matches main.py's Gaussian-blob-splatting branch (lines 843-882), the
// Huronian ice cap (the only ice-cap window with ma > 750, lines 907-913),
// and the deep-Precambrian terrain-noise/depth-dimming enhancement
// (lines 960-984). The Neoproterozoic/Ordovician/Carboniferous-Permian/
// Quaternary ice caps and the ma<=750 polygon-draw branch are intentionally
// omitted -- they are always overwritten by Scotese in the reference app.

import { oceanPair, biomeColor } from "./biome.js";
import { drawMountains } from "./mountains.js";

const W_TEX = 720, H_TEX = 360;

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

/** Separable box blur (3 passes ~= Gaussian), operating on a Float32Array
 * single-channel buffer of size w*h, values in [0, 1]. Matches the plan's
 * "3-pass box blur with polygon-specific radius" approach in place of a
 * literal per-polygon Gaussian convolution. */
function boxBlur(src, w, h, radius) {
  if (radius < 1) return src;
  let buf = src;
  for (let pass = 0; pass < 3; pass++) {
    buf = boxBlurPass(buf, w, h, true, radius);
    buf = boxBlurPass(buf, w, h, false, radius);
  }
  return buf;
}

function boxBlurPass(src, w, h, horizontal, radius) {
  const out = new Float32Array(w * h);
  const size = radius * 2 + 1;
  if (horizontal) {
    for (let y = 0; y < h; y++) {
      const rowOff = y * w;
      let acc = 0;
      for (let x = -radius; x <= radius; x++) acc += src[rowOff + clampIdx(x, w)];
      for (let x = 0; x < w; x++) {
        out[rowOff + x] = acc / size;
        const addX = x + radius + 1, subX = x - radius;
        acc += src[rowOff + clampIdx(addX, w)] - src[rowOff + clampIdx(subX, w)];
      }
    }
  } else {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -radius; y <= radius; y++) acc += src[clampIdx(y, h) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / size;
        const addY = y + radius + 1, subY = y - radius;
        acc += src[clampIdx(addY, h) * w + x] - src[clampIdx(subY, h) * w + x];
      }
    }
  }
  return out;
}

function clampIdx(i, n) { return i < 0 ? 0 : (i >= n ? n - 1 : i); }

function polyBoundingBoxPx(poly, w, h) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    const px = x * w, py = y * h;
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  }
  return [minX, minY, maxX, maxY];
}

/** Rasterize + blur one polygon into `accumulated` (a full-image w*h buffer),
 * doing the canvas allocation, getImageData, and box blur only inside the
 * polygon's bounding box padded by the blur's finite support (3*radius for a
 * 3-pass box blur). A 3-pass box blur is exactly zero beyond 3*radius from any
 * lit pixel, so the padded-region result is bit-identical to blurring the full
 * image -- but for a typical continent covering a fraction of the 720x360 map,
 * it replaces a full-frame rasterize+blur with a small-window one (the dominant
 * cost of build() before this optimization; see PLAN.md's caching notes). */
function splatPolyRegion(accumulated, poly, w, h, aFrac, radius) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    const px = x * w, py = y * h;
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  }
  const pad = 3 * radius + 2; // finite support of a 3-pass box blur, +slack
  const x0 = Math.max(0, Math.floor(minX) - pad);
  const y0 = Math.max(0, Math.floor(minY) - pad);
  const x1 = Math.min(w, Math.ceil(maxX) + pad + 1);
  const y1 = Math.min(h, Math.ceil(maxY) + pad + 1);
  const sw = x1 - x0, sh = y1 - y0;
  if (sw < 1 || sh < 1) return;

  // Rasterize the polygon into a sub-window canvas (coords offset by x0,y0).
  const c = makeCanvas(sw, sh);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  poly.forEach(([x, y], i) => {
    const px = x * w - x0, py = y * h - y0;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.fill();
  const { data } = ctx.getImageData(0, 0, sw, sh);
  const mask = new Float32Array(sw * sh);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) mask[i] = data[p] / 255;

  // boxBlur clamps at buffer edges; where the sub-window abuts the true image
  // edge this matches the full-image behavior, and where it abuts padding the
  // edge value is 0 (same as reading zeros beyond), so the result is identical.
  const blurred = boxBlur(mask, sw, sh, radius);
  for (let sy = 0; sy < sh; sy++) {
    const dstRow = (y0 + sy) * w + x0;
    const srcRow = sy * sw;
    for (let sx = 0; sx < sw; sx++) accumulated[dstRow + sx] += blurred[srcRow + sx] * aFrac;
  }
}

/** Simple value-noise FBM (5 sine octaves), stable per 10-Ma bucket, matching
 * main.py's _terrain_noise_for()'s spirit (not a literal port of numpy RNG
 * output, which can't be reproduced bit-for-bit in JS -- an independent noise
 * field with the same statistical character is sufficient here).
 *
 * Perf: the per-pixel term `sin(xx)*cos(yy)` is separable -- xx depends only on
 * x, yy only on y -- so each octave is built from one sin per column and one
 * cos per row (~(w+h) trig calls) instead of one sin+cos per pixel (~2*w*h).
 * Output is bit-identical; the transcendental-call count drops ~360x. The
 * finished field is also memoized on its 10-Ma seed, since several consecutive
 * 3-Ma structural-cache buckets resolve to the same noise seed. */
const _terrainNoiseCache = new Map(); // seed -> Float32Array
const TERRAIN_NOISE_CACHE_MAX = 8;

function terrainNoise(ma, w, h) {
  const seed = Math.floor(ma / 10) * 10 + 9999;
  const cached = _terrainNoiseCache.get(seed);
  if (cached) return cached;

  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const noise = new Float32Array(w * h);
  const sinX = new Float32Array(w);
  const cosY = new Float32Array(h);
  let amp = 1.0, freq = 3;
  for (let o = 0; o < 5; o++) {
    const px = rand() * 6.28318, py = rand() * 6.28318;
    for (let x = 0; x < w; x++) sinX[x] = Math.sin(px + freq * 6.28318 * (x / w));
    for (let y = 0; y < h; y++) cosY[y] = Math.cos(py + freq * 6.28318 * (y / h));
    for (let y = 0; y < h; y++) {
      const ampCosY = amp * cosY[y];
      const rowOff = y * w;
      for (let x = 0; x < w; x++) noise[rowOff + x] += ampCosY * sinX[x];
    }
    amp *= 0.55;
    freq = Math.floor(freq * 1.9) + 1;
  }
  let min = Infinity, max = -Infinity;
  for (const v of noise) { if (v < min) min = v; if (v > max) max = v; }
  const range = max - min || 1e-8;
  const norm = new Float32Array(w * h);
  for (let i = 0; i < noise.length; i++) norm[i] = (noise[i] - min) / range;
  const blurred = boxBlur(norm, w, h, 4);
  const result = new Float32Array(w * h);
  for (let i = 0; i < result.length; i++) result[i] = 0.80 + 0.40 * blurred[i];

  _terrainNoiseCache.set(seed, result);
  if (_terrainNoiseCache.size > TERRAIN_NOISE_CACHE_MAX) {
    _terrainNoiseCache.delete(_terrainNoiseCache.keys().next().value);
  }
  return result;
}

export class StructuralTextureBuilder {
  constructor() {
    this.canvas = makeCanvas(W_TEX, H_TEX);
    this.ctx = this.canvas.getContext("2d");
  }

  /** Build the ma>750 procedural texture. Returns the internal canvas (reused
   * across calls -- callers must finish using/uploading it before the next
   * build() call, matching the single-buffer reuse pattern of a GPU texture
   * upload). */
  build(ma, continentModel) {
    const ctx = this.ctx;
    const w = W_TEX, h = H_TEX;

    // ── ocean gradient base ────────────────────────────────────────────────
    const [shallow, deep] = oceanPair(ma);
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0.0, `rgb(${deep[0]},${deep[1]},${deep[2]})`);
    grad.addColorStop(0.5, `rgb(${shallow[0]},${shallow[1]},${shallow[2]})`);
    grad.addColorStop(1.0, `rgb(${deep[0]},${deep[1]},${deep[2]})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    const oceanImg = ctx.getImageData(0, 0, w, h);

    // ── Gaussian-blob-splatted continents ─────────────────────────────────
    const continents = continentModel.getInterpolatedContinents(ma);
    const accumulated = new Float32Array(w * h);
    for (const c of continents) {
      const aFrac = (c.alpha ?? 255) / 255.0;
      if (aFrac < 0.02) continue;
      for (const poly of c.polys) {
        if (poly.length < 3) continue;
        const [minX, minY, maxX, maxY] = polyBoundingBoxPx(poly, w, h);
        const geoMean = Math.pow((maxX - minX + 1) * (maxY - minY + 1), 0.4);
        const br = Math.max(14, Math.min(32, Math.round(geoMean * 0.30)));
        const radius = Math.max(1, Math.round(br / 2.2));
        splatPolyRegion(accumulated, poly, w, h, aFrac, radius);
      }
    }

    const landMask = new Uint8Array(w * h);
    for (let i = 0; i < landMask.length; i++) landMask[i] = accumulated[i] > 0.30 ? 1 : 0;

    // biome color per latitude row
    const biomeRows = new Array(h);
    for (let y = 0; y < h; y++) biomeRows[y] = biomeColor(y / (h - 1), ma);

    const out = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const row = biomeRows[y];
      for (let x = 0; x < w; x++) {
        const i = y * w + x, p = i * 4;
        if (landMask[i]) {
          out.data[p] = row[0]; out.data[p + 1] = row[1]; out.data[p + 2] = row[2];
        } else {
          out.data[p] = oceanImg.data[p]; out.data[p + 1] = oceanImg.data[p + 1]; out.data[p + 2] = oceanImg.data[p + 2];
        }
        out.data[p + 3] = 255;
      }
    }
    ctx.putImageData(out, 0, 0);

    // light full-image blur for colour-transition softening (matches blur_r=2.5)
    ctx.filter = "blur(2.5px)";
    ctx.drawImage(this.canvas, 0, 0);
    ctx.filter = "none";

    // ── mountains ──────────────────────────────────────────────────────────
    drawMountains(ctx, w, h, ma);

    // ── Huronian ice cap (2050-2400 Ma; the only ice window entirely > 750 Ma) ─
    if (ma >= 2050 && ma <= 2400) {
      let frac = Math.max(0, 1.0 - Math.abs(ma - 2250) / 150.0);
      frac = Math.max(0.30, Math.min(1, frac));
      const capH = Math.max(5, Math.round(h * 0.08 + h * 0.38 * frac));
      ctx.fillStyle = "rgba(255,255,255,0.843)";
      ctx.fillRect(0, 0, w, capH);
      ctx.fillStyle = "rgba(220,235,255,0.824)";
      ctx.fillRect(0, h - capH, w, capH);
    }

    // ── deep-Precambrian terrain-noise / depth-dimming enhancement ─────────
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const oceanMaskArr = new Uint8Array(w * h);
    const landEffArr = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      const isOcean = (d[p + 2] - d[p]) > 35;
      const brightSum = d[p] + d[p + 1] + d[p + 2];
      const isIce = brightSum > 630;
      oceanMaskArr[i] = (isOcean && !isIce) ? 1 : 0;
      landEffArr[i] = (!isOcean && !isIce) ? 1 : 0;
    }
    const coastMaskFloat = new Float32Array(w * h);
    for (let i = 0; i < landEffArr.length; i++) coastMaskFloat[i] = landEffArr[i];
    const coastProx = boxBlur(coastMaskFloat, w, h, 8);
    let anyLand = false;
    const noise = terrainNoise(ma, w, h);
    for (let i = 0; i < landEffArr.length; i++) if (landEffArr[i]) { anyLand = true; break; }
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      let factor = 1.0;
      if (oceanMaskArr[i]) factor = 0.42 + 0.58 * coastProx[i];
      else if (anyLand && landEffArr[i]) factor = noise[i];
      d[p] = clampByte(d[p] * factor);
      d[p + 1] = clampByte(d[p + 1] * factor);
      d[p + 2] = clampByte(d[p + 2] * factor);
    }
    ctx.putImageData(img, 0, 0);

    return this.canvas;
  }
}

function clampByte(v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

export { W_TEX, H_TEX };
