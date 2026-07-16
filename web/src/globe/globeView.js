// globeView.js -- Three.js scene, camera, sphere + shader material, texture
// caching, and the custom drag-rotate/inertia controller for the deep-time
// globe. See PLAN.md's "Deep-time globe mode" section for the architecture.
//
// Renders through ONE pipeline for the whole timeline (structuralTexture.js),
// so this class only needs to cache/rebuild that one texture type plus the
// (always-present) cloud overlay -- no more separate Scotese/Blue-Marble
// texture sets or plate-drift displacement machinery.

import * as THREE from "three";
import { vertexShader, fragmentShader } from "./shaders.js";
import { StructuralTextureBuilder } from "./structuralTexture.js";
import { ContinentModel } from "./continents.js";

const STRUCTURAL_CACHE_STEP = 3;
const STRUCTURAL_CACHE_MAX = 60;

const LIGHT_DIR = new THREE.Vector3(0.38, 0.52, 0.76).normalize();
const SPIN_DECAY = 3.5; // matches main.py's exp(-3.5*dt)

function makeDummyTexture(color = [8, 20, 40]) {
  const c = document.createElement("canvas");
  c.width = c.height = 2;
  const ctx = c.getContext("2d");
  ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
  ctx.fillRect(0, 0, 2, 2);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

function loadTexture(loader, url) {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });
}

export class GlobeView {
  constructor(container, { texturesBase = "public/textures", dataBase = "public/data" } = {}) {
    this.container = container;
    this.texturesBase = texturesBase;
    this.dataBase = dataBase;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1.12, 1.12, 1.12, -1.12, 0.01, 10);
    this.camera.position.set(0, 0, 3);
    this.camera.lookAt(0, 0, 0);

    this.structuralBuilder = new StructuralTextureBuilder();
    this._structuralCache = new Map(); // maBucket -> THREE.Texture
    this._lastStructuralBucket = null;
    this._pendingBuildBucket = null; // bucket currently in flight on the worker, if any
    this._buildReqId = 0;

    this._continentModel = null;
    this._cloudTex = null;

    // Offload the structural texture build to a Worker (PERF.md's flagged
    // follow-up): even bbox-restricted, a >750 Ma build is ~one whole frame,
    // so a fast deep-time scrub on a low-end/mobile GPU could still drop
    // frames on the main thread. Feature-detected -- browsers without Worker/
    // OffscreenCanvas fall back to the original synchronous build below,
    // same graceful-degradation philosophy as the globeAvailable fallback.
    this._worker = null;
    if (typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined") {
      try {
        this._worker = new Worker(new URL("./structuralTexture.worker.js", import.meta.url), { type: "module" });
        this._worker.onmessage = (ev) => this._onWorkerMessage(ev.data);
        this._worker.onerror = (ev) => {
          console.error("Structural texture worker failed, falling back to synchronous build:", ev.message);
          this._worker = null;
          this._pendingBuildBucket = null;
        };
      } catch (exc) {
        console.error("Structural texture worker unavailable, using synchronous build:", exc);
        this._worker = null;
      }
    }

    this._dummyTex = makeDummyTexture();

    this._buildStarfield();
    this._buildAtmosphereHalo();
    this._buildGlobeMesh();
    this._bindDragControls();

