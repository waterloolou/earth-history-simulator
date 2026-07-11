# Historical borders data attribution

`*.geojson` (52 snapshots, 123,000 BCE - 2010 CE) and `manifest.json` are
derived from the **historical-basemaps** project by Aurélien Ourednik
(https://github.com/aourednik/historical-basemaps), licensed **GNU GPL v3**.

These files are committed here (rather than fetched live) so the app has no
runtime dependency on GitHub's raw-content servers, matching the pattern used
for the other static assets under `web/public/`. Geometries were coordinate-
rounded and lightly Douglas-Peucker-simplified from the original source (see
`borders_sync.py`) to reduce payload size for a small on-screen map -- they
are display-quality only, not suitable for precise geographic analysis.

The source project bundles this data under GPL-3.0; see
https://github.com/aourednik/historical-basemaps/blob/master/LICENSE for the
full license text. This is a data dependency of the Earth History Simulator
app, not a claim that the whole app is GPL-licensed.
