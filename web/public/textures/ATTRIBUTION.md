# Texture attribution

These static image/data assets are committed here so the web app can load them
same-origin (avoiding CORS/tainted-canvas issues) instead of fetching them live
from third parties on every visit. They were originally downloaded once by the
legacy pygame app's `geo.py`/`main.py` and are duplicated here for the browser app.

- `scotese/*.jpg` -- Paleogeographic reconstructions courtesy C.R. Scotese / the
  PALEOMAP Project, served via the Ancient Earth Globe project
  (dinosaurpictures.org). Used for 0-750 Ma continental textures.
- `blue_marble.jpg` -- NASA Visible Earth "Blue Marble: Land Surface, Shallow
  Water, and Shaded Topography" (eoimages.gsfc.nasa.gov). Used for present-day
  (<65 Ma) photorealistic blending.
- `cloud_layer.jpg` -- NASA Visible Earth cloud composite imagery
  (eoimages.gsfc.nasa.gov). Used for the scrolling cloud overlay.
- `ne_land_110m.geojson` -- Natural Earth 1:110m land vector data (public
  domain), via the `nvkelso/natural-earth-vector` GitHub mirror. Used for
  present-day and 65 Ma coastlines.
