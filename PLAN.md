# Earth History Simulator — Public Web App: Zoomable Timeline + Historical/Scientific Events + Browser-Native Globe

## Context

The simulator today is a Python desktop app (pygame window): a single float `current_ma`
sweeps linearly from `START_MA=4300` to `END_MA=0` (present), driving a procedurally
rendered 3D paleogeographic globe built in `main.py` from data in `data.py`/`geo.py`
(`PERIODS`, `CONTINENTAL_SNAPSHOTS`, a Tree-of-Life overlay). The timeline bar is
linear-scaled across the full 4.3-billion-year span, so all of human history occupies a
few pixels — there's no way to zoom in, and no data model for discrete point-in-time
events at all.

The user wants to zoom into recent history and show not just geological events but
historical events, scientific achievements, and other Wikipedia-scale content, with the
visualization switching form depending on what's being shown. Through several rounds of
clarification, the scope settled here:

1. **One public web app**, hosted on **GitHub Pages** (static hosting only — no live
   server), deployed via **GitHub Actions** on push to `main`. This supersedes an earlier,
   smaller idea (pygame app handing off to a local browser tab); the user explicitly
   wants the whole experience, including the deep-time globe, as one hosted site.
2. The existing pygame app (`main.py`/`data.py`/`geo.py`) is **kept as an unmaintained
   legacy/offline mode** — not deleted, but no further feature work targets it. All new
   work (zoomable timeline, events, map view, browser-native globe) goes into a new
   `web/` app.
3. The deep-time globe gets **reimplemented in JavaScript/WebGL** (via Three.js), not
   pre-baked as flat keyframe images — generated live in-browser at arbitrary Ma, same as
   Python does today, so there are no visible keyframe seams.
4. **Event ingestion is staged**: a hand-curated seed dataset first, then an automated
   Wikidata SPARQL pipeline layered on top (Wikipedia sitelink count as the practical
   notability filter standing in for "every Wikipedia page that could be modeled").
