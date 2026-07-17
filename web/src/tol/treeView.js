// treeView.js -- Three.js radial "tree of life" dendrogram: every clade in
// tree_of_life.json rendered as a branch on a disk (center = LUCA/3.8 Ga,
// edge = present day), orbit-rotatable, with click-to-select cross-linking
// back to the main timeline. Mirrors globe/globeView.js's overall shape
// (constructor(container) -> load() -> resize()/render(), a custom drag
// controller instead of OrbitControls) for consistency with the rest of the
// app, but uses a PerspectiveCamera + simple unlit materials since this is a
// flat structural diagram, not a photographically-shaded sphere.

import * as THREE from "three";
import { TreeLayout } from "./treeLayout.js";

const R_MAX = 10;
const SPIN_DECAY = 3.5; // matches globeView.js's inertia decay rate
const MIN_ORBIT_DIST = 6;
const MAX_ORBIT_DIST = 45;
const DEFAULT_ORBIT_DIST = 22;
// Species stay fully hidden at and above this distance -- deliberately well
// below DEFAULT_ORBIT_DIST (not just a softer fade at the default view) --
// see _updateSpeciesFade for why a partial fade alone doesn't declutter a
// dense wedge of hundreds of overlapping lines.
const SPECIES_REVEAL_DIST = 14;

function rgb(color) { return new THREE.Color(color[0] / 255, color[1] / 255, color[2] / 255); }

/** Canvas-rendered text sprite -- cheap and legible at the ~34-node scale
 * here; a bitmap font/SDF approach would only pay off at far higher node
 * counts than this hand-curated dataset has. */
function makeLabelSprite(text, color) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const fontPx = 40;
  ctx.font = `${fontPx}px Segoe UI, sans-serif`;
  const textW = ctx.measureText(text).width;
  canvas.width = Math.ceil(textW + 24);
  canvas.height = fontPx + 16;
  ctx.font = `${fontPx}px Segoe UI, sans-serif`;
  ctx.fillStyle = "rgba(4, 8, 26, 0.72)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 12, canvas.height / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace ?? THREE.LinearSRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  const scale = 0.014;
  sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);
  return sprite;
}

export class TreeView {
  constructor(container, { dataBase = "public/data" } = {}) {
    this.container = container;
    this.dataBase = dataBase;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);

    this._orbitAz = Math.PI * 0.15;   // azimuth (radians)
    this._orbitEl = 0.85;             // elevation above the disk plane (radians)
    this._orbitDist = DEFAULT_ORBIT_DIST;
    this._spinAz = 0; this._spinEl = 0;
    this._dragActive = false;

    this._layout = null;
    this._nodeMeshes = new Map(); // id -> THREE.Mesh (backbone clades only -- see _buildTree)
    this._speciesExtant = null;   // { mesh: THREE.InstancedMesh, nodes: node[] } | null
    this._speciesExtinct = null;  // same shape, for extinct species (ring markers)
    this._speciesFadeObjects = []; // every species-layer Object3D (lifelines + both instanced meshes) -- see _updateSpeciesFade
    this._raycaster = new THREE.Raycaster();
    this._onSelect = null;
    this._hoveredId = null;
    this._focusedId = null; // keyboard-navigation cursor, separate from click-selection
    this._hoverLabel = null; // single reusable sprite for whichever species is under the pointer

