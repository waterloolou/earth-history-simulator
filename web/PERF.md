# Web app performance checklist

This app has no automated test/perf suite. This is a lightweight manual checklist
plus the concrete baselines measured during the performance review, so a future
change can notice a regression. Numbers are order-of-magnitude tripwires, not
hard SLAs — they shift with machine load, so always compare before/after **in the
same session**, not against the absolute figures below.

## How to profile

```bash
python scripts/export_data.py --out web/public/data --textures-out web/public/textures
cd web && npm start
```

Then, in a scratch dir *outside* the repo (so it doesn't pollute a commit):
`npm install playwright`, and drive `http://127.0.0.1:8899/index.html` with the
DevTools protocol (`performance.now()` deltas, `Network.emulateNetworkConditions`).
Reference scripts used during the review measured: JSON parse cost, per-Ma
structural build cost, `mapView.setEvents` cost, and time-to-interactive under a
throttled link.

## Baselines / tripwires

| Metric | Expectation | Notes |
|---|---|---|
| Structural texture build (`StructuralTextureBuilder.build`, ma>750) | ~10–20 ms on an unloaded desktop (≈ one frame) | The dominant cost is per-polygon rasterize+blur; it is restricted to each polygon's bounding box. A regression here shows up as deep-time globe stutter on the *default* startup path (globe auto-plays from 4500 Ma). Re-verify pixel-identity vs. the previous output if you touch `terrainNoise`/`splatPolyRegion`/`boxBlur`. |
| One structural rebuild per `setMa()` | At most one `build()` per call, only on Ma-bucket change | `globeView.setMa()` guards on `bucket !== _lastStructuralBucket`. |
| Structural / Scotese caches | Capped at `STRUCTURAL_CACHE_MAX` (60) and `SCOTESE_CACHE_MAX` (24); evicted textures are `.dispose()`d | Watch WebGL memory during a long deep-time scrub — it must plateau, not climb. |
| `events.json` payload | ~7 MB raw / ~0.8 MB gzip (GitHub Pages gzips automatically) | Fetched **after** the app is interactive (see `dataLoader.loadEvents`), so it must never gate time-to-interactive. If you re-couple it into the initial `loadCoreData()` path, TTI regresses on slow links by seconds. |
| Time-to-interactive | Gated only by the small core JSON (`continents.json` ≈ 120 KB gzip is the largest) + textures | Verify by throttling the network and confirming the loading overlay hides well before `events.json` finishes. |
| `mapView.setEvents` (~6.9k geolocated events) | Non-blocking; synchronous portion a few hundred ms at most | Uses bulk `cluster.addLayers()` + `chunkedLoading`, and builds popup HTML lazily on open. A regression to per-marker `addLayer` or eager popup strings pushes this back over a second of main-thread block. |

## Known follow-ups (not yet done)

- **Web Worker + OffscreenCanvas for the structural build** (plan-sanctioned):
  even after the bbox optimization the build is ~one frame, so a fast deep-time
  scrub on a low-end/mobile GPU can still drop the occasional frame. Moving
  `build()` into a worker would keep the render loop at a steady frame rate by
  swapping the new texture in when ready and showing the previous one meanwhile.
- **`image_url` is exported but unused** by the runtime (no thumbnail UI yet); it
  is a meaningful slice of `events.json`. Drop it from the export, or add the
  thumbnail popup the field was intended for.
