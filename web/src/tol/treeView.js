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
    this._orbitDist = 22;
    this._spinAz = 0; this._spinEl = 0;
    this._dragActive = false;

    this._layout = null;
    this._nodeMeshes = new Map(); // id -> THREE.Mesh
    this._raycaster = new THREE.Raycaster();
    this._onSelect = null;
    this._hoveredId = null;
    this._focusedId = null; // keyboard-navigation cursor, separate from click-selection

    this._buildLights();
    this._buildCurrentEraRing();
    this._buildFocusRing();
    this._bindDragControls();
    this._bindClick();
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

  _buildTree() {
    const group = new THREE.Group();
    for (const n of this._layout.nodes()) {
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

      const label = makeLabelSprite(n.label, `rgb(${n.color[0]},${n.color[1]},${n.color[2]})`);
      const labelR = r0 + 0.85;
      label.position.set(labelR * Math.cos(n.angle), 0.15, labelR * Math.sin(n.angle));
      group.add(label);
    }
    this.scene.add(group);
    this._treeGroup = group;
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
      this._orbitDist = clamp(this._orbitDist * (ev.deltaY < 0 ? 0.9 : 1.1), 6, 45);
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
  }

  _bindClick() {
    const el = this.renderer.domElement;
    let downX = 0, downY = 0;
    el.addEventListener("mousedown", (ev) => { downX = ev.clientX; downY = ev.clientY; });
    el.addEventListener("mouseup", (ev) => {
      // Only treat this as a click (not the end of a drag-rotate) if the
      // pointer barely moved between mousedown and mouseup.
      if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 4) return;
      const rect = el.getBoundingClientRect();
      const x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      this._raycaster.setFromCamera({ x, y }, this.camera);
      const hits = this._raycaster.intersectObjects([...this._nodeMeshes.values()]);
      if (hits.length && this._onSelect) {
        const node = this._layout.byId.get(hits[0].object.userData.nodeId);
        this._onSelect(node);
      }
    });
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
