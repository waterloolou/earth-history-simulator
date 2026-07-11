// structuralTexture.js -- Canvas2D procedural equirect texture builder.
//
// Unified renderer used for the ENTIRE timeline (0-4500 Ma), not just the deep
// past. Earlier versions of this app switched between three visually distinct
// rendering styles as you scrubbed through time (procedural blob continents,
// then real Scotese/PALEOMAP paleogeography photos, then NASA Blue Marble
// satellite imagery) -- accurate to the original pygame app, but it read as
// three different apps stitched together. This version always renders through
// the same illustrated-biome-map pipeline (continent shapes -> biome color by
// latitude/era -> mountains -> ice caps -> terrain texture), so the ONLY thing
// that changes continuously across the whole timeline is the underlying
// continent shape data (blob-splatted for deep time where shapes are genuinely
// just an artist's approximation, real Natural Earth polygons for 0/65 Ma,
// hand-authored polygons for the keyframes between) and how much blur/noise is
// applied (more for deep time, where the "fuzziness" honestly reflects how
// little is actually known about exact coastlines that far back; down to a
// light touch for the present day, where real coastlines stay crisp).

import { oceanPair, biomeColor } from "./biome.js";
import { drawMountains } from "./mountains.js";

const W_TEX = 720, H_TEX = 360;
const ICE_BRIGHT = [255, 255, 255];
const ICE_DARK = [220, 235, 255];

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

/** Separable box blur (3 passes ~= Gaussian), operating on a Float32Array
 * single-channel buffer of size w*h, values in [0, 1]. */
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

/** How "uncertain"/artistic the continent shapes should look at this Ma,
 * 0 (present day, crisp real coastlines) -> 1 (deep time, soft artistic blobs).
 * Smoothstep so the whole timeline transitions gradually with no seam. */
function uncertaintyFrac(ma) {
  const t = clamp(ma / 4500, 0, 1);
  return t * t * (3.0 - 2.0 * t);
}

/** Scanline-fill one polygon into a single-channel Float32 mask region (values
 * 0/1). Vertices are given in [0,1] texture coords; they're scaled to whole-
 * image px and offset by the region origin (x0,y0). Uses the even-odd rule,
 * which matches canvas fill for the simple, non-self-intersecting continent/
 * coastline polygons this app deals with. Replaces the old per-polygon canvas
 * + getImageData rasterizer: at present day one build splats ~118 real
 * Natural-Earth polygons, and 118 separate getImageData GPU read-backs cost
 * ~78ms of a ~105ms build. A pure-JS scanline fill has no read-back; the ~1px
 * of edge antialiasing lost is irrelevant since the mask is box-blurred and
 * then hard-thresholded at 0.30 downstream. */
function scanlineFill(mask, poly, w, h, x0, y0, sw, sh) {
  const n = poly.length;
  const vx = new Float64Array(n), vy = new Float64Array(n);
  for (let i = 0; i < n; i++) { vx[i] = poly[i][0] * w - x0; vy[i] = poly[i][1] * h - y0; }
  const xs = [];
  for (let sy = 0; sy < sh; sy++) {
    const yc = sy + 0.5;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = vy[i], yj = vy[j];
      if ((yi <= yc && yj > yc) || (yj <= yc && yi > yc)) {
        xs.push(vx[i] + (yc - yi) / (yj - yi) * (vx[j] - vx[i]));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const rowOff = sy * sw;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let xa = Math.round(xs[k]), xb = Math.round(xs[k + 1]) - 1;
      if (xa < 0) xa = 0;
      if (xb >= sw) xb = sw - 1;
      for (let x = xa; x <= xb; x++) mask[rowOff + x] = 1;
    }
  }
}

/** Rasterize + blur one polygon into `accumulated` (a full-image w*h buffer),
 * doing the scanline fill and box blur only inside the polygon's bounding box
 * padded by the blur's finite support (3*radius for a 3-pass box blur) --
 * bit-identical (post-threshold) to blurring the full image, but far cheaper
 * for a continent covering a fraction of the 720x360 map. */
