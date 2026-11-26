import * as THREE from '../third-party/apex-formula-2026/lib/three.module.js';
import { TRACKS } from '../third-party/apex-formula-2026/js/tracks.js';
import { buildCircuit } from '../third-party/apex-formula-2026/js/trackBuilder.js';
import { buildCarMesh, preloadCarModel, setTyreCompound } from '../third-party/apex-formula-2026/js/car.js';
import { TEAMS, DRIVERS } from '../third-party/apex-formula-2026/js/data-fictional.js';
import { skyDome } from '../third-party/apex-formula-2026/js/textures.js';
import { GLTFLoader } from '../third-party/apex-formula-2026/lib/loaders/GLTFLoader.js';
import model from '../third-party/apex-formula-2026/assets/f1car-2026.glb';
window.THREE = THREE;
window.APEX_VISUALS = { TRACKS, buildCircuit, buildCarMesh, setTyreCompound, TEAMS, DRIVERS, skyDome };
// Embedded GLB bytes: no fetch/file:// CORS and no HTTP server required.
window.APEX_READY = new Promise((resolve, reject) => {
  const bytes = Uint8Array.from(atob(model), c => c.charCodeAt(0));
  new GLTFLoader().parse(bytes.buffer, '', gltf => {
    preloadCarModel(gltf.scene).then(resolve, reject);
  }, reject);
});