5. **Cache-once, not live**: event/Wikidata data is synced manually into a local file
   (mirroring `geo.py`'s existing download-once-and-cache pattern) and committed; the
   Actions workflow builds/deploys from committed data — it never live-queries Wikidata.

This is a large, multi-phase project. The plan below is sequenced to de-risk the
CI/CD plumbing and data foundation first, ship the (comparatively lower-risk) timeline
and historical-map features early, and treat the browser globe port — genuinely the
hardest, most novel piece of engineering here — as its own long, sub-phased,
screenshot-verified effort that can proceed in parallel with or after the map/timeline
ship, without blocking them.

## Unified event data model (`events.py`, new — Python, build-time only)

A single `Event` schema represents both existing deep-time content (wrapped via
adapters, not duplicated) and new discrete events. This is pure Python, run only at
data-export time — the web app never runs Python at runtime.

```python
@dataclass
class EventTime:
    ma: float                  # canonical coarse position (always set; drives cross-era sorting)
    year: int | None = None    # astronomical year numbering (negative = BCE); precise recent time
    month: int | None = None
    day: int | None = None
    end_ma: float | None = None
    end_year: int | None = None
    precision: str = "ma"      # "period" | "ma" | "millennium" | "century" | "year" | "day" ...

@dataclass
class Place:
    lat: float | None = None
    lon: float | None = None
    region: str | None = None  # fallback label when there's no exact point

@dataclass
class Event:
    id: str
    title: str
    category: str        # "geological_period" | "tree_of_life" | "historical" | "scientific" | "cultural"
    subtype: str          # "battle" | "treaty" | "discovery" | "invention" | "birth" | "death" | "era" | ...
    time: EventTime
    viz_mode: str          # "globe_deep_time" | "map" | (future: "gallery"/"network_graph"/"tol")
    place: Place | None = None
    description: str = ""
    image_url: str | None = None
    color: tuple | None = None
    wiki: dict = field(default_factory=dict)   # {title, qid, url}
    source: str = "seed"    # "seed" | "wikidata" | "geo_runtime"
    extra: dict = field(default_factory=dict)
```

`ma` is a coarse float used only for cross-era ordering/culling over the full 4.5 Gy
span; recent/discrete events carry exact `year/month/day` as the source of truth,
avoiding float-precision loss at the "zoomed in" end of the scale.

`events.py` adds **non-destructive adapters** — `periods_as_events()` wraps
`data.PERIODS`, `tol_as_events()` wraps `main._TOL_DATA` — so `data.py`/`main.py` stay
untouched and the legacy pygame app keeps working exactly as today; the adapters just
let the new export pipeline (below) treat everything through one interface.

## Data export pipeline (Python → static JSON, run in CI, no live server)

New `scripts/export_data.py`: imports `data` (triggering `_init_geo()`, populating real
0/65 Ma coastlines from `geo.py`), and writes to `web/public/data/`:
- `periods.json`, `diversity.json`, `continents.json` (all `CONTINENTAL_SNAPSHOTS` keys,
  not just 0/65 Ma) — dumped straight from `data.py`, which stays the single source of
  truth for geological content.
- `events.json` — the merged hand-curated + Wikidata event set (see ingestion section),
  filtered/shaped for the web app.
- `plate_offset.png` — a small RG-encoded texture built from `geo._OFFSET_65MA`, used by
  the browser globe's plate-drift displacement shader (see below).

This script has no network dependency at CI time: `ne_land_110m.geojson`,
`blue_marble.jpg`, `cloud_layer.jpg`, and `paleo_textures/*.jpg` currently exist locally
but are gitignored (downloaded once at runtime by `geo.py`/`main.py`) — **un-gitignore
and commit all of them** so the export/build has no external-network dependency and so
the web app can load them same-origin (see CORS rationale below). Total payload ≈ under
3MB, trivial for git and GitHub Pages limits.

## Web app structure (`web/`, new — no build step)

Plain static site: `web/index.html`, `web/src/*.js` (native ES modules), `web/style.css`,
`web/public/data/*.json` (generated), `web/public/textures/` (committed assets). Three.js
and Leaflet are loaded via CDN + an import map — **no bundler (webpack/vite), no
npm/Node in CI** — appropriate at this scope (one real dependency, no TypeScript, single
maintainer) and it keeps the Actions workflow Python-only. One concrete gotcha this
requires respecting throughout: GitHub Pages serves this as a **project site**
(`https://<user>.github.io/earth-history-simulator/`), so every asset path/import/fetch
must be relative, never a leading `/`, or production 404s while local testing looks fine.

### Zoomable timeline

Ported conceptually 1:1 from the original pygame design, implemented as a JS component
(canvas or SVG) with the same windowed-view model:
- `tlLoMa`/`tlHiMa` state (visible window), starting at the full `0..4300` range —
  identical to today's pygame default view.
- **Zoom**: mouse-wheel, zoom-to-cursor (`zoomTimeline(factor, pivotMa)`), clamped and
  floored at a minimum span.
- **Pan**: drag.
- **Drill-down**: double-click a `PERIODS` segment pushes the window onto a breadcrumb
  stack and zooms to exactly that period's range; a "back" affordance pops it.
- **Discrete event markers**: once the visible span drops below ~3 Ma (inside the
  Quaternary), plot small colored tick+dot markers from `events.json` for
  `historical`/`scientific`/`cultural` categories.

### Mode dispatch: globe vs. historical map

A single `viewportMode` state (`"globe" | "map"`, extensible later to `"gallery"`/
`"tol"`), switched automatically once the timeline's visible span crosses the same
threshold used for markers (or manually via a toggle) — this is the concrete answer to
"the timeline image feature will change based on which kind of data you want to
display," now happening in one page instead of a separate handoff. A small
`viewRenderers = { globe: GlobeView, map: MapView }` dispatch object keeps this a
one-entry-per-mode addition, not branching logic.

### Historical map mode

Leaflet (CDN) + `Leaflet.markercluster`, CartoDB Positron/Voyager tiles (no API key).
Pins colored/iconized by `category`, popups with title/thumbnail/description/"Read more
on Wikipedia →" link, filtered live to the timeline's current visible year range. This
is the lower-risk, conventional piece of the web app — build and ship it before the
globe port is finished; it does not depend on the globe at all.

### Deep-time globe mode (the hard part — JS/WebGL port of `main.py`'s rendering)

**Split: Canvas2D/JS for structural geometry, GLSL for photographic blends.**

| Layer | Implementation | Rationale |
|---|---|---|
| Ocean gradient, polygon continents (≤750 Ma), mountains, ice caps | Canvas2D, 1:1 port of `_make_equirect_tex`'s polygon/ellipse/rect drawing and `biome_color` | Irregular per-object geometry; Canvas2D is the natural fit, changes rarely (bucketed by Ma) |
| Gaussian-blob splatting (>750 Ma) | Plain JS over typed arrays: per-polygon mask → 3-pass box blur with polygon-specific radius → accumulate into a shared `Float32Array` → threshold at 0.30 | CSS `filter:blur()` can't give each of ~10-20 polygons its own radius before accumulating; this is a direct, cheap (~ms-scale on 720×360) port of the numpy/PIL pipeline |
| Scotese keyframe blend, Blue Marble blend, plate-drift displacement, cloud scroll | GLSL, in a custom `THREE.ShaderMaterial` fragment shader, driven by cheap per-frame scalar uniforms (`uScoteseFrac`, `uBMWeight`, `uPlateFrac`, `uCloudScroll`) | Pure texture-to-texture blends with continuously varying weights — ideal shader work, and moving them off the CPU makes Ma-scrubbing smooth with zero canvas rebuild per frame |
| Lambertian shading + atmospheric rim-glow | GLSL, computed from mesh normal + fixed light dir `(0.38, 0.52, 0.76)`, formula `color * (0.10 + 0.90*ndotl)` plus a Fresnel rim term, matching `_ortho_project`'s exact formula | Direct port of existing shading math onto per-fragment normals instead of a precomputed lookup table |

**Plate-drift displacement** (the trickiest single piece): precompute, at export time
(not per-frame), a small RG-encoded offset texture from `geo._OFFSET_65MA`
(`plate_offset.png` above). In the fragment shader:
```glsl
vec2 offset = (texture2D(uPlateOffset, vUv).rg - 0.5) / 4.0;
vec2 displacedUv = vUv - offset * uPlateFrac;   // uPlateFrac = clamp(ma/65, 0, 1)
vec3 bm = texture2D(uBlueMarble, displacedUv).rgb;
```
This replaces Python's per-pixel numpy fancy-indexing gather with a native GPU texture
sample — zero marginal CPU cost regardless of framerate.

**Sphere/camera setup**: `THREE.SphereGeometry(1, 96, 96)` + `THREE.OrthographicCamera`
(not Perspective — Python's `_ortho_project` is a true orthographic projection; a
perspective camera would introduce limb distortion that doesn't match today's look) +
a custom `ShaderMaterial` (not `MeshStandardMaterial`, since the blend logic is bespoke,
not standard PBR).

**Rotation/inertia**: custom ~50-line pointer controller, not `OrbitControls` (its
damping model doesn't match Python's exponential-decay-per-real-second spin). Direct
port of `main.py`'s drag logic (`dps = 180/R` pixel-to-degree scale, latitude clamp
±85°) and its release-inertia (`velocity *= exp(-3.5*dt)` per frame).