function splatPolyRegion(accumulated, poly, w, h, aFrac, radius) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    const px = x * w, py = y * h;
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  }
  const pad = 3 * radius + 2;
  const x0 = Math.max(0, Math.floor(minX) - pad);
  const y0 = Math.max(0, Math.floor(minY) - pad);
  const x1 = Math.min(w, Math.ceil(maxX) + pad + 1);
  const y1 = Math.min(h, Math.ceil(maxY) + pad + 1);
  const sw = x1 - x0, sh = y1 - y0;
  if (sw < 1 || sh < 1) return;

  const mask = new Float32Array(sw * sh);
  scanlineFill(mask, poly, w, h, x0, y0, sw, sh);

  const blurred = boxBlur(mask, sw, sh, radius);
  for (let sy = 0; sy < sh; sy++) {
    const dstRow = (y0 + sy) * w + x0;
    const srcRow = sy * sw;
    for (let sx = 0; sx < sw; sx++) accumulated[dstRow + sx] += blurred[srcRow + sx] * aFrac;
  }
}

/** Simple value-noise FBM (5 sine octaves), stable per 10-Ma bucket. Perf: the
 * per-pixel term sin(xx)*cos(yy) is separable, so each octave costs ~(w+h)
 * trig calls instead of ~2*w*h; the finished field is memoized per seed. */
const _terrainNoiseCache = new Map();
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
  const result = new Float32Array(w * h);
  for (let i = 0; i < noise.length; i++) result[i] = (noise[i] - min) / range;
  const blurred = boxBlur(result, w, h, 4);

  _terrainNoiseCache.set(seed, blurred);
  if (_terrainNoiseCache.size > TERRAIN_NOISE_CACHE_MAX) {
    _terrainNoiseCache.delete(_terrainNoiseCache.keys().next().value);
  }
  return blurred;
}

/** Ice cap coverage for `ma`, as a list of {north, south} cap heights (0-1
 * fraction of texture height) and colors. Ported from main.py's five
 * glaciation windows (lines 906-948); previously only the Huronian window
 * (entirely > 750 Ma) was reachable since Scotese overwrote everything else --
 * now that this builder draws the whole timeline, all five apply for real. */
function iceCapsFor(ma, h) {
  const caps = []; // {y0, y1, color, alpha}
  if (ma >= 2050 && ma <= 2400) {
    let frac = clamp(1.0 - Math.abs(ma - 2250) / 150.0, 0, 1);
    frac = Math.max(0.30, frac);
    const capH = Math.max(5, Math.round(h * 0.08 + h * 0.38 * frac));
    caps.push({ y0: 0, y1: capH, color: ICE_BRIGHT, alpha: 0.843 });
    caps.push({ y0: h - capH, y1: h, color: ICE_DARK, alpha: 0.824 });
  } else if (ma >= 635 && ma <= 720) {
    let frac = clamp((720 - ma) / 85.0, 0, 1);
    frac = Math.max(0.28, frac);
    const capH = Math.max(5, Math.round(h * 0.08 + h * 0.40 * frac));
    caps.push({ y0: 0, y1: capH, color: ICE_BRIGHT, alpha: 0.882 });
    caps.push({ y0: h - capH, y1: h, color: ICE_DARK, alpha: 0.863 });
  } else if (ma >= 435 && ma <= 450) {
    const frac = 1.0 - Math.abs(ma - 442.5) / 7.5;
    const capH = Math.max(1, Math.round(h * 0.02 + h * 0.08 * frac));
    caps.push({ y0: h - capH, y1: h, color: ICE_BRIGHT, alpha: 0.765 });
  } else if (ma >= 260 && ma <= 360) {
    let frac = ma >= 300 ? (360 - ma) / 60 : (ma - 260) / 40;
    frac = Math.pow(clamp(frac, 0, 1), 0.6);
    const capH = Math.max(1, Math.round(h * 0.03 + h * 0.12 * frac));
    caps.push({ y0: h - capH, y1: h, color: ICE_BRIGHT, alpha: 0.804 });
  } else if (ma < 34) {
    if (ma < 2.6) {
      const capH = Math.max(1, Math.round(h * 0.03));
      caps.push({ y0: 0, y1: capH, color: ICE_BRIGHT, alpha: 0.745 });
      caps.push({ y0: h - capH, y1: h, color: ICE_DARK, alpha: 0.725 });
    } else {
      const frac = clamp(1.0 - ma / 34.0, 0, 1);
      const capH = Math.max(1, Math.round(h * 0.020 + h * 0.012 * frac));
      caps.push({ y0: h - capH, y1: h, color: ICE_DARK, alpha: 0.675 });
    }
  }
  return caps;
}

