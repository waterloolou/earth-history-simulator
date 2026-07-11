# Texture attribution

These static image/data assets are committed here so the web app can load them
same-origin (avoiding CORS/tainted-canvas issues) instead of fetching them live
from third parties on every visit.

- `cloud_layer.jpg` -- NASA Visible Earth cloud composite imagery
  (eoimages.gsfc.nasa.gov). Used for the scrolling cloud overlay.
- `ne_land_110m.geojson` -- Natural Earth 1:110m land vector data (public
  domain), via the `nvkelso/natural-earth-vector` GitHub mirror. Used for
  present-day and 65 Ma coastlines.

As of the globe-rendering unification, the app no longer uses Scotese/PALEOMAP
paleogeography imagery or NASA Blue Marble present-day satellite imagery --
the whole timeline now renders through one illustrated-biome-map style built
from continent polygon data (see `web/src/globe/structuralTexture.js`) rather
than switching between photographic sources at different eras.
