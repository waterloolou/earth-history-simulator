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
    for (const n of this.byId.values()) {
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