**Textures loaded same-origin, not fetched live from third parties**: committing
Scotese/Blue Marble/cloud assets into the repo (see export section above) avoids a real
CORS/tainted-canvas risk — the app needs actual pixel manipulation (`getImageData`/
`texImage2D`), not just `<img>` display, so cross-origin sources without permissive CORS
headers would fail unpredictably in production. Carry forward the existing Scotese/
PALEOMAP attribution into the web app's UI.

**Caching**: keep Python's `_tex_cache` tier (an LRU `Map` keyed by
`Math.floor(ma/CACHE_MA_STEP)*CACHE_MA_STEP`, same `CACHE_MA_STEP=3` starting point,
~60-entry cap) for the Canvas2D structural layer only, rebuilding it only when `ma`
crosses into a new bucket. Python's second cache tier (`_globe_cache`, keyed by view
angle) simply disappears — the GPU reprojects/shades every frame at zero marginal cost
regardless of rotation, so per-angle caching is unneeded. Throttle to at most one
structural-texture rebuild per animation frame during rapid scrubbing; only reach for a
Web Worker + `OffscreenCanvas` if profiling shows the >750 Ma blob-splatting branch
dropping frames.

**Phased sub-plan (each phase independently screenshot-verifiable against the Python
app before adding the next layer of complexity)**:
1. Port `get_interpolated_continents` + centroid-matching to JS as pure functions over
   the exported `continents.json`; verify by numeric diff against Python output at
   matched Ma values (no pixels yet).
