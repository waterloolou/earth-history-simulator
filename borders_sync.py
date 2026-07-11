#!/usr/bin/env python3
"""
borders_sync.py -- One-time (manually-refreshed) download of historical
political border snapshots from the aourednik/historical-basemaps project
(https://github.com/aourednik/historical-basemaps, GPL-3.0), following
geo.py's download-once-and-cache pattern: fetched once into data/borders/,
committed, never fetched live by the browser or re-fetched automatically.

Run:
    python borders_sync.py --refresh

Powers the "Nations & Borders" mode: a Leaflet map showing country/empire
border polygons that update to the nearest available historical snapshot as
you scrub the timeline, from 123,000 BCE to 2010 CE.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
_OUT_DIR = os.path.join(_HERE, "data", "borders")
_INDEX_URL = "https://api.github.com/repos/aourednik/historical-basemaps/contents/geojson"
_RAW_BASE = "https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson/"
_USER_AGENT = "EarthHistorySimulatorBot/1.0 (https://github.com/waterloolou/earth-history-simulator)"

_FNAME_RE = re.compile(r"^world_(bc)?(\d+)\.geojson$")


def _year_from_filename(fname: str) -> int | None:
    m = _FNAME_RE.match(fname)
    if not m:
        return None
    bc, num = m.groups()
    year = -int(num) if bc else int(num)
    return year


def _list_remote_files() -> list[str]:
    req = urllib.request.Request(_INDEX_URL, headers={
        "Accept": "application/vnd.github+json", "User-Agent": _USER_AGENT,
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        entries = json.loads(resp.read().decode("utf-8"))
    return sorted(e["name"] for e in entries if _FNAME_RE.match(e["name"]))


def _simplify_ring(ring: list, tolerance: float) -> list:
    """Minimal Douglas-Peucker-ish decimation: drop points that are within
    `tolerance` degrees of the line between their neighbors. Cuts payload
    substantially for a small map without a full simplification library --
    good enough since borders are display-only here, not used for analysis."""
    if len(ring) <= 4:
        return ring

    def perp_dist(p, a, b):
        (px, py), (ax, ay), (bx, by) = p, a, b
        dx, dy = bx - ax, by - ay
        if dx == 0 and dy == 0:
            return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
        t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
        t = max(0.0, min(1.0, t))
        cx, cy = ax + t * dx, ay + t * dy
        return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5

    def dp(points):
        if len(points) <= 2:
            return points
        a, b = points[0], points[-1]
        idx, dist = -1, tolerance
        for i in range(1, len(points) - 1):
            d = perp_dist(points[i], a, b)
            if d > dist:
                idx, dist = i, d
        if idx == -1:
            return [a, b]
        left = dp(points[: idx + 1])
        right = dp(points[idx:])
        return left[:-1] + right

    return dp(ring)


_COORD_DECIMALS = 3  # ~110m at the equator -- plenty for a world-scale map


def _round_ring(ring: list) -> list:
    return [[round(x, _COORD_DECIMALS), round(y, _COORD_DECIMALS)] for x, y in ring]


def _simplify_geometry(geom: dict, tolerance: float) -> dict:
    def simplify_polygon(rings):
        # Round first (source data carries ~15 decimal digits of meaningless
        # float noise that bloats JSON size well beyond the DP simplification
        # below), then decimate collinear-ish points.
        return [_simplify_ring(_round_ring(r), tolerance) for r in rings]

    if geom["type"] == "Polygon":
        geom["coordinates"] = simplify_polygon(geom["coordinates"])
    elif geom["type"] == "MultiPolygon":
        geom["coordinates"] = [simplify_polygon(poly) for poly in geom["coordinates"]]
    return geom


def sync(tolerance: float = 0.02) -> None:
    os.makedirs(_OUT_DIR, exist_ok=True)
    files = _list_remote_files()
    print(f"Found {len(files)} snapshot files.")

    manifest = []
    for fname in files:
        year = _year_from_filename(fname)
        if year is None:
            continue
        url = _RAW_BASE + fname
        print(f"Fetching {fname} (year {year})...")
        req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as resp:
            gj = json.loads(resp.read().decode("utf-8"))

        before = len(json.dumps(gj))
        for feat in gj.get("features", []):
            if feat.get("geometry"):
                _simplify_geometry(feat["geometry"], tolerance)
        after = len(json.dumps(gj))

        out_name = f"world_{year}.geojson"
        with open(os.path.join(_OUT_DIR, out_name), "w", encoding="utf-8") as fh:
            json.dump(gj, fh, separators=(",", ":"))
        manifest.append({"year": year, "file": out_name, "features": len(gj.get("features", []))})
        print(f"  {before} -> {after} bytes ({100 * after // before}%), "
              f"{len(gj.get('features', []))} features")
        time.sleep(0.3)

    manifest.sort(key=lambda m: m["year"])
    with open(os.path.join(_OUT_DIR, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=1)
    print(f"\nWrote manifest.json ({len(manifest)} snapshots, {manifest[0]['year']} to {manifest[-1]['year']})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", required=True,
                     help="Confirm you intend to hit GitHub's API/raw content servers.")
    ap.add_argument("--tolerance", type=float, default=0.02,
                     help="Simplification tolerance in degrees (larger = smaller files, coarser shapes).")
    args = ap.parse_args()
    sync(tolerance=args.tolerance)


if __name__ == "__main__":
    main()
