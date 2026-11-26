import * as THREE from 'three';
import * as TEX from './textures.js';
import { TRACKS } from './tracks.js';
import { buildCircuit } from './trackBuilder.js';

/* --------------------------------------------------------------------------
 * 赛道 / 场景 / PIT 浏览器
 *
 * 画面中的一切（赛道几何、路面材质、护墙、看台、维修区建筑、PIT 墙、
 * 围场、地表、远景、夜景灯光）全部由仓库原有模块实时生成：
 *   - js/trackBuilder.js   buildCircuit(trackId, def, scene, options)
 *   - js/textures.js       程序化贴图（天空穹顶等）
 *   - js/tracks.js         24 条 2026 赛历赛道控制点
 * 本文件只负责：渲染器 / 环境光 / 相机运镜 / 少量 UI。
 * -------------------------------------------------------------------------- */

const TRACK_IDS = Object.keys(TRACKS);
const query = new URLSearchParams(location.search);

const ui = {
  app: document.getElementById('app'),
  select: document.getElementById('track-select'),
  loading: document.getElementById('loading'),
  bar: document.getElementById('load-bar'),
  pct: document.getElementById('load-pct'),
  err: document.getElementById('load-err'),
  hint: document.getElementById('modehint'),
  chipLength: document.getElementById('chip-length'),
  chipWidth: document.getElementById('chip-width'),
  chipTheme: document.getElementById('chip-theme'),
  buttons: [...document.querySelectorAll('button[data-mode]')],
};

/* -- renderer ------------------------------------------------------------- */
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
ui.app.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(64, innerWidth / innerHeight, 0.4, 8000);

/* -- scene state ---------------------------------------------------------- */
const SUN_DIR = new THREE.Vector3(260, 380, 160).normalize();
const sunTarget = new THREE.Object3D();

let scene = null;
let circuit = null;
let sun = null;
let sky = null;
let hemi = null;
let ambient = null;
let envRT = null;
let baseFog = { near: 300, far: 1600 };

let mode = query.get('mode') || 'top';
let cruiseDistance = 0;
let cruisePaused = false;
let lightClock = 0;
let lightStep = -1;

const cam = {
  target: new THREE.Vector3(),
  radius: 900,
  theta: 0.75,
  phi: 1.05,
};

/* -- helpers -------------------------------------------------------------- */
const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const samplePoint = (i, out = new THREE.Vector3()) => {
  const k = ((i % circuit.N) + circuit.N) % circuit.N;
  const s = circuit.samples[k];
  return out.set(s.p.x, circuit.heights[k], s.p.z);
};

const sampleIndexAtDistance = (m) => {
  const n = circuit.N;
  const f = ((m / circuit.ds) % n + n) % n;
  return Math.floor(f);
};

const circuitBounds = () => {
  const b = new THREE.Box3();
  const p = new THREE.Vector3();
  for (let i = 0; i < circuit.N; i += 4) b.expandByPoint(samplePoint(i, p));
  return b;
};

const disposeScene = (s) => {
  if (!s) return;
  if (envRT) { envRT.dispose(); envRT = null; }
  s.traverse((o) => {
    if (!o.isMesh && !o.isPoints && !o.isSprite) return;
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      for (const k of Object.keys(m)) {
        const v = m[k];
        if (v && v.isTexture) v.dispose();
      }
      m.dispose();
    }
  });
  s.clear();
};

/* -- environment (mirrors main.js setupEnvironment, track-side only) ------ */
const setupEnvironment = (c) => {
  const th = c.theme;
  baseFog = { near: th.fogNear ?? 300, far: th.fogFar ?? 1600 };
  scene.fog = new THREE.Fog(th.fog, baseFog.near, baseFog.far);

  const skyTex = new THREE.CanvasTexture(TEX.skyDome(
    '#' + new THREE.Color(th.skyTop).getHexString(),
    '#' + new THREE.Color(th.skyBot).getHexString(),
    { clouds: !th.night, dusk: false, horizonStop: th.night ? 1 : 0.52 },
  ));
  skyTex.colorSpace = THREE.SRGBColorSpace;
  sky = new THREE.Mesh(
    new THREE.SphereGeometry(2600, 24, 12),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  sky.renderOrder = -1;
  scene.add(sky);

  hemi = new THREE.HemisphereLight(th.skyTop, th.ground, th.hemi);
  scene.add(hemi);

  sun = new THREE.DirectionalLight(th.sun, th.sunI);
  sun.position.copy(SUN_DIR).multiplyScalar(420);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -220; sc.right = 220; sc.top = 220; sc.bottom = -220;
  sc.near = 20; sc.far = 1200;
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  scene.add(sun, sunTarget);
  sun.target = sunTarget;

  if (th.night) {
    ambient = new THREE.AmbientLight(0x8899cc, 0.45);
    scene.add(ambient);
  }

  // PMREM-from-dome IBL fallback, same construction as main.js's setupEnvironment.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(sky.clone());
  const groundDisc = new THREE.Mesh(
    new THREE.CircleGeometry(2000, 24).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: th.ground }),
  );
  groundDisc.position.y = -2;
  envScene.add(groundDisc);
  envRT = pmrem.fromScene(envScene, 0.04);
  scene.environment = envRT.texture;
  scene.environmentIntensity = th.night ? 0.5 : (th.floodlit ? 1.0 : 0.85);
  pmrem.dispose();
  groundDisc.geometry.dispose();
  groundDisc.material.dispose();

  renderer.toneMappingExposure = th.night ? 0.92 : (th.floodlit ? 1.05 : 0.94);
};

