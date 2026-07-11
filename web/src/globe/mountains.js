// mountains.js -- JS port of main.py's MOUNTAIN_RANGES + _mtn_frac + _draw_mountains.
// See main.py lines 357-490 for the Python originals.

export const MOUNTAIN_RANGES = [
  { name: "Himalayas", form: 55, erode: 0, height: 8.8, ridge: [[74, 36], [80, 33], [87, 29], [93, 27], [98, 27], [103, 26]] },
  { name: "Alps", form: 35, erode: 0, height: 4.8, ridge: [[6, 46], [10, 46], [14, 47]] },
  { name: "Pyrenees", form: 65, erode: 0, height: 3.4, ridge: [[-2, 43], [2, 43]] },
  { name: "Atlas", form: 65, erode: 0, height: 4.2, ridge: [[-5, 32], [1, 32], [8, 33]] },
  { name: "Zagros", form: 25, erode: 0, height: 4.5, ridge: [[48, 30], [53, 28], [58, 26]] },
  { name: "Caucasus", form: 25, erode: 0, height: 5.6, ridge: [[40, 43], [43, 43], [46, 43]] },
  { name: "Andes", form: 25, erode: 0, height: 6.9, ridge: [[-75, 9], [-72, 0], [-68, -18], [-68, -34], [-70, -51]] },
  { name: "Rockies", form: 80, erode: 0, height: 4.4, ridge: [[-121, 51], [-115, 45], [-108, 38], [-106, 32]] },
  { name: "Sierra Nevada", form: 100, erode: 0, height: 4.4, ridge: [[-121, 38], [-118, 36]] },
  { name: "Appalachians", form: 480, erode: 0, height: 2.2, ridge: [[-84, 34], [-80, 38], [-77, 42], [-74, 44]] },
  { name: "Urals", form: 390, erode: 0, height: 1.9, ridge: [[59, 51], [59, 57], [60, 62], [60, 67]] },
  { name: "Scandinavian", form: 410, erode: 0, height: 2.4, ridge: [[6, 58], [8, 62], [14, 67], [17, 70]] },
  { name: "Caledonian", form: 490, erode: 370, height: 5.0, ridge: [[-10, 55], [0, 57], [8, 61], [14, 66], [18, 70]] },
  { name: "Variscan", form: 380, erode: 200, height: 4.0, ridge: [[-4, 48], [4, 49], [10, 50], [16, 49], [22, 48]] },
  { name: "Acadian", form: 375, erode: 320, height: 4.5, ridge: [[-74, 40], [-71, 43], [-66, 46]] },
  { name: "Taconic", form: 490, erode: 440, height: 3.5, ridge: [[-74, 40], [-71, 43]] },
  { name: "Anc. Rockies", form: 320, erode: 280, height: 3.0, ridge: [[-108, 38], [-105, 34]] },
  { name: "Pan-African", form: 620, erode: 500, height: 4.5, ridge: [[25, -10], [30, -20], [35, -30], [38, -38]] },
  { name: "Trans-Saharan", form: 600, erode: 520, height: 4.0, ridge: [[8, 20], [12, 18], [18, 16]] },
];

export function mtnFrac(rng, ma) {
  const fm = rng.form, em = rng.erode;
  if (ma > fm) return 0.0;
  if (em > 0 && ma < em) return 0.0;
  const age = fm - ma;
  if (em > 0) {
    const span = fm - em;
    const t = age / span;
    if (t < 0.25) return t / 0.25;
    return (1.0 - t) / 0.75;
  }
  return Math.min(1.0, age / Math.max(fm * 0.40, 15.0));
}

/** Paint mountain ranges (outer/inner/snow ellipses) onto a 2D canvas context
 * sized (wTex, hTex), matching main.py's _draw_mountains(). */
export function drawMountains(ctx, wTex, hTex, ma) {
  for (const rng of MOUNTAIN_RANGES) {
    const frac = mtnFrac(rng, ma);
    if (frac < 0.06) continue;
    const effH = rng.height * frac;

    const rOuter = Math.max(6, Math.round(effH * 3.5));
    const rInner = Math.max(4, Math.round(effH * 2.0));
    const rSnow = Math.max(2, Math.round(effH * 0.9));

    let cOuter, cInner, cSnow;
    if (effH >= 5.5) { cOuter = [148, 132, 115]; cInner = [188, 182, 172]; cSnow = [238, 240, 244]; }
    else if (effH >= 3.5) { cOuter = [142, 128, 110]; cInner = [172, 165, 152]; cSnow = [215, 218, 222]; }
    else if (effH >= 2.0) { cOuter = [130, 120, 102]; cInner = [155, 148, 132]; cSnow = [188, 188, 182]; }
    else { cOuter = [125, 118, 98]; cInner = [140, 132, 115]; cSnow = [158, 155, 148]; }

    for (const [lon, lat] of rng.ridge) {
      const tx = Math.round((lon + 180) / 360 * wTex);
      const ty = Math.round((90 - lat) / 180 * hTex);
      if (tx < 0 || tx >= wTex || ty < 0 || ty >= hTex) continue;

      const layers = [
        [rOuter, 0.55, cOuter, 175 / 255],
        [rInner, 0.55, cInner, 195 / 255],
        [rSnow, 0.60, cSnow, 210 / 255],
      ];
      for (const [rx, ryFrac, col, alpha] of layers) {
        const ry = Math.max(2, Math.round(rx * ryFrac));
        ctx.globalAlpha = alpha;
        ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
        ctx.beginPath();
        ctx.ellipse(tx, ty, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1.0;
}
