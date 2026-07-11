// globeView.js -- Three.js scene, camera, sphere + shader material, texture
// caching, and the custom drag-rotate/inertia controller for the deep-time
// globe. See PLAN.md's "Deep-time globe mode" section for the architecture.

import * as THREE from "three";
import { vertexShader, fragmentShader } from "./shaders.js";
import { StructuralTextureBuilder } from "./structuralTexture.js";
import { ContinentModel } from "./continents.js";

const SCOTESE_MAS = [
  0, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 66,
  75, 80, 90, 100, 105, 110, 120, 130, 140, 150, 160, 170, 180,
  200, 220, 240, 250, 260, 270, 280, 290, 300, 310, 320, 330, 340,
  350, 360, 370, 380, 390, 400, 410, 420, 430, 440, 450, 460, 470,
  480, 490, 500, 510, 520, 530, 540, 600, 690, 750,
];
const PT_MAX_MA = 750;

const STRUCTURAL_CACHE_STEP = 3;
const STRUCTURAL_CACHE_MAX = 60;
const SCOTESE_CACHE_MAX = 24;

const LIGHT_DIR = new THREE.Vector3(0.38, 0.52, 0.76).normalize();
const SPIN_DECAY = 3.5; // matches main.py's exp(-3.5*dt)
const DEG_PER_UNIT = 1; // degrees-per-pixel scale is computed from container size

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
    this._structuralCache = new Map(); // maBucket -> THREE.CanvasTexture
    this._scoteseCache = new Map();    // exactMa -> THREE.Texture
    this._scoteseLoader = new THREE.TextureLoader();
    this._lastStructuralBucket = null;
    this._pendingScoteseLoads = new Set();

    this._continentModel = null;
    this._blueMarbleTex = null;
    this._cloudTex = null;
    this._plateOffsetTex = null;

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
    const [continentsData] = await Promise.all([
      fetch(`${this.dataBase}/continents.json`).then((r) => r.json()),
    ]);
    this._continentModel = new ContinentModel(continentsData);

    const loader = this._scoteseLoader;
    const [bm, cloud, plateOffset] = await Promise.all([
      loadTexture(loader, `${this.texturesBase}/blue_marble.jpg`),
      loadTexture(loader, `${this.texturesBase}/cloud_layer.jpg`),
      loadTexture(loader, `${this.texturesBase}/plate_offset.png`).catch(() => this._dummyTex),
    ]);
    for (const t of [bm, cloud, plateOffset]) {
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      // Sample raw byte values with NO sRGB->linear decode. The custom
      // ShaderMaterial composites in sRGB byte-space (mirroring main.py's uint8
      // pipeline: rgb = tex_bytes * shade) and never re-encodes on output, so
      // tagging these sRGB gamma-darkens the whole globe to near-black. It would
      // also corrupt plate_offset.png, which stores displacement DATA, not color.
      // This matches the Scotese keyframe textures, which are already left raw.
      t.colorSpace = THREE.NoColorSpace ?? THREE.LinearSRGBColorSpace;
    }
    this._blueMarbleTex = bm;
    this._cloudTex = cloud;
    this._plateOffsetTex = plateOffset;
    this.material.uniforms.uBlueMarbleTex.value = bm;
    this.material.uniforms.uCloudTex.value = cloud;
    this.material.uniforms.uPlateOffsetTex.value = plateOffset;
  }

  _buildGlobeMesh() {
    const geo = new THREE.SphereGeometry(1, 96, 96);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uStructuralTex: { value: this._dummyTex },
        uScoteseLoTex: { value: this._dummyTex },
        uScoteseHiTex: { value: this._dummyTex },
        uScoteseFrac: { value: 0 },
        uUseScotese: { value: 0 },
        uBlueMarbleTex: { value: this._dummyTex },
        uPlateOffsetTex: { value: this._dummyTex },
        uBMWeight: { value: 0 },
        uPlateFrac: { value: 0 },
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

  // ── texture selection for a given Ma ─────────────────────────────────────
  _scoteseFor(ma) {
    if (ma > PT_MAX_MA) return null;
    let lo = SCOTESE_MAS[0], hi = SCOTESE_MAS[SCOTESE_MAS.length - 1];
    for (const m of SCOTESE_MAS) if (m <= ma) lo = m;
    for (let i = SCOTESE_MAS.length - 1; i >= 0; i--) if (SCOTESE_MAS[i] >= ma) hi = SCOTESE_MAS[i];
    return { lo, hi, frac: hi === lo ? 0 : (ma - lo) / (hi - lo) };
  }

  _getScoteseTexture(maKey) {
    if (this._scoteseCache.has(maKey)) return this._scoteseCache.get(maKey);
    if (!this._pendingScoteseLoads.has(maKey)) {
      this._pendingScoteseLoads.add(maKey);
      this._scoteseLoader.load(
        `${this.texturesBase}/scotese/${maKey}.jpg`,
        (tex) => {
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping;
          this._scoteseCache.set(maKey, tex);
          if (this._scoteseCache.size > SCOTESE_CACHE_MAX) {
            const oldestKey = this._scoteseCache.keys().next().value;
            this._scoteseCache.get(oldestKey)?.dispose();
            this._scoteseCache.delete(oldestKey);
          }
          this._pendingScoteseLoads.delete(maKey);
        },
        undefined,
        () => this._pendingScoteseLoads.delete(maKey)
      );
    }
    return null; // not yet loaded -- caller keeps using whatever was last bound
  }

  _getStructuralTexture(ma) {
    const bucket = Math.floor(ma / STRUCTURAL_CACHE_STEP) * STRUCTURAL_CACHE_STEP;
    if (this._structuralCache.has(bucket)) return this._structuralCache.get(bucket);
    if (!this._continentModel) return null;
    const canvas = this.structuralBuilder.build(bucket, this._continentModel);
    const copy = document.createElement("canvas");
    copy.width = canvas.width; copy.height = canvas.height;
    copy.getContext("2d").drawImage(canvas, 0, 0);
    const tex = new THREE.CanvasTexture(copy);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this._structuralCache.set(bucket, tex);
    if (this._structuralCache.size > STRUCTURAL_CACHE_MAX) {
      const oldestKey = this._structuralCache.keys().next().value;
      this._structuralCache.get(oldestKey)?.dispose();
      this._structuralCache.delete(oldestKey);
    }
    return tex;
  }

  /** Update all shader uniforms for the given Ma. At most one structural
   * texture rebuild happens per call (matches the plan's throttling rule). */
  setMa(ma) {
    const u = this.material.uniforms;

    if (ma > PT_MAX_MA) {
      u.uUseScotese.value = 0;
      const bucket = Math.floor(ma / STRUCTURAL_CACHE_STEP) * STRUCTURAL_CACHE_STEP;
      if (bucket !== this._lastStructuralBucket) {
        const tex = this._getStructuralTexture(ma);
        if (tex) { u.uStructuralTex.value = tex; this._lastStructuralBucket = bucket; }
      }
    } else {
      u.uUseScotese.value = 1;
      const { lo, hi, frac } = this._scoteseFor(ma);
      const loTex = this._getScoteseTexture(lo);
      const hiTex = lo === hi ? loTex : this._getScoteseTexture(hi);
      if (loTex) u.uScoteseLoTex.value = loTex;
      if (hiTex) u.uScoteseHiTex.value = hiTex;
      u.uScoteseFrac.value = frac;
    }

    // Blue Marble blend (ma < 65)
    if (ma < 65 && this._blueMarbleTex) {
      const frac = ma / 65.0;
      const smooth = frac * frac * (3.0 - 2.0 * frac);
      u.uBMWeight.value = Math.max(0, 1.0 - smooth);
      u.uPlateFrac.value = Math.max(0, Math.min(1, frac));
    } else {
      u.uBMWeight.value = 0;
    }

    // Cloud opacity per era (matches main.py's cloud_opac branches)
    let cloudOpac;
    if (ma >= 635 && ma <= 720) cloudOpac = 0.18;
    else if (ma >= 2050 && ma <= 2400) cloudOpac = 0.20;
    else if (ma >= 435 && ma <= 450) cloudOpac = 0.28;
    else if (ma >= 260 && ma <= 360) cloudOpac = 0.30;
    else if (ma < 2.6) cloudOpac = 0.38;
    else if (ma < 65 && u.uBMWeight.value > 0) cloudOpac = Math.max(0.48, u.uBMWeight.value * 0.80);
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
