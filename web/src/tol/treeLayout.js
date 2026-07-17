// treeLayout.js -- pure layout math for the Tree of Life radial dendrogram.
// No Three.js/DOM dependency here so the angle/radius assignment can be
// reasoned about (and unit-tested) independently of rendering, the same
// split globe/structuralTexture.js and globe/continents.js already use.
//
// Input shape (from web/public/data/tree_of_life.json, itself exported from
// main.py's hand-curated _TOL_DATA): [{id, label, first_ma, parent_id,
// color, extinct_ma}]. first_ma is when the clade split from its parent;
// extinct_ma is 0 for extant lineages, else the Ma it died out (e.g.
// non-avian dinosaurs at 66).

/** Standard circular-dendrogram angle assignment: leaves get evenly spaced
 * angles in DFS order, internal nodes get the mean of their children's
 * angles (computed bottom-up) -- so a parent always points squarely between
 * its descendants instead of at an arbitrary child. */
export class TreeLayout {
  constructor(rawNodes) {
    this.byId = new Map(rawNodes.map((n) => [n.id, { ...n, children: [] }]));
    this.root = null;
    // Species (13k+, ids "sp-*") deliberately stay out of the backbone
    // tree's own children/leaf structure below -- the 34 hand-curated
    // clades need to keep the same legible spacing they had before any
    // species existed, not get squeezed however many thousand species a
    // given anchor happens to have. They're grouped by anchor here and
    // fanned into an angle window around their anchor's *resolved* angle
    // in a separate pass once the backbone layout is settled.
    const speciesByAnchor = new Map();
    for (const n of this.byId.values()) {
      if (n.id.startsWith("sp-")) {
        const list = speciesByAnchor.get(n.parent_id) || [];
        list.push(n);
        speciesByAnchor.set(n.parent_id, list);
        continue;
      }
      const parent = n.parent_id && this.byId.get(n.parent_id);
      if (parent) parent.children.push(n);
      else this.root = n; // exactly one node has parent_id === null: LUCA
    }
    this.rootMa = this.root.first_ma;

    const leaves = [];
    (function collect(n) {
      if (n.children.length === 0) leaves.push(n);
      else n.children.forEach(collect);
    })(this.root);
    const step = (Math.PI * 2) / leaves.length;
    leaves.forEach((n, i) => { n.angle = i * step; });

    (function assignAngle(n) {
      if (n.children.length === 0) return n.angle;
      const childAngles = n.children.map(assignAngle);
      n.angle = childAngles.reduce((a, b) => a + b, 0) / childAngles.length;
      return n.angle;
    })(this.root);

    // Every backbone leaf sits exactly `step` apart from its neighbors (by
    // construction above), so a fan half-width of step/2 around an anchor's
    // resolved angle can never bleed into an unrelated adjacent clade's
    // territory -- true whether the anchor is itself a leaf or (like
    // bacteria/placental/primates) an internal node whose own angle is a
    // mean pulled from a couple of nearby backbone children.
    for (const [anchorId, species] of speciesByAnchor) {
      const anchor = this.byId.get(anchorId);
      if (!anchor) continue;
      const n = species.length;
      species.forEach((sp, i) => {
        sp.angle = n === 1 ? anchor.angle : anchor.angle - step / 2 + (i + 0.5) * (step / n);
      });
    }
  }

  /** Ma -> radius, center (0) = LUCA/root, edge (rMax) = present day.
   * gamma < 1 expands the outer (recent, diversity-dense) part of the disk
   * relative to a linear scale, since a linear mapping of a 3.8 Gy root
   * against mostly-Phanerozoic (<=540 Ma) branching would crowd almost
   * every node into a thin outer ring. */
  radiusFor(ma, rMax = 10, gamma = 0.42) {
    const frac = 1 - Math.max(0, ma) / this.rootMa;
    return rMax * Math.pow(Math.max(0, Math.min(1, frac)), gamma);
  }

  nodes() { return [...this.byId.values()]; }
}