const updateShadowExtent = (span) => {
  if (!sun) return;
  const sc = sun.shadow.camera;
  sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span;
  sc.near = 20; sc.far = 1400;
  sc.updateProjectionMatrix();
};

/* -- camera modes --------------------------------------------------------- */
const modeHints = {
  top: '<b>全景</b>：整个赛道 + 场景布局。拖拽可绕看，滚轮缩放。',
  orbit: '<b>环绕</b>：以赛道中心缓慢环绕，看护墙 / 看台 / 远景的层次。',
  cruise: '<b>赛道巡航</b>：沿赛道路面飞行（视高 7 m），空格暂停。',
  grid: '<b>发车区</b>：发车格后方视角，正对起跑线和发车灯。',
  pit: '<b>PIT 巡览</b>：维修区建筑、PIT 墙与维修通道的三分四视角。',
  lights: '<b>起跑灯</b>：正对起跑灯架，循环演示 5 盏灯熄灭起步。',
};

const setModeButton = (m) => {
  for (const b of ui.buttons) b.classList.toggle('on', b.dataset.mode === m);
  ui.hint.innerHTML = modeHints[m] ?? '';
};

const adoptOrbit = (target, radius, theta, phi) => {
  cam.target.copy(target);
  cam.radius = radius;
  cam.theta = theta;
  cam.phi = phi;
};

/* -- orbit math (left drag rotate / wheel zoom / right drag pan) ---------- */
const applyOrbit = () => {
  const sp = Math.sin(cam.phi);
  camera.position.set(
    cam.target.x + cam.radius * sp * Math.sin(cam.theta),
    cam.target.y + cam.radius * Math.cos(cam.phi),
    cam.target.z + cam.radius * sp * Math.cos(cam.theta),
  );
  camera.lookAt(cam.target);
};

/* -- cruise / grid -------------------------------------------------------- */
const updateCruiseCamera = (dt) => {
  if (!cruisePaused) cruiseDistance += dt * 34;
  const i = sampleIndexAtDistance(cruiseDistance);
  const s = circuit.samples[i];
  const p = samplePoint(i);
  const ahead = sampleIndexAtDistance(cruiseDistance + 70);
  const a = samplePoint(ahead);
  const lat = 1.1;
  camera.position.set(p.x + s.n.x * lat, p.y + 7.2, p.z + s.n.z * lat);
  camera.lookAt(a.x, a.y + 1.6, a.z);
  cam.target.set(a.x, a.y + 1.6, a.z);
};

const updateGridCamera = () => {
  const g = circuit.gridSlots[0];
  const s = circuit.samples[g.idx];
  const p = samplePoint(g.idx);
  const behind = p.clone().addScaledVector(s.t, -16).setY(p.y + 4.2);
  const look = p.clone().addScaledVector(s.t, 35).setY(p.y + 2.2);
  camera.position.copy(behind);
  camera.lookAt(look);
  cam.target.copy(look);
};

/* -- PIT camera ----------------------------------------------------------- */
let pitBuilding = null;
let pitClock = 0;

const pitSetup = () => {
  pitBuilding = circuit.group.getObjectByName('pit-building') ?? null;
  pitClock = 0;
  if (!pitBuilding) {
    // 少数赛道没有维修区建筑时，退化为起点附近的环绕视角
    const p0 = samplePoint(0);
    adoptOrbit(p0.clone(), 180, 0.9, 0.9);
  } else {
    circuit.group.updateMatrixWorld(true);
  }
};

