// continents.js -- JS port of data.py's get_interpolated_continents(), operating
// on the exported continents.json (CONTINENTAL_SNAPSHOTS/SNAPSHOT_TIMES).
// Direct line-for-line port -- see data.py lines 434-527 for the Python original.

function smoothstep(x) {
  x = Math.max(0, Math.min(1, x));
  return x * x * (3.0 - 2.0 * x);
}

export class ContinentModel {
  constructor(continentsData) {
    this.snapshotTimes = continentsData.snapshot_times; // descending, oldest first
    this.snapshots = continentsData.snapshots;           // { "4300": [...], ... }
  }

  _snapshotAt(t) {
    return this.snapshots[String(t)] || [];
  }

  _centroid(continent) {
    let sx = 0, sy = 0, n = 0;
    for (const poly of continent.polys) {
      for (const [x, y] of poly) { sx += x; sy += y; n++; }
    }
    if (n === 0) return [0.5, 0.5];
    return [sx / n, sy / n];
  }

  _nearest(target, candidates) {
    if (!candidates.length) return null;
    const [tx, ty] = this._centroid(target);
    let best = null, bestD = Infinity;
    for (const c of candidates) {
      const [cx, cy] = this._centroid(c);
      const d = (cx - tx) ** 2 + (cy - ty) ** 2;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  _shiftPolys(polys, dx, dy) {
    return polys.map((poly) => poly.map(([x, y]) => [x + dx, y + dy]));
  }

  /** Returns continents with smoothly interpolated positions + per-continent alpha (0-255). */
  getInterpolatedContinents(ma) {
    const olderList = this.snapshotTimes.filter((t) => t >= ma);
    const newerList = this.snapshotTimes.filter((t) => t < ma);

    if (!olderList.length) return [];
    const olderT = Math.min(...olderList);

    if (!newerList.length) {
      const snap = this._snapshotAt(olderT);
      return snap.map((c) => ({ ...c, alpha: 255 }));
    }

    const newerT = Math.max(...newerList);
    const span = olderT - newerT;
    const frac = span > 0 ? (olderT - ma) / span : 0.0;
    const ease = smoothstep(frac);

    const oldConfig = this._snapshotAt(olderT);
    const newConfig = this._snapshotAt(newerT);

    const driftOld = ease * 0.5;
    const driftNew = (1.0 - ease) * 0.5;

    const BLEND = 0.15;
    const lo = 0.5 - BLEND / 2, hi = 0.5 + BLEND / 2;

    const result = [];

    if (frac < hi) {
      const aOld = frac <= lo ? 255 : Math.round(255 * (hi - frac) / BLEND);
      for (const oc of oldConfig) {
        const nc = this._nearest(oc, newConfig);
        let dx = 0, dy = 0;
        if (nc) {
          const [ocx, ocy] = this._centroid(oc);
          const [ncx, ncy] = this._centroid(nc);
          dx = (ncx - ocx) * driftOld;
          dy = (ncy - ocy) * driftOld;
        }
        result.push({ ...oc, polys: this._shiftPolys(oc.polys, dx, dy), alpha: aOld });
      }
    }

    if (frac > lo) {
      const aNew = frac >= hi ? 255 : Math.round(255 * (frac - lo) / BLEND);
      for (const nc of newConfig) {
        const oc = this._nearest(nc, oldConfig);
        let dx = 0, dy = 0;
        if (oc) {
          const [ncx, ncy] = this._centroid(nc);
          const [ocx, ocy] = this._centroid(oc);
          dx = (ocx - ncx) * driftNew;
          dy = (ocy - ncy) * driftNew;
        }
        result.push({ ...nc, polys: this._shiftPolys(nc.polys, dx, dy), alpha: aNew });
      }
    }

    return result;
  }
}