export class StructuralTextureBuilder {
  constructor() {
    this.canvas = makeCanvas(W_TEX, H_TEX);
    // willReadFrequently: build() does several getImageData readbacks per frame
    // (ocean base, composite re-read for noise) -- flag the context so the
    // browser keeps it on a CPU-readback-friendly path instead of warning.
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
  }

  /** Build the equirect texture for time `ma` (any value, 0-4500). Returns
   * the internal canvas (reused across calls -- callers must finish
   * using/uploading it before the next build() call). */
  build(ma, continentModel) {
    const ctx = this.ctx;
    const w = W_TEX, h = H_TEX;
    const uncertainty = uncertaintyFrac(ma); // 0=crisp present day, 1=fuzzy deep time

    // ── ocean gradient base ────────────────────────────────────────────────
    const [shallow, deep] = oceanPair(ma);
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0.0, `rgb(${deep[0]},${deep[1]},${deep[2]})`);
    grad.addColorStop(0.5, `rgb(${shallow[0]},${shallow[1]},${shallow[2]})`);
    grad.addColorStop(1.0, `rgb(${deep[0]},${deep[1]},${deep[2]})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    const oceanImg = ctx.getImageData(0, 0, w, h);

    // ── continents: blob-splatted at a blur radius that scales with how
    // uncertain/artistic the reconstruction is at this Ma. Crisp real
    // coastlines (0/65 Ma) get a light 2-6px touch; deep-time approximations
    // get the old 14-32px soft-blob treatment. ─────────────────────────────
    const continents = continentModel.getInterpolatedContinents(ma);
    const accumulated = new Float32Array(w * h);
    const floorPx = lerp(2, 14, uncertainty);
    const ceilPx = lerp(6, 32, uncertainty);
    for (const c of continents) {
      const aFrac = (c.alpha ?? 255) / 255.0;
      if (aFrac < 0.02) continue;
      for (const poly of c.polys) {
        if (poly.length < 3) continue;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const [x, y] of poly) {
          const px = x * w, py = y * h;
          if (px < minX) minX = px; if (px > maxX) maxX = px;
          if (py < minY) minY = py; if (py > maxY) maxY = py;
        }
        const geoMean = Math.pow((maxX - minX + 1) * (maxY - minY + 1), 0.4);
        const br = clamp(Math.round(geoMean * 0.30), floorPx, ceilPx);
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

    // light full-image blur for colour-transition softening, also scaled down
    // for recent times so present-day coastlines stay comparatively crisp
    ctx.filter = `blur(${lerp(1.0, 2.5, uncertainty).toFixed(2)}px)`;
    ctx.drawImage(this.canvas, 0, 0);
    ctx.filter = "none";

    // ── terrain noise + coastal depth-dimming, using the land mask we
    // already computed (no need to re-derive it from output color, since
    // we generated the composite ourselves and know exactly which pixels are
    // land). Noise strength also scales with uncertainty: a light touch at
    // present day, a fuller mottled "unknown ancient terrain" look far back. ─
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const coastMaskFloat = new Float32Array(w * h);
    for (let i = 0; i < landMask.length; i++) coastMaskFloat[i] = landMask[i];
    const coastProx = boxBlur(coastMaskFloat, w, h, 8);
    const noise = terrainNoise(ma, w, h);
    const noiseAmp = lerp(0.06, 0.40, uncertainty);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      let factor = 1.0;
      if (!landMask[i]) factor = 0.55 + 0.45 * coastProx[i];
      else factor = (1 - noiseAmp) + noiseAmp * 2 * noise[i];
      d[p] = clampByte(d[p] * factor);
      d[p + 1] = clampByte(d[p + 1] * factor);
      d[p + 2] = clampByte(d[p + 2] * factor);
    }
    ctx.putImageData(img, 0, 0);

    // ── mountains (drawn crisply on top of the noised base) ─────────────────
    drawMountains(ctx, w, h, ma);

    // ── ice caps (all five glaciation windows now reachable) ────────────────
    for (const cap of iceCapsFor(ma, h)) {
      ctx.fillStyle = `rgba(${cap.color[0]},${cap.color[1]},${cap.color[2]},${cap.alpha})`;
      ctx.fillRect(0, cap.y0, w, cap.y1 - cap.y0);
    }

    return this.canvas;
  }
}

function clampByte(v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

export { W_TEX, H_TEX };