const updatePitCamera = (dt) => {
  if (!pitBuilding) {
    applyOrbit();
    return;
  }
  pitClock += dt;
  const phase = Math.sin(pitClock * 0.16);
  // three-quarter TV angle on the pit complex: garages, pit wall and pit lane in one frame
  const x = 48 + phase * 26;
  const from = new THREE.Vector3(x, 20, 66).applyMatrix4(pitBuilding.matrixWorld);
  const look = new THREE.Vector3(0, 4.5, 4).applyMatrix4(pitBuilding.matrixWorld);
  camera.position.copy(from);
  camera.lookAt(look);
  cam.target.copy(look);
};

const setMode = (m) => {
  mode = m;
  cruisePaused = false;
  lightClock = 0;
  lightStep = -1;
  setModeButton(m);
  if (!circuit) return;

  if (m === 'top') {
    const b = circuitBounds();
    const center = b.getCenter(new THREE.Vector3());
    const extent = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
    adoptOrbit(center.setY(0), clamp(extent * 1.15, 400, 2250), 0.55, 0.09);
    updateShadowExtent(Math.min(1200, extent * 0.55));
  } else if (m === 'orbit') {
    const b = circuitBounds();
    const center = b.getCenter(new THREE.Vector3());
    const extent = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
    adoptOrbit(center.setY(0), extent * 0.72, 0.9, 1.0);
    updateShadowExtent(260);
  } else if (m === 'cruise') {
    cruiseDistance = 0;
    updateShadowExtent(260);
    updateCruiseCamera(0);
  } else if (m === 'grid') {
    updateGridCamera();
    updateShadowExtent(240);
  } else if (m === 'pit') {
    pitSetup();
    updateShadowExtent(260);
  } else if (m === 'lights') {
    const p0 = samplePoint(0);
    const back = samplePoint(Math.round(-95 / circuit.ds));
    camera.position.copy(back).add(new THREE.Vector3(0, 7.5, 0));
    camera.lookAt(p0.x, p0.y + 7.2, p0.z);
    cam.target.set(p0.x, p0.y + 7.2, p0.z);
    updateShadowExtent(180);
  }
};

/* -- UI: 赛道选择 --------------------------------------------------------- */
const fillTrackSelect = () => {
  for (const id of TRACK_IDS) {
    const def = TRACKS[id];
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = `${def.name} · ${def.country}`;
    ui.select.appendChild(opt);
  }
  const wanted = query.get('track');
  ui.select.value = TRACK_IDS.includes(wanted) ? wanted : (TRACK_IDS.includes('monza') ? 'monza' : TRACK_IDS[0]);
};

const updateChips = () => {
  const def = TRACKS[circuit.id];
  ui.chipLength.innerHTML = `长度 <b>${(circuit.length / 1000).toFixed(3)} km</b>`;
  ui.chipWidth.innerHTML = `宽度 <b>${def.width.toFixed(0)} m</b>`;
  const themeLabel = circuit.theme.night ? '夜间' : (circuit.theme.floodlit ? '黄昏 / 泛光' : '日间');
  ui.chipTheme.innerHTML = `主题 <b>${themeLabel}</b>`;
};

/* -- load / rebuild ------------------------------------------------------- */
let buildToken = 0;

const showLoading = (on, pct, text) => {
  ui.loading.classList.toggle('hidden', !on);
  if (pct != null) ui.bar.style.width = `${pct}%`;
  if (pct != null) ui.pct.textContent = `${Math.round(pct)}%${text ? ' · ' + text : ''}`;
};

const loadTrack = async (id) => {
  const token = ++buildToken;
  showLoading(true, 4, '生成赛道样条');
  await raf();
  if (token !== buildToken) return;

  try {
    const old = scene;
    if (old) disposeScene(old);

    scene = new THREE.Scene();
    scene.name = 'circuit-scene';
    circuit = buildCircuit(id, TRACKS[id], scene, {});
    setupEnvironment(circuit);

    if (token !== buildToken) return;
    showLoading(true, 100, '完成');
    await raf();
    if (token !== buildToken) return;

    updateChips();
    setMode(mode);
    showLoading(false);
    cruiseDistance = 0;
  } catch (err) {
    console.error(err);
    showLoading(true, 0, '构建失败');
    ui.err.textContent = String(err && err.stack ? err.stack : err);
  }
};

/* -- input ---------------------------------------------------------------- */
let dragging = null;

renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (mode === 'cruise' || mode === 'pit' || mode === 'lights' || mode === 'grid') return; // 自动运镜中不接管
  dragging = { x: e.clientX, y: e.clientY, button: e.button };
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener('pointerup', () => { dragging = null; });
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - dragging.x;
  const dy = e.clientY - dragging.y;
  dragging.x = e.clientX;
  dragging.y = e.clientY;
  if (dragging.button === 2 || dragging.button === 1) {
    const s = cam.radius / 900;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
    cam.target.addScaledVector(right, -dx * s).addScaledVector(up, dy * s);
  } else {
    cam.theta -= dx * 0.006;
    cam.phi = clamp(cam.phi - dy * 0.005, 0.06, Math.PI / 2 - 0.02);
  }
});
renderer.domElement.addEventListener('wheel', (e) => {
  if (mode === 'cruise' || mode === 'lights') return;
  e.preventDefault();
  cam.radius = clamp(cam.radius * Math.exp(e.deltaY * 0.0012), 20, 4000);
}, { passive: false });

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 't') setMode('top');
  else if (k === 'o') setMode('orbit');
  else if (k === 'c') setMode('cruise');
  else if (k === 'g') setMode('grid');
  else if (k === 'p') setMode('pit');
  else if (k === 'l') setMode('lights');
  else if (k === ' ') {
    e.preventDefault();
    cruisePaused = !cruisePaused;
  }
});

ui.buttons.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
ui.select.addEventListener('change', () => {
  const id = ui.select.value;
  history.replaceState(null, '', `?track=${id}&mode=${mode}`);
  void loadTrack(id);
});

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

/* -- frame loop ----------------------------------------------------------- */
let last = performance.now();

const startLightsSequence = (dt) => {
  if (!circuit) return;
  lightClock += dt;
  if (!circuit.startLightsAvailable) return;
  // 0..5 递增点亮，保持 1.4 s，然后全部熄灭（6 = lights out），再等 2 s 重来
  const cycle = 12.5;
  const t = lightClock % cycle;
  let step;
  if (t < 0.45) step = 0;
  else if (t < 0.9) step = 1;
  else if (t < 1.35) step = 2;
  else if (t < 1.8) step = 3;
  else if (t < 2.25) step = 4;
  else if (t < 2.7) step = 5;
  else if (t < 4.1) step = 5;
  else if (t < 10.5) step = 6; // lights out
  else step = 0;
  if (step !== lightStep) {
    lightStep = step;
    circuit.setStartLights(step <= 5 ? step : 6);
  }
};

const frame = () => {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (scene && circuit) {
    if (mode === 'top' || mode === 'orbit') applyOrbit();
    else if (mode === 'cruise') updateCruiseCamera(dt);
    else if (mode === 'pit') updatePitCamera(dt);
    else if (mode === 'lights') startLightsSequence(dt);
    else if (mode === 'grid') updateGridCamera();

    // Fog is authored for driving distance (near 300 / far 1600). Overview cameras
    // sit far outside that, so scale the range with the orbit distance instead of
    // letting the whole circuit dissolve into a flat fog wall.
    if (scene.fog && baseFog) {
      const dist = camera.position.distanceTo(cam.target);
      const k = Math.max(1, dist / 620);
      scene.fog.near = baseFog.near * k;
      scene.fog.far = baseFog.far * k;
    }

    sunTarget.position.copy(cam.target);
    if (sun) sun.position.copy(cam.target).addScaledVector(SUN_DIR, 420);
    if (sky) sky.position.set(cam.target.x, 0, cam.target.z);

    renderer.render(scene, camera);
  }
};

/* -- boot ---------------------------------------------------------------- */
fillTrackSelect();
setModeButton(mode);
void loadTrack(ui.select.value);
frame();

Object.assign(window, {
  viewer: {
    get scene() { return scene; },
    get circuit() { return circuit; },
    get camera() { return camera; },
    get renderer() { return renderer; },
    setMode,
    loadTrack,
    /** Place an orbit camera from a world position/target pair (used by tests and deep links). */
    lookFrom(pos, target) {
      const d = new THREE.Vector3().subVectors(pos, target);
      const r = Math.max(2, d.length());
      cam.target.copy(target);
      cam.radius = r;
      cam.phi = Math.acos(clamp(d.y / r, -1, 1));
      cam.theta = Math.atan2(d.x, d.z);
      mode = 'orbit';
      setModeButton('orbit');
    },
    pitAnchor() {
      const pit = circuit?.group.getObjectByName('pit-building');
      if (!pit) return null;
      pit.updateWorldMatrix(true, false);
      return { position: pit.position.toArray(), quaternion: pit.quaternion.toArray() };
    },
    state: { get mode() { return mode; }, cam },
  },
});