2. Flat Canvas2D equirect render, ≤750 Ma branch only (ocean + polygon continents +
   biome coloring + mountains + ice caps), no sphere yet. Screenshot-diff against a
   Python-side dump of `_make_equirect_tex(ma)` at 0/65/150/300/500/750 Ma. Highest-value
   early checkpoint — isolates coordinate/color bugs before any 3D complexity.
3. Add Gaussian-blob splatting for >750 Ma; verify the same way at 1000/2000/3500/4300.
4. Add Scotese blend — verify as a flat Canvas2D composite first, then move into GLSL
   and re-verify the same screenshots render identically through the GPU path.
5. Add Blue Marble blend + plate-displacement; verify at 0/20/40/65 Ma. Budget the most
   review time here; accept visually-approximate (not pixel-exact) parity since Python's
   own version is itself a coarse 9-region heuristic.
6. Add cloud scroll blend; verify opacity-per-era matches Python's branches.
7. Move the finished flat texture onto the real Three.js sphere (`OrthographicCamera` +
   `SphereGeometry` + shader material); verify a static (non-rotating) screenshot
   against Python's actual rendered globe at a matching view angle/Ma — this is where
   shading/rim-glow parity gets checked, decoupled from earlier texture bugs.
8. Add drag-rotate + inertia; verify qualitatively side-by-side with the running pygame
   app, plus a numeric check on the decay rate.
9. Add the Ma-bucketed structural cache + one-rebuild-per-frame throttle; profile the
   >750 Ma branch under rapid scrubbing before deciding whether a Worker is needed.

## Wikidata ingestion pipeline (`wikidata_sync.py`, new — Phase, last, highest-risk)

Follows `geo.py`'s exact cache pattern: query once via stdlib `urllib.request` against
`https://query.wikidata.org/sparql`, write to `data/wikidata_events.json` (committed),
refreshed only via an explicit `python wikidata_sync.py --refresh` — never in CI, never
on app load.

One SPARQL query per category (battles `wd:Q178561`, treaties `wd:Q131569`,
discoveries/inventions, disasters, notable people), each requesting QID, label, date,
optional coordinates (`wdt:P625`), optional image (`wdt:P18`), and **Wikipedia sitelink
count** as the practical notability filter (`FILTER(?sitelinks >= N)`, higher `N` for
humans than other categories since they vastly outnumber everything else). Paginated
with `LIMIT`/`OFFSET` and a short delay between pages per WDQS etiquette.

`build_events.py` (new) merges `data/events_seed.json` + `data/wikidata_events.json` →
`data/events_merged.json` (committed, consumed by `scripts/export_data.py`):
1. Primary dedup by exact QID match (seed's hand-written description/color wins;
   Wikidata backfills missing image/coordinates).
2. Fallback fuzzy match (normalized title + year equality) for unmapped QIDs.
3. Anything ambiguous goes to `data/wikidata_review.json` for manual triage.

## CI/CD (GitHub Actions → GitHub Pages)

Trigger: `push` to `main` + `workflow_dispatch`. One `build` job (checkout →
`actions/setup-python@v5` → run `scripts/export_data.py` → assemble `web/` plus
generated `web/public/data/*.json` into `_site/` → `actions/upload-pages-artifact@v3`),
one `deploy` job (`actions/deploy-pages@v4`, `github-pages` environment). No
Node/npm step, matching the no-bundler decision above. Requires a one-time manual repo
setting: **Settings → Pages → Build and deployment → Source = GitHub Actions**. The
workflow never runs `wikidata_sync.py` — that stays a manual local step whose output
gets committed like any other data file.