    this._buildLights();
    this._buildCurrentEraRing();
    this._buildFocusRing();
    this._bindDragControls();
    this._bindClick();
    this._bindHover();
    this._bindKeyboard();

    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(container);
    this.resize();
    this._updateCamera();
  }

  onSelect(cb) { this._onSelect = cb; }

  async load() {
    const nodes = await fetch(`${this.dataBase}/tree_of_life.json`).then((r) => r.json());
    this._layout = new TreeLayout(nodes);
    this._buildTree();
    this._focusedId = this._layout.root.id;
    this._updateFocusRing();
    // _buildTree() just populated _speciesFadeObjects with freshly-constructed
    // (unfaded, fully visible) materials -- without this, species render at
    // full opacity on the very first frame, before the user has zoomed at
    // all, since _updateSpeciesFade() otherwise only ever runs reactively
    // from a drag/wheel interaction's own _updateCamera() call.
    this._updateSpeciesFade();
  }

  _buildLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 1));
  }

  /** Thin ring at the radius corresponding to the main timeline's current Ma
   * -- ties this view back to the shared playhead the same way the globe and
   * timeline canvas both show "now" via a consistent visual language. */
  _buildCurrentEraRing() {
    const geo = new THREE.RingGeometry(1, 1.02, 128);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd54e, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false,
    });
    this._eraRing = new THREE.Mesh(geo, mat);
    this._eraRing.rotation.x = -Math.PI / 2;
    this.scene.add(this._eraRing);
  }

  /** Small ring that tracks the keyboard-navigation cursor -- only shown
   * while the canvas actually has keyboard focus, so mouse/touch users never
   * see a lingering indicator meant for a different input mode. */
  _buildFocusRing() {
    const geo = new THREE.RingGeometry(0.22, 0.28, 24);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false,
    });
    this._focusRing = new THREE.Mesh(geo, mat);
    this._focusRing.rotation.x = -Math.PI / 2;
    this._focusRing.visible = false;
    this.scene.add(this._focusRing);
  }

  /** Backbone clades (the original 34, id NOT starting "sp-") keep individual
   * Mesh/Line/Sprite objects -- cheap at that count, and each is a permanent
   * landmark worth its own always-visible label. Species (id starting
   * "sp-", potentially thousands, see species_sync.py) go through
   * _buildSpeciesLifelines/_buildSpeciesInstances instead: GPU instancing
   * and shared line buffers, because one Mesh+Line+Sprite per node -- fine
   * at 34 -- becomes thousands of draw calls at species scale, which is
   * exactly the kind of per-frame cost this app already goes out of its way
   * to avoid elsewhere (see globe/structuralTexture.worker.js's PERF.md
   * writeup). Verified necessary via real before/after profiling, not
   * assumed -- see the performance pass this shipped with. */
  _buildTree() {
    const group = new THREE.Group();
    const allNodes = this._layout.nodes();
    const backbone = allNodes.filter((n) => !n.id.startsWith("sp-"));
    const speciesNodes = allNodes.filter((n) => n.id.startsWith("sp-"));

    for (const n of backbone) {
      const r0 = this._layout.radiusFor(n.first_ma, R_MAX);
      const r1 = this._layout.radiusFor(n.extinct_ma || 0, R_MAX);
      const color = rgb(n.color);
      const extinct = n.extinct_ma > 0;

      // Lifeline: radial segment from where this clade branched off (r0) out
      // to when it died out, or the present-day edge if it's still extant (r1).
      const lifePts = [
        new THREE.Vector3(r0 * Math.cos(n.angle), 0, r0 * Math.sin(n.angle)),
        new THREE.Vector3(r1 * Math.cos(n.angle), 0, r1 * Math.sin(n.angle)),
      ];
      const lifeGeo = new THREE.BufferGeometry().setFromPoints(lifePts);
      const lifeMat = new THREE.LineBasicMaterial({
        color, transparent: true, opacity: extinct ? 0.45 : 0.95,
      });
      group.add(new THREE.Line(lifeGeo, lifeMat));

      // Branch arc: connects this clade's angle to its parent's angle at a
      // constant radius (r0, the moment of divergence) -- the standard
      // "elbow" connector shape used in circular dendrograms.
      const parent = n.parent_id ? this._layout.byId.get(n.parent_id) : null;
      if (parent) {
        const arcSegs = 10;
        const pts = [];
        for (let i = 0; i <= arcSegs; i++) {
          const t = i / arcSegs;
          const a = parent.angle + (n.angle - parent.angle) * t;
          pts.push(new THREE.Vector3(r0 * Math.cos(a), 0, r0 * Math.sin(a)));
        }
        const arcGeo = new THREE.BufferGeometry().setFromPoints(pts);
        const arcMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 });
        group.add(new THREE.Line(arcGeo, arcMat));
      }

      // Node marker at the branch point. Extinct clades get a hollow ring
      // (a visible "this lineage ended" marker) instead of a filled sphere.
      const markerGeo = extinct
        ? new THREE.RingGeometry(0.11, 0.16, 20)
        : new THREE.SphereGeometry(0.13, 16, 16);
      const markerMat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
      const marker = new THREE.Mesh(markerGeo, markerMat);
      marker.position.set(r0 * Math.cos(n.angle), 0, r0 * Math.sin(n.angle));
      if (extinct) marker.rotation.x = -Math.PI / 2;
      marker.userData.nodeId = n.id;
      group.add(marker);
      this._nodeMeshes.set(n.id, marker);

    }

    this._buildBackboneLabels(backbone, group);
    this._buildSpeciesLifelines(speciesNodes, group);
    this._buildSpeciesInstances(speciesNodes, group);

    this.scene.add(group);
    this._treeGroup = group;
  }

  /** Backbone label placement, decoupled from the 34 nodes' real geometric
   * angle (which stays exact for lifelines/arcs/markers -- those must be
   * geometrically honest). Labels alone get nudged apart when two clades
   * branch at both a similar radius *and* a similar angle -- which happens
   * more than you'd expect from just 34 nodes: a parent's angle is the
   * mean of its children's, so a 3-child parent's label often lands
   * almost exactly on its middle child's own label (e.g. Archosaurs
   * averaging Crocodilians/Non-avian Dinosaurs/Birds lands right on
   * Non-avian Dinosaurs, and both branch within ~1 Ma of each other so
   * their radii barely differ either); LUCA and Bacteria both branch at
   * the very root (radius 0) regardless of angle. A greedy angular-
   * spacing pass over small local clusters fixes this without touching
   * the tree's actual branch geometry. */
  _buildBackboneLabels(backbone, group) {
    const infos = backbone.map((n) => ({ n, r0: this._layout.radiusFor(n.first_ma, R_MAX), angle: n.angle }));

    // Required angular gap is derived from each label's actual rendered
    // width (mirroring makeLabelSprite's own canvas.width/scale math) --
    // a flat angular constant was tried first and badly undershot for
    // longer names like "Non-avian Dinos" or "Other Placentals" (5+ world
    // units wide), which kept overlapping even after the greedy pass
    // technically satisfied a too-small minimum separation.
    const FONT_PX = 40, CHAR_PX = FONT_PX * 0.55, PAD_PX = 24, SCALE = 0.014;
    const halfWidth = (n) => ((n.label.length * CHAR_PX + PAD_PX) * SCALE) / 2 + 0.15;

    // Cluster by *physical* (world-unit) proximity, not raw angle. The
    // gamma<1 radius curve (see radiusFor) compresses every "recent"
    // branch point -- flowering plants, birds, mammals, primates, Homo
    // sapiens -- into the same narrow outer radius band even though
    // they're spread across the *entire* circle and share nothing but
    // being geologically recent; a radius-only bucket lumped all of them
    // together and the greedy pass then dragged completely unrelated
    // labels (e.g. Flowering Plants) across the disk to satisfy
    // separation from clades on the opposite side. A fixed angle-gap
    // threshold has the opposite failure near the root: LUCA/Bacteria/
    // "Other Bacteria" branch at radius ~0, where even a "big" angle
    // difference is a near-zero physical gap. Converting angle gap to an
    // approximate arc length (angle * radius) before thresholding handles
    // both correctly.
    // Union-find over *all* pairs within threshold, not a single sorted
    // sweep -- a sweep breaks as soon as one interloping node sits between
    // two radius-similar nodes in raw angle order (e.g. Cyanobacteria, out
    // at radius ~6, happens to fall angularly between Bacteria and LUCA,
    // both at radius 0 -- a sweep would split Bacteria and LUCA into
    // separate clusters even though they're right on top of each other).
    // Only 34 nodes, so the O(n^2) pair scan is trivial.
    const PHYS_GAP_MAX = 6.0, RADIUS_GAP_MAX = 1.5;
    const physGap = (a, b) => {
      let d = Math.abs(a.angle - b.angle);
      if (d > Math.PI) d = Math.PI * 2 - d;
      return d * Math.max(Math.min(a.r0, b.r0), 0.3);
    };
    const parent = infos.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (i, j) => { const ri = find(i), rj = find(j); if (ri !== rj) parent[ri] = rj; };
    for (let i = 0; i < infos.length; i++) {
      for (let j = i + 1; j < infos.length; j++) {
        if (physGap(infos[i], infos[j]) <= PHYS_GAP_MAX && Math.abs(infos[i].r0 - infos[j].r0) <= RADIUS_GAP_MAX) {
          union(i, j);
        }
      }
    }
    const groups = new Map();
    infos.forEach((info, i) => {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(info);
    });
    const clusters = [...groups.values()];

    for (const band of clusters) {
      if (band.length < 2) continue;
      band.sort((a, b) => a.angle - b.angle);
      const avgR0 = band.reduce((s, i) => s + i.r0, 0) / band.length;
      const desiredArc = 2 * Math.max(...band.map((i) => halfWidth(i.n)));
      const minSep = Math.min(desiredArc / Math.max(avgR0, 0.5), (Math.PI * 2) / band.length);
      // Work in *unwrapped* angle space (cursor can exceed 2*pi) so a push
      // earlier in the sequence is never silently forgotten by the next
      // element modding back into a "behind cursor" position -- that was
      // the actual bug in the first version of this pass: pushing element
      // 1 forward past element 2's original angle, then letting element 2
      // fall back to that now-stale original angle because a same-value
      // mod-2*pi comparison made it look like a big gap the "long way
      // around", when the real (short-way) angular distance was tiny.
      let cursor = band[0].angle;
      band[0].labelAngle = cursor;
      for (let i = 1; i < band.length; i++) {
        let candidate = band[i].angle;
        while (candidate < cursor) candidate += Math.PI * 2;
        if (candidate - cursor < minSep) candidate = cursor + minSep;
        cursor = candidate;
        band[i].labelAngle = cursor;
      }
      // Close the loop: the unwrapped span consumed (cursor) must leave at
      // least minSep before wrapping back around to the first element's
      // angle + 2*pi. If 3+ clades all branch at the same tight radius
      // (e.g. LUCA/Bacteria/"Other Bacteria" all at radius 0), minSep
      // gets capped at 2*pi/count and the greedy pass above can overshoot
      // a full circle -- fall back to perfectly even spacing in that case.
      const closureGap = (band[0].angle + Math.PI * 2) - cursor;
      if (closureGap < minSep - 1e-6) {
        band.forEach((info, i) => { info.labelAngle = band[0].angle + i * minSep; });
      }
      for (const info of band) {
        info.labelAngle = ((info.labelAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      }
    }

    for (const info of infos) {
      const { n, r0 } = info;
      const angle = info.labelAngle ?? info.angle;
      const label = makeLabelSprite(n.label, `rgb(${n.color[0]},${n.color[1]},${n.color[2]})`);
      const labelR = r0 + 0.85;
      label.position.set(labelR * Math.cos(angle), 0.15, labelR * Math.sin(angle));
      group.add(label);
    }
  }

  /** One shared LineSegments draw call for every species lifeline, instead
   * of one Line object each. No connecting arc for species (unlike
   * backbone clades) -- every species inherits its anchor's exact first_ma
   * (species_sync.py has no per-species divergence-time data to draw a
   * *different* branch point from), so an arc back to a parent sitting at
   * the identical radius would add geometry without conveying anything an
   * arc normally would (a genuinely different branch time). Extinct
   * species get their color pre-dimmed into the vertex color rather than a
   * separate transparent material, since per-segment opacity would
   * otherwise need a custom shader for no real visual gain here. */
  _buildSpeciesLifelines(speciesNodes, group) {
    if (speciesNodes.length === 0) return;
    const positions = new Float32Array(speciesNodes.length * 2 * 3);
    const colors = new Float32Array(speciesNodes.length * 2 * 3);
    let p = 0, c = 0;
    for (const n of speciesNodes) {
      const r0 = this._layout.radiusFor(n.first_ma, R_MAX);
      const r1 = this._layout.radiusFor(n.extinct_ma || 0, R_MAX);
      const dim = n.extinct_ma > 0 ? 0.5 : 1;
      const cr = (n.color[0] / 255) * dim, cg = (n.color[1] / 255) * dim, cb = (n.color[2] / 255) * dim;
      const x0 = r0 * Math.cos(n.angle), z0 = r0 * Math.sin(n.angle);
      const x1 = r1 * Math.cos(n.angle), z1 = r1 * Math.sin(n.angle);
      positions[p++] = x0; positions[p++] = 0; positions[p++] = z0;
      positions[p++] = x1; positions[p++] = 0; positions[p++] = z1;
      colors[c++] = cr; colors[c++] = cg; colors[c++] = cb;
      colors[c++] = cr; colors[c++] = cg; colors[c++] = cb;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.65 });
    const lines = new THREE.LineSegments(geo, mat);
    group.add(lines);
    this._speciesFadeObjects.push(lines);
  }

  /** GPU-instanced node markers for every species: one draw call for all
   * extant species (filled-sphere instances) and one for all extinct
   * species (ring instances), regardless of whether there are 30 or
   * 30,000. Raycasting an InstancedMesh natively reports which instance
   * was hit (intersection.instanceId), so click-to-select and hover both
   * keep working the same way they do for the individually-meshed backbone
   * nodes -- see _pickNodeAt(). Marker geometry is deliberately lower-poly
   * than the backbone's (thousands of small on-screen instances don't
   * benefit from 16x16 sphere segments the way ~34 large ones do). */
  _buildSpeciesInstances(speciesNodes, group) {
    const extant = speciesNodes.filter((n) => !(n.extinct_ma > 0));
    const extinct = speciesNodes.filter((n) => n.extinct_ma > 0);
    const dummy = new THREE.Object3D();

    if (extant.length > 0) {
      const geo = new THREE.SphereGeometry(0.045, 6, 6);
      const mat = new THREE.MeshBasicMaterial({ transparent: true });
      const mesh = new THREE.InstancedMesh(geo, mat, extant.length);
      this._speciesFadeObjects.push(mesh);
      extant.forEach((n, i) => {
        const r0 = this._layout.radiusFor(n.first_ma, R_MAX);
        dummy.position.set(r0 * Math.cos(n.angle), 0, r0 * Math.sin(n.angle));
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.setColorAt(i, rgb(n.color));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      group.add(mesh);
      this._speciesExtant = { mesh, nodes: extant };
    }

    if (extinct.length > 0) {
      const geo = new THREE.RingGeometry(0.035, 0.055, 8);
      const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true });
      const mesh = new THREE.InstancedMesh(geo, mat, extinct.length);
      this._speciesFadeObjects.push(mesh);
      extinct.forEach((n, i) => {
        const r0 = this._layout.radiusFor(n.first_ma, R_MAX);
        dummy.position.set(r0 * Math.cos(n.angle), 0, r0 * Math.sin(n.angle));
        dummy.rotation.set(-Math.PI / 2, 0, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.setColorAt(i, rgb(n.color));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      group.add(mesh);
      this._speciesExtinct = { mesh, nodes: extinct };
    }
  }

  /** Move the "current era" ring to match the main timeline's playhead. */
  setMa(ma) {
    if (!this._layout) return;
    const r = Math.max(0.05, this._layout.radiusFor(ma, R_MAX));
    this._eraRing.scale.set(r, r, 1);
  }

  // ── orbit camera (drag to rotate, wheel to zoom -- same interaction
  // vocabulary as the globe's drag-rotate, but orbiting a fixed point
  // instead of spinning a mesh) ─────────────────────────────────────────
  _bindDragControls() {
    const el = this.renderer.domElement;
    let dragging = false;
    let prevX = 0, prevY = 0, prevT = 0;

    const onDown = (x, y) => {
      dragging = true; this._dragActive = true;
      prevX = x; prevY = y; prevT = performance.now();
      this._spinAz = 0; this._spinEl = 0;
    };
    const onMove = (x, y) => {
      if (!dragging) return;
      const now = performance.now();
      const dt = Math.max(0.001, (now - prevT) / 1000);
      const dx = x - prevX, dy = y - prevY;
      const rate = 0.006;
      this._spinAz = -dx * rate / dt;
      this._spinEl = dy * rate / dt;
      this._orbitAz -= dx * rate;
      this._orbitEl = clamp(this._orbitEl + dy * rate, 0.15, 1.5);
      this._updateCamera();
      prevX = x; prevY = y; prevT = now;
    };
    const onUp = () => { dragging = false; this._dragActive = false; };

    el.addEventListener("mousedown", (ev) => onDown(ev.clientX, ev.clientY));
    window.addEventListener("mousemove", (ev) => onMove(ev.clientX, ev.clientY));
    window.addEventListener("mouseup", onUp);
    el.addEventListener("touchstart", (ev) => { const t = ev.touches[0]; onDown(t.clientX, t.clientY); }, { passive: true });
    el.addEventListener("touchmove", (ev) => { const t = ev.touches[0]; onMove(t.clientX, t.clientY); }, { passive: true });
    el.addEventListener("touchend", onUp);

    el.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      this._orbitDist = clamp(this._orbitDist * (ev.deltaY < 0 ? 0.9 : 1.1), MIN_ORBIT_DIST, MAX_ORBIT_DIST);
      this._updateCamera();
    }, { passive: false });
  }

  tickInertia(dt) {
    if (this._dragActive) return;
    if (Math.abs(this._spinAz) > 0.01 || Math.abs(this._spinEl) > 0.01) {
      this._orbitAz -= this._spinAz * dt;
      this._orbitEl = clamp(this._orbitEl + this._spinEl * dt, 0.15, 1.5);
      const decay = Math.exp(-SPIN_DECAY * dt);
      this._spinAz *= decay; this._spinEl *= decay;
      this._updateCamera();
    }
  }

  _updateCamera() {
    const r = this._orbitDist;
    this.camera.position.set(
      r * Math.sin(this._orbitEl) * Math.cos(this._orbitAz),
      r * Math.cos(this._orbitEl),
      r * Math.sin(this._orbitEl) * Math.sin(this._orbitAz),
    );
    this.camera.lookAt(0, 0, 0);
    this._updateSpeciesFade();
  }

  /** At thousands of species, the outer edge of the disk is dense enough
   * that at the default zoomed-out view it reads as a solid band rather
   * than distinguishable branches -- confirmed visually, not hypothetical,
   * and confirmed to NOT be fixable with opacity alone: hundreds of
   * overlapping semi-transparent lines crammed into one small angular
   * slice (e.g. all bacteria+archaea species share a ~20-degree wedge)
   * still visually accumulate toward solid regardless of each individual
   * segment's alpha -- that's how alpha blending over many overlapping
   * layers behaves, not a bug in a specific opacity value. A real
   * visibility cutoff (nothing drawn at all past some zoom-out point, not
   * just "drawn very faint") is what actually eliminates that, which is
   * why this sets .visible = false below a small opacity floor rather than
   * only ever dimming. The cubic falloff (not linear) keeps species hidden
   * through most of the zoomed-out range and only reveals them once the
   * user has actually zoomed in close enough to explore -- the same
   * "overview first, detail on demand" pattern real large-scale tree-of-
   * life visualizations use. The 34 backbone clades and their labels are
   * never affected by any of this -- few enough to always stay legible.
   *
   * The reveal threshold (SPECIES_REVEAL_DIST) is deliberately well below
   * the default zoom (DEFAULT_ORBIT_DIST), not just a softer opacity at the
   * default view -- verified visually that even ~20% opacity across
   * hundreds of overlapping lines in one dense wedge still reads as solid
   * (alpha blending accumulates across overlapping layers regardless of
   * each individual layer's alpha), so "default view looks clean" requires
   * species to be genuinely hidden by default, not merely dim. */
  _updateSpeciesFade() {
    if (this._speciesFadeObjects.length === 0) return;
    const t = clamp((SPECIES_REVEAL_DIST - this._orbitDist) / (SPECIES_REVEAL_DIST - MIN_ORBIT_DIST), 0, 1);
    const opacity = t * t;
    const visible = opacity > 0.02;
    for (const obj of this._speciesFadeObjects) {
      obj.material.opacity = opacity;
      obj.visible = visible;
    }
  }

  _bindClick() {
    const el = this.renderer.domElement;
    let downX = 0, downY = 0;
    el.addEventListener("mousedown", (ev) => { downX = ev.clientX; downY = ev.clientY; });
    el.addEventListener("mouseup", (ev) => {
      // Only treat this as a click (not the end of a drag-rotate) if the
      // pointer barely moved between mousedown and mouseup.
      if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 4) return;
      const node = this._pickNodeAt(ev.clientX, ev.clientY);
      if (node && this._onSelect) this._onSelect(node);
    });
  }

  /** Raycast at a client (page) coordinate against both the individually-
   * meshed backbone clades and the instanced species meshes, returning
   * whichever node was hit closest (or null). Shared by click-to-select and
   * hover so both interactions resolve a screen point to a node the same way. */
  _pickNodeAt(clientX, clientY) {
    const el = this.renderer.domElement;
    const rect = el.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera({ x, y }, this.camera);

    const targets = [...this._nodeMeshes.values()];
    if (this._speciesExtant) targets.push(this._speciesExtant.mesh);
    if (this._speciesExtinct) targets.push(this._speciesExtinct.mesh);
    const hits = this._raycaster.intersectObjects(targets);
    if (!hits.length) return null;
    const hit = hits[0];
    if (this._speciesExtant && hit.object === this._speciesExtant.mesh) {
      return this._speciesExtant.nodes[hit.instanceId];
    }
    if (this._speciesExtinct && hit.object === this._speciesExtinct.mesh) {
      return this._speciesExtinct.nodes[hit.instanceId];
    }
    return this._layout.byId.get(hit.object.userData.nodeId);
  }

  /** Mouse hover over a species shows a single on-demand label sprite
   * (species don't get a persistent label the way the 34 backbone clades
   * do -- see _buildTree's comment on why). Raycasting on every mousemove
   * would be wasteful given how often that event fires relative to the
   * screen's actual refresh rate, especially against thousands of instances,
   * so this throttles to at most one pick per animation frame. */
  _bindHover() {
    const el = this.renderer.domElement;
    let raf = null;
    el.addEventListener("mousemove", (ev) => {
      if (this._dragActive) { this._setHoverLabel(null); return; }
      const x = ev.clientX, y = ev.clientY;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const node = this._pickNodeAt(x, y);
        this._setHoverLabel(node && node.id.startsWith("sp-") ? node : null);
      });
    });
    el.addEventListener("mouseleave", () => this._setHoverLabel(null));
  }

  _setHoverLabel(node) {
    const nextId = node ? node.id : null;
    if (this._hoveredId === nextId) return;
    this._hoveredId = nextId;
    if (this._hoverLabel) {
      this.scene.remove(this._hoverLabel);
      this._hoverLabel.material.map.dispose();
      this._hoverLabel.material.dispose();
      this._hoverLabel = null;
    }
    if (!node) return;
    const label = makeLabelSprite(node.label, `rgb(${node.color[0]},${node.color[1]},${node.color[2]})`);
    const r0 = this._layout.radiusFor(node.first_ma, R_MAX);
    const labelR = r0 + 0.3;
    label.position.set(labelR * Math.cos(node.angle), 0.15, labelR * Math.sin(node.angle));
    this.scene.add(label);
    this._hoverLabel = label;
  }

  /** Arrow-key traversal of the tree (up=parent, down=first child,
   * left/right=previous/next sibling) plus Enter/Space to select -- the
   * click-to-select interaction's keyboard equivalent, matching the rest of
   * the app's real keyboard support (space/arrows/W/R on the timeline, a
   * proper listbox pattern on the search box) rather than leaving this, the
   * newest mode, mouse/touch-only. */
  _bindKeyboard() {
    const el = this.renderer.domElement;
    el.setAttribute("tabindex", "0");
    el.setAttribute("role", "application");
    el.setAttribute("aria-label", "Tree of Life -- use arrow keys to navigate branches, Enter to select");

    el.addEventListener("focus", () => this._updateFocusRing());
    el.addEventListener("blur", () => { this._focusRing.visible = false; });

    el.addEventListener("keydown", (ev) => {
      if (!this._layout || !this._focusedId) return;
      const node = this._layout.byId.get(this._focusedId);
      if (!node) return;

      if (ev.code === "Enter" || ev.code === "Space") {
        ev.preventDefault();
        if (this._onSelect) this._onSelect(node);
        return;
      }

      let next = null;
      if (ev.code === "ArrowUp") {
        next = node.parent_id ? this._layout.byId.get(node.parent_id) : null;
      } else if (ev.code === "ArrowDown") {
        next = node.children[0] || null;
      } else if (ev.code === "ArrowLeft" || ev.code === "ArrowRight") {
        const parent = node.parent_id ? this._layout.byId.get(node.parent_id) : null;
        if (parent) {
          const i = parent.children.indexOf(node);
          const j = ev.code === "ArrowLeft" ? i - 1 : i + 1;
          if (j >= 0 && j < parent.children.length) next = parent.children[j];
        }
      }
      if (next) {
        ev.preventDefault();
        this._focusedId = next.id;
        this._updateFocusRing();
      }
    });
  }

  _updateFocusRing() {
    if (!this._layout || !this._focusedId) return;
    const node = this._layout.byId.get(this._focusedId);
    if (!node) return;
    const r0 = this._layout.radiusFor(node.first_ma, R_MAX);
    this._focusRing.position.set(r0 * Math.cos(node.angle), 0.01, r0 * Math.sin(node.angle));
    this._focusRing.visible = document.activeElement === this.renderer.domElement;
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