    this._spinLon = 0;
    this._spinLat = 0;
    this._lon0 = -20;
    this._lat0 = 20;
    this._dragActive = false;

    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(container);
    this.resize();
  }

  async load() {
    const continentsData = await fetch(`${this.dataBase}/continents.json`).then((r) => r.json());
    // Built on the main thread too, even when the worker is active: it's the
    // synchronous fallback if the worker ever errors out mid-session (see the
    // constructor's onerror handler), and the cost is trivial (continents.json
    // is ~120 KB gzip per PERF.md, this is just parsing it into the model).
    this._continentModel = new ContinentModel(continentsData);
    if (this._worker) this._worker.postMessage({ type: "init", continentsData });

    const loader = new THREE.TextureLoader();
    const cloud = await loadTexture(loader, `${this.texturesBase}/cloud_layer.jpg`);
    cloud.wrapS = THREE.RepeatWrapping;
    cloud.wrapT = THREE.ClampToEdgeWrapping;
    cloud.colorSpace = THREE.NoColorSpace ?? THREE.LinearSRGBColorSpace;
    this._cloudTex = cloud;
    this.material.uniforms.uCloudTex.value = cloud;
  }

  _buildGlobeMesh() {
    const geo = new THREE.SphereGeometry(1, 96, 96);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uStructuralTex: { value: this._dummyTex },
        uCloudTex: { value: this._dummyTex },
        uCloudOpacity: { value: 0.5 },
        uCloudScrollU: { value: 0 },
        uLightDir: { value: LIGHT_DIR },
        uLonOffset: { value: 0 },
      },
      vertexShader,
      fragmentShader,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    // Sphere UVs run u=0 at -X; rotate mesh so u=0.5 initially faces the
    // camera, matching the equirect texture's lon=0 center convention.
    this.mesh.rotation.y = Math.PI / 2;
    this.scene.add(this.mesh);
  }

  _buildAtmosphereHalo() {
    const geo = new THREE.SphereGeometry(1.045, 64, 64);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {},
      vertexShader: /* glsl */ `
        varying vec3 vNormalView;
        void main() {
          vNormalView = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vNormalView;
        void main() {
          float r2 = clamp(1.0 - vNormalView.z * vNormalView.z, 0.0, 1.0);
          float t = smoothstep(0.55, 1.0, r2);
          vec3 atm = vec3(80.0, 150.0, 255.0) / 255.0;
          gl_FragColor = vec4(atm, t * 0.55);
        }
      `,
    });
    this.haloMesh = new THREE.Mesh(geo, mat);
    this.scene.add(this.haloMesh);
  }

  _buildStarfield() {
    const count = 800;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = 8 + Math.random() * 4;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.03, sizeAttenuation: true });
    this.scene.add(new THREE.Points(geo, mat));
  }

  // ── drag rotate + exponential-decay inertia (custom, not OrbitControls) ──
  _bindDragControls() {
    const el = this.renderer.domElement;
    let dragging = false;
    let prevX = 0, prevY = 0, prevT = 0;

    const onDown = (x, y) => {
      dragging = true;
      this._dragActive = true;
      prevX = x; prevY = y; prevT = performance.now();
      this._spinLon = 0; this._spinLat = 0;
    };
    const onMove = (x, y) => {
      if (!dragging) return;
      const now = performance.now();
      const dt = Math.max(0.001, (now - prevT) / 1000);
      const rect = el.getBoundingClientRect();
      const R = Math.min(rect.width, rect.height) / 2;
      const dps = 180.0 / R; // degrees per pixel, matching main.py's dps=180/GLOBE_R
      const dmx = x - prevX, dmy = y - prevY;
      this._spinLon = -dmx * dps / dt;
      this._spinLat = -dmy * dps / dt;
      this._setView(this._lon0 - dmx * dps, this._lat0 - dmy * dps);
      prevX = x; prevY = y; prevT = now;
    };
    const onUp = () => { dragging = false; this._dragActive = false; };

    el.addEventListener("mousedown", (ev) => onDown(ev.clientX, ev.clientY));
    window.addEventListener("mousemove", (ev) => onMove(ev.clientX, ev.clientY));
    window.addEventListener("mouseup", onUp);
    el.addEventListener("touchstart", (ev) => {
      const t = ev.touches[0]; onDown(t.clientX, t.clientY);
    }, { passive: true });
    el.addEventListener("touchmove", (ev) => {
      const t = ev.touches[0]; onMove(t.clientX, t.clientY);
    }, { passive: true });
    el.addEventListener("touchend", onUp);
  }

  _setView(lon, lat) {
    this._lon0 = ((lon % 360) + 360) % 360;
    this._lat0 = Math.max(-85, Math.min(85, lat));
    this.mesh.rotation.y = Math.PI / 2 + THREE.MathUtils.degToRad(this._lon0);
    this.mesh.rotation.x = THREE.MathUtils.degToRad(this._lat0);
  }

  /** Advance inertia after drag release; call once per animation frame. */
  tickInertia(dt) {
    if (this._dragActive) return;
    if (Math.abs(this._spinLon) > 0.3 || Math.abs(this._spinLat) > 0.3) {
      this._setView(this._lon0 + this._spinLon * dt, this._lat0 + this._spinLat * dt);
      const decay = Math.exp(-SPIN_DECAY * dt);
      this._spinLon *= decay;
      this._spinLat *= decay;
    }
  }

  /** Cache a built texture (from either build path) under its Ma bucket,
   * evicting the oldest entry past STRUCTURAL_CACHE_MAX. Textures built from
   * a transferred ImageBitmap (the worker path) own that bitmap and must
   * close() it on eviction, not just dispose() the GPU-side texture -- an
   * ImageBitmap is separate off-heap memory the GC won't reliably reclaim
   * promptly on its own. */
  _cacheStructuralTexture(bucket, tex) {
    this._structuralCache.set(bucket, tex);
    if (this._structuralCache.size > STRUCTURAL_CACHE_MAX) {
      const oldestKey = this._structuralCache.keys().next().value;
      const oldest = this._structuralCache.get(oldestKey);
      if (oldest) {
        if (typeof oldest.image?.close === "function") oldest.image.close();
        oldest.dispose();
      }
      this._structuralCache.delete(oldestKey);
    }
  }

  _makeTextureFromCanvasLike(source) {
    const tex = new THREE.Texture(source);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.NoColorSpace ?? THREE.LinearSRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  _onWorkerMessage(msg) {
    if (msg.type !== "built") return;
    const bucket = Math.floor(msg.ma / STRUCTURAL_CACHE_STEP) * STRUCTURAL_CACHE_STEP;
    this._cacheStructuralTexture(bucket, this._makeTextureFromCanvasLike(msg.bitmap));
    if (this._pendingBuildBucket === bucket) this._pendingBuildBucket = null;
    // Deliberately not swapped into the uniform here -- setMa() re-checks the
    // cache every frame regardless of which path filled it, so the very next
    // call (next frame) picks this up if it's still the relevant bucket.
  }

  /** Synchronous fallback build path (no Worker/OffscreenCanvas support, or
   * the worker errored out) -- unchanged from before the worker offload. */
  _buildStructuralTextureSync(ma, bucket) {
    if (!this._continentModel) return null;
    const canvas = this.structuralBuilder.build(bucket, this._continentModel);
    const copy = document.createElement("canvas");
    copy.width = canvas.width; copy.height = canvas.height;
    copy.getContext("2d").drawImage(canvas, 0, 0);
    const tex = this._makeTextureFromCanvasLike(copy);
    this._cacheStructuralTexture(bucket, tex);
    return tex;
  }

  /** Update all shader uniforms for the given Ma. At most one structural
   * texture build is *started* per call (matches the plan's throttling
   * rule) -- with the worker active, "started" and "finished" are decoupled:
   * this keeps showing whatever's already in the uniform until the cache
   * actually has the new bucket, rather than blocking the frame on it. */
  setMa(ma) {
    const u = this.material.uniforms;

    const bucket = Math.floor(ma / STRUCTURAL_CACHE_STEP) * STRUCTURAL_CACHE_STEP;
    if (bucket !== this._lastStructuralBucket) {
      if (this._structuralCache.has(bucket)) {
        u.uStructuralTex.value = this._structuralCache.get(bucket);
        this._lastStructuralBucket = bucket;
      } else if (this._worker) {
        if (this._pendingBuildBucket !== bucket) {
          this._pendingBuildBucket = bucket;
          this._worker.postMessage({ type: "build", ma: bucket, requestId: ++this._buildReqId });
        }
        // _lastStructuralBucket intentionally left as-is: the uniform keeps
        // showing the previous texture until _onWorkerMessage populates the
        // cache and a later setMa() call (next frame) picks it up above.
      } else {
        const tex = this._buildStructuralTextureSync(ma, bucket);
        if (tex) { u.uStructuralTex.value = tex; this._lastStructuralBucket = bucket; }
      }
    }

    // Cloud opacity per era (matches main.py's cloud_opac branches) -- kept
    // as the one atmospheric element that varies with era, tying the whole
    // timeline together visually rather than signaling a rendering-style switch.
    let cloudOpac;
    if (ma >= 635 && ma <= 720) cloudOpac = 0.18;
    else if (ma >= 2050 && ma <= 2400) cloudOpac = 0.20;
    else if (ma >= 435 && ma <= 450) cloudOpac = 0.28;
    else if (ma >= 260 && ma <= 360) cloudOpac = 0.30;
    else if (ma < 2.6) cloudOpac = 0.38;
    else if (ma < 65) cloudOpac = 0.50;
    else if (ma < 300) cloudOpac = 0.55;
    else if (ma < 1000) cloudOpac = 0.58;
    else cloudOpac = 0.63;
    u.uCloudOpacity.value = cloudOpac;
    u.uCloudScrollU.value = ((ma * 2.7) % 720) / 720;
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    const margin = 1.12;
    if (aspect >= 1) {
      this.camera.left = -margin * aspect; this.camera.right = margin * aspect;
      this.camera.top = margin; this.camera.bottom = -margin;
    } else {
      this.camera.left = -margin; this.camera.right = margin;
      this.camera.top = margin / aspect; this.camera.bottom = -margin / aspect;
    }
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