```yaml
name: Deploy Earth History Simulator
on:
  push: { branches: [main] }
  workflow_dispatch:
permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: pages, cancel-in-progress: false }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: python scripts/export_data.py --out web/public/data
      - run: mkdir -p _site && cp -r web/* _site/
      - uses: actions/upload-pages-artifact@v3
        with: { path: _site }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: ${{ steps.deployment.outputs.page_url }} }
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

## Phased sequencing (overall)

1. **Foundation, fast infra win**: scaffold `web/` (skeleton HTML/CSS/JS, CDN Three.js +
   Leaflet import map), a minimal `scripts/export_data.py`, and the GitHub Actions
   workflow above deploying just the skeleton — prove the CI/CD pipeline works on real
   infra before building features on it.
2. **Data foundation**: `events.py` schema + adapters, small `data/events_seed.json`
   (~30-50 events) to prove the schema end-to-end through export → `web/public/data/`.
3. **Timeline**: JS windowed zoom/pan/drill-down component against exported
   `periods.json`/`events.json`, no globe/map yet.
4. **Historical map mode**: Leaflet + event pins + popups, wired to the timeline's mode
   switch. Ships real user value before the globe port is done.
5. **Un-gitignore and commit** `ne_land_110m.geojson`, `blue_marble.jpg`,
   `cloud_layer.jpg`, `paleo_textures/*.jpg` — unblocks both the export script and the
   globe port.
6. **Globe port**, sub-phased exactly as in the dedicated section above (steps 1-9) —
   the longest single effort, can proceed in parallel with later event-content work
   since it doesn't depend on more event data.
7. **Expand curated seed content** to a few hundred events across categories (can happen
   any time after step 2; not blocking).
8. **Wikidata pipeline** (last, most open-ended): `wikidata_sync.py` starting with 1-2
   categories, `build_events.py` merge/dedup, then incremental category expansion.

## New/modified files

New: `events.py`, `data/events_seed.json`, `data/wikidata_events.json`,
`data/events_merged.json`, `data/wikidata_review.json`, `wikidata_sync.py`,
`build_events.py`, `scripts/export_data.py`, `.github/workflows/deploy.yml`, `web/`
(`index.html`, `style.css`, `src/*.js` — timeline, globe structural/shader modules,
historical map, mode dispatch, event loading), `web/public/data/` (generated, not
committed directly — built by CI), `web/public/textures/` (committed copies of the
existing downloaded assets).

Modified: `.gitignore` (remove `blue_marble.jpg`, `cloud_layer.jpg`, `paleo_textures/`,
`ne_land_110m.geojson`; add generated-only paths like `web/public/data/`).

Untouched (legacy, no new feature work): `main.py`, `data.py` (aside from the additive,
non-destructive `events.py` adapters reading from it), `geo.py`, `requirements.txt`
(still worth the small fix of declaring `numpy`/`Pillow`, since the legacy app still
needs to keep running).

## Verification

- **Step 1 (CI skeleton)**: push to `main`, confirm the Actions run goes green and the
  GitHub Pages URL serves the skeleton page.
- **Step 2 (data)**: confirm `web/public/data/events.json` contains the expected seed
  events after a run, with correct shape.
- **Step 3-4 (timeline/map)**: manually exercise zoom/pan/drill-down and confirm the
  mode switches to the Leaflet map at the fine-zoom threshold, pins render/cluster, and
  popups show correct data/links.
- **Globe port**: at each of the 9 sub-phases, run the specific screenshot/numeric
  comparison against the existing pygame app's output described in that sub-phase,
  before proceeding to the next.
- **Wikidata pipeline**: after each new category is added, manually run
  `wikidata_sync.py --refresh` for just that category and inspect the output JSON for
  sane dates/coordinates/sitelink counts before merging into `events_merged.json`.

## Agent prompt blurbs (copy/paste into two separate agent setups)

Two review agents are proposed: one judging **quality/correctness/UX**, one judging
**performance**. They're deliberately kept as independent lenses on the same plan so
neither reviewer has to trade off the other's concerns while forming a verdict.

### Blurb 1 — Quality reviewer

```
You are reviewing the Earth History Simulator web app (a browser-based, WebGL/Leaflet
port of a Python/pygame deep-time globe simulator, hosted on GitHub Pages) against a
quality bar covering correctness, data integrity, UX cohesion, and maintainability.
Evaluate against these factors:

1. Historical/scientific accuracy — do event dates, coordinates, descriptions, and
   category assignments in the event dataset match their cited Wikipedia/Wikidata
   sources? Are BCE/CE and precision fields (day/year/century/era) used correctly rather
   than defaulting everything to a coarse "ma" value?
2. Visual fidelity of the ported globe — at each of the plan's 9 verification
   checkpoints (flat equirect render, blob-splatting, Scotese blend, Blue Marble +
   plate-drift, clouds, sphere/shading, rotation/inertia, caching), does the browser
   output match the reference pygame/PIL output closely enough that a user familiar with
   the original wouldn't perceive a regression?
3. UX cohesion — does switching between the deep-time globe and the historical map mode
   feel like one coherent app (consistent visual language, predictable trigger point,
   no jarring loss of context) rather than two bolted-together experiences? Does the
   zoomable timeline's zoom/pan/drill-down behavior feel discoverable without a manual?
4. Data model soundness — does every event have a complete, valid EventTime/Place, no
   orphaned categories or viz_modes with no renderer, no silent data loss in the
   seed+Wikidata merge/dedup step?
5. Attribution and licensing — is Scotese/PALEOMAP, NASA Blue Marble, Natural Earth, and
   Wikidata/Wikipedia content properly credited given it's now committed into a public
   repo and served from a public site, not just downloaded ad hoc at runtime?
6. Code quality and consistency — does new code follow the existing project's
   established patterns (e.g. geo.py's download-once-and-cache idiom, data.py's
   lookup-helper style) rather than introducing a divergent style? Is events.py's
   wrapping of PERIODS/_TOL_DATA genuinely non-destructive (legacy app still runs
   unmodified)?
7. Accessibility — keyboard navigability of the timeline and map, color contrast for
   category-coded pins/markers, alt text/labels for screen readers on event popups.
8. Cross-browser/device compatibility — graceful behavior (not a blank page) on browsers
   or devices without solid WebGL2 support; responsive layout on mobile/tablet widths.

For each factor, cite specific evidence (files, screenshots, data samples) rather than
general impressions, and flag anything that blocks shipping vs. what's a nice-to-have
follow-up.
```

### Blurb 2 — Performance reviewer

```
You are reviewing the Earth History Simulator web app (a browser-based WebGL/Leaflet
port of a Python/pygame deep-time globe simulator, hosted on GitHub Pages, built via a
GitHub Actions pipeline) against a performance bar. Evaluate against these factors:

1. Globe render frame rate — during active drag-rotation and during rapid timeline
   scrubbing across many Ma values, does the Three.js globe sustain a smooth frame rate
   (target ~60fps) with no visible stutter, on both desktop and a mid-tier mobile GPU?
2. Structural texture rebuild cost — when Ma crosses into a new cache bucket
   (CACHE_MA_STEP), how long does the Canvas2D rebuild take, especially the >750 Ma
   Gaussian-blob-splatting branch (the known-expensive path)? Does it stay well within a
   single frame budget, and if not, has the Web Worker/OffscreenCanvas fallback
   described in the plan actually been implemented and shown to help?
3. Caching correctness under load — does the Ma-bucketed LRU structural-texture cache
   actually cap memory growth during long scrubbing sessions (no unbounded growth,
   correct eviction), and is at most one structural texture rebuilt per animation frame
   even under rapid-fire scrub input?
4. Initial load performance — total payload size and time-to-interactive for first page
   load, given ~3MB of committed texture/data assets; is anything lazy-loaded
   (e.g. Scotese keyframes only fetched near the Ma values actually visited) versus
   fetched eagerly and unnecessarily up front?
5. Historical map performance at scale — with hundreds to thousands of event pins
   loaded, does Leaflet.markercluster keep pan/zoom/filter interactions smooth, and does
   the time-range slider re-filter without visible lag?
6. Build/deploy pipeline performance — how long does the GitHub Actions workflow
   (export_data.py + site assembly + Pages deploy) take end-to-end, and does it scale
   reasonably as the event dataset grows toward the "few hundred to a few thousand
   events" target?
7. Wikidata sync pipeline performance and etiquette — does wikidata_sync.py respect
   WDQS pagination/rate-limit norms (delays between paged queries), and how long does a
   full multi-category refresh take?
8. Regression tracking — is there a lightweight, repeatable way to notice if a future
   change silently degrades any of the above (e.g. a documented manual profiling
   checklist), given this app has no automated test suite?

For each factor, request or cite concrete measurements (frame timings, payload sizes,
profiler traces, workflow run durations) rather than subjective impressions, and
distinguish must-fix regressions from acceptable-for-a-hobby-project tradeoffs.
```
