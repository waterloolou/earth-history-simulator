// structuralTexture.worker.js -- runs StructuralTextureBuilder.build() off the
// main thread. PERF.md flagged this as a known follow-up: even after the
// per-polygon bounding-box optimization, a >750 Ma build (the blob-splatting
// branch) is ~one whole frame, so a fast deep-time scrub on a low-end/mobile
// GPU could still drop frames. Moving build() here means the render loop
// never blocks on it -- globeView.js keeps showing the previous texture and
// swaps in the new one only once a "built" message arrives.
//
// No DOM/window APIs are used anywhere in this dependency chain (continents.js
// and biome.js are pure math; mountains.js and structuralTexture.js only ever
// touch the CanvasRenderingContext2D they're handed, which OffscreenCanvas
// implements with the same interface) -- confirmed by reading all three
// before writing this file, not assumed.

import { StructuralTextureBuilder } from "./structuralTexture.js";
import { ContinentModel } from "./continents.js";

let builder = null;
let continentModel = null;

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "init") {
    continentModel = new ContinentModel(msg.continentsData);
    builder = new StructuralTextureBuilder();
    return;
  }
  if (msg.type === "build") {
    if (!builder || !continentModel) return; // build requested before init landed; caller will retry
    const canvas = builder.build(msg.ma, continentModel);
    // transferToImageBitmap hands the pixel data to the main thread with zero
    // copy (unlike getImageData, which would serialize the whole buffer) and
    // resets this worker's canvas for the next build.
    const bitmap = canvas.transferToImageBitmap();
    self.postMessage({ type: "built", requestId: msg.requestId, ma: msg.ma, bitmap }, [bitmap]);
  }
};
