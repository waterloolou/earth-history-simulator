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

Re-measured 2026-07-15 (headless Chromium via Playwright, cold run, no JIT
warmup) alongside the worker-offload change below — treat these as the
current reference point; the original review's numbers were from a different
session/environment and PERF.md's own rule is to compare same-session, not
against old absolutes.

| Metric | Expectation | Notes |
|---|---|---|
| Structural texture build (`StructuralTextureBuilder.build`, direct, sync path) | ~35–80 ms per call in a cold headless run (10-sample avg ~50 ms across ma 4300→0.5) | Same algorithm as before this session (untouched) — this is now the *fallback* path, not the hot path. The dominant cost is per-polygon rasterize+blur, bbox-restricted. Re-verify pixel-identity vs. previous output if you touch `terrainNoise`/`splatPolyRegion`/`boxBlur`. |
| Structural texture build, **worker path** (`structuralTexture.worker.js`) | ~150–400 ms wall-clock roundtrip per build (one outlier at ~1000 ms in a 10-in-a-row synthetic burst); **~0 ms of that is main-thread block time** | Higher wall-clock than the sync path (postMessage/structured-clone + one-time worker module startup amortized into the first call) is expected and *fine* — the entire point is that none of it blocks rendering/input. `globeView.setMa()` keeps the previous texture on screen until the `built` message lands in `_structuralCache`. Verify by confirming the timeline/globe stay responsive during a fast scrub, not by chasing this number toward the sync path's. |
| One structural rebuild *request* per `setMa()` | At most one `build()`/worker-`postMessage` per call, only on Ma-bucket change | `globeView.setMa()` guards on `bucket !== _lastStructuralBucket`; the worker path additionally guards on `_pendingBuildBucket` so a still-in-flight bucket isn't re-requested every frame. |
| Structural cache | Capped at `STRUCTURAL_CACHE_MAX` (60); evicted textures are `.dispose()`d, and worker-sourced ones also `.close()` their backing `ImageBitmap` | Watch WebGL memory during a long deep-time scrub — it must plateau, not climb. |
| `events.json` shards, total raw transfer | ~19.5 MB raw as of 2026-07-15 (34,851 events across 4 categories) | Grown from the ~7 MB noted in the original review — dataset growth from the Wikidata pipeline over time, not a regression from any change in this session (the export pipeline wasn't touched). Still fetched **after** the app is interactive (see `dataLoader.loadEvents`), so it must never gate time-to-interactive; re-couple it into `loadCoreData()` and this becomes a real problem at this size. |
| Time-to-interactive | ~840 ms (cold headless run) | Gated only by the small core JSON (`continents.json`) + textures. Verify by throttling the network and confirming the loading overlay hides well before the events shards finish. |
| `mapView.setEvents` (All Events mode, ~30k+ raw events, ~95+ marker/cluster icons render) | Map visibly populated in ~1.1 s wall-clock in a cold headless run | This measures end-to-end (network + chunked insert + paint), not isolated main-thread block time — the architectural guarantee that matters (chunked insert never blocks a frame) was verified functionally instead: the app stayed responsive to clicks/drags throughout rapid mode-switch and rapid-search stress tests during this session (see `smoke4.js`/`smoke5.js`-style scripts), not just by this one number. |

## Known follow-ups (not yet done)

_(none currently — the Web Worker offload for the structural build, previously
listed here, shipped; see the `structuralTexture.worker.js` row above.)_

## Known limitations (investigated, accepted)

- **`leaflet.markercluster@1.5.3` has no way to cancel an in-flight chunked
  `addLayers()` or an in-flight `zoomToShowLayer()` animation.** `mapView.js`'s
  `_settling`/`whenSettled()`/queued-`setEvents()` machinery (see its comments)
  closes every *reachable-by-a-real-user* race this causes — confirmed via
  direct inspection of the library source (no `chunkend` event exists;
  `chunkProgress` fires *before* the batch's bounds/DOM are finalized;
  `setPinsVisible(false)` mid-batch used to detach the map reference out from
  under a still-running chunk). `MapView.focusEvent()` also wraps
  `zoomToShowLayer` in try/catch as a last-resort fallback to a plain pan.
  One narrower case remains open: firing five-plus searches back-to-back with
  ~80ms between each (far faster than a human can type a query and click a
  result — reproduced only via a scripted Playwright stress test, see
  `smoke4.js`-style rapid-fire clicking) can still surface a benign, self-
  healing exception from deep inside Leaflet's own async animation-completion
  bookkeeping (`_animationEnd`/`_processQueue`), outside any synchronous call
  this app's code controls. The map always ends the sequence in the correct
  final state (each `setEvents()` fully clears+rebuilds), so this has no
  observed user-facing effect — logged here rather than chased further, since
  fully eliminating it would mean working around a genuine architectural gap
  in a third-party library at diminishing-returns effort for an input speed
  no real user produces.
