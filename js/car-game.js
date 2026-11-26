const THREE = window.THREE;
const { TRACKS: SOURCE_TRACKS, buildCircuit, buildCarMesh, setTyreCompound, TEAMS, DRIVERS, skyDome } = window.APEX_VISUALS;
const TRACK_ID = { australia:'melbourne',china:'shanghai',japan:'suzuka',canada:'montreal',spain:'barcelona',austria:'spielberg',britain:'silverstone',belgium:'spa',hungary:'hungaroring',netherlands:'zandvoort',italy:'monza',azerbaijan:'baku',mexico:'mexico',brazil:'interlagos',qatar:'lusail','abu-dhabi':'yasmarina' };
const { TRACKS, controlPoints, trackById } = window.APEX_TRACKS;

/* ============================ 赛道选择与基础环境 ============================ */
const trackSelect = document.getElementById('trackSelect');
TRACKS.forEach(track => {
  const option = document.createElement('option');
  option.value = track.id;
  option.textContent = `${String(track.round).padStart(2, '0')} · ${track.zh} / ${track.en}`;
  trackSelect.appendChild(option);
});
const requestedTrack = new URLSearchParams(location.search).get('track');
const requestedTrackId = requestedTrack ? trackById(requestedTrack).id : 'italy';
trackSelect.value = TRACKS.some(track => track.id === requestedTrackId) ? requestedTrackId : DEFAULT_TRACK;
const selectedTrack = trackById(trackSelect.value);
const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.4, 8000);

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.appendChild(renderer.domElement);
} catch (error) {
  document.body.insertAdjacentHTML('beforeend', '<div class="panel" style="top:40%;left:50%;transform:translate(-50%,-50%);color:#ffb4b4;z-index:20">WebGL 初始化失败 / WebGL initialization failed<br>请使用支持 WebGL 的浏览器并刷新页面。</div>');
  throw error;
}

/* 原仓库 buildCircuit 原样构建路面、看台、护墙、PIT 楼、地形与远景。 */
const circuitId = TRACK_ID[selectedTrack.id] || selectedTrack.id;
const circuit = buildCircuit(circuitId, SOURCE_TRACKS[circuitId], scene, {});
const th = circuit.theme;
scene.fog = new THREE.Fog(th.fog, th.fogNear ?? 300, th.fogFar ?? 1600);
const skyTexture = new THREE.CanvasTexture(skyDome(
  '#' + new THREE.Color(th.skyTop).getHexString(),
  '#' + new THREE.Color(th.skyBot).getHexString(),
  { clouds: !th.night, dusk: false, horizonStop: th.night ? 1 : 0.52 }
));
skyTexture.colorSpace = THREE.SRGBColorSpace;
const sky = new THREE.Mesh(new THREE.SphereGeometry(2600, 24, 12),
  new THREE.MeshBasicMaterial({ map: skyTexture, side: THREE.BackSide, fog: false, depthWrite: false }));
sky.renderOrder = -1;
scene.add(sky);
const hemi = new THREE.HemisphereLight(th.skyTop, th.ground, th.hemi);
scene.add(hemi);
const sun = new THREE.DirectionalLight(th.sun, th.sunI);
const sunDirection = new THREE.Vector3(260, 380, 160).normalize();
sun.position.copy(sunDirection).multiplyScalar(420);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left:-260, right:260, top:260, bottom:-260, near:20, far:1400 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.05;
scene.add(sun, sun.target);
if (th.night) scene.add(new THREE.AmbientLight(0x8899cc, 0.45));
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
envScene.add(sky.clone());
const envGround = new THREE.Mesh(new THREE.CircleGeometry(2000,24).rotateX(-Math.PI/2),
  new THREE.MeshBasicMaterial({ color: th.ground }));
envGround.position.y = -2;
envScene.add(envGround);
const envRT = pmrem.fromScene(envScene, 0.04);
scene.environment = envRT.texture;
scene.environmentIntensity = th.night ? 0.5 : (th.floodlit ? 1.0 : 0.85);
pmrem.dispose(); envGround.geometry.dispose(); envGround.material.dispose();
renderer.toneMappingExposure = th.night ? 0.92 : (th.floodlit ? 1.05 : 0.94);

/* 雨天仍由游戏逻辑控制，但场景视觉采用原版主题的基准参数。 */
const baseFogColor = new THREE.Color(th.fog);
const baseFogNear = th.fogNear ?? 300, baseFogFar = th.fogFar ?? 1600;
const baseSunIntensity = th.sunI, baseHemiIntensity = th.hemi;
const wetFogColor = new THREE.Color(th.night ? 0x24233b : 0x7c8794);

/* Rain particle system */
const RAIN_COUNT = 1200;
const rainGeo = new THREE.BufferGeometry();
const rainPos = new Float32Array(RAIN_COUNT * 3);
for (let i = 0; i < RAIN_COUNT; i++) {
  rainPos[i * 3] = (Math.random() - 0.5) * 160;
  rainPos[i * 3 + 1] = Math.random() * 70;
  rainPos[i * 3 + 2] = (Math.random() - 0.5) * 160;
}
rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
const rainMat = new THREE.PointsMaterial({
  color: 0x8aaed4, size: 0.50, transparent: true, opacity: 0,
  depthWrite: false, blending: THREE.AdditiveBlending
});
const rain = new THREE.Points(rainGeo, rainMat);
rain.frustumCulled = false;
scene.add(rain);

/* Spray particle system behind the player car */
const SPRAY_COUNT = 100;
const sprayGeo = new THREE.BufferGeometry();
const sprayPos = new Float32Array(SPRAY_COUNT * 3);
for (let i = 0; i < SPRAY_COUNT; i++) {
  sprayPos[i * 3] = (Math.random() - 0.5) * 5;
  sprayPos[i * 3 + 1] = Math.random() * 1.8;
  sprayPos[i * 3 + 2] = (Math.random() - 0.5) * 2 - 1;
}
sprayGeo.setAttribute('position', new THREE.BufferAttribute(sprayPos, 3));
const sprayMat = new THREE.PointsMaterial({
  color: 0xbec8d8, size: 0.35, transparent: true, opacity: 0,
  depthWrite: false, blending: THREE.AdditiveBlending
});
const spray = new THREE.Points(sprayGeo, sprayMat);
spray.frustumCulled = false;
scene.add(spray);

/* ============================ 赛道 ============================ */
const TRACK_HALF = circuit.halfWidth;
const TRACK_LEN = circuit.length;
const SAMPLES = circuit.N;
const trackSamples = circuit.samples.map((sample, i) =>
  new THREE.Vector3(sample.p.x, circuit.heights[i], sample.p.z));
// 与原版等距采样使用同一中心线；旧比赛/AI 逻辑继续调用 getPointAt/getTangentAt。
const trackCurve = {
  getLength: () => TRACK_LEN,
  getPointAt(t) {
    const f = (((t % 1) + 1) % 1) * SAMPLES, i = Math.floor(f), q = f - i;
    return trackSamples[i].clone().lerp(trackSamples[(i + 1) % SAMPLES], q);
  },
  getTangentAt(t) {
    const f = (((t % 1) + 1) % 1) * SAMPLES, i = Math.floor(f), q = f - i;
    return circuit.samples[i].t.clone().lerp(circuit.samples[(i + 1) % SAMPLES].t, q).normalize();
  }
};
const aiCurve = trackSamples.map((_, i) => {
  const a = trackSamples[(i - 4 + SAMPLES) % SAMPLES], b = trackSamples[i], c = trackSamples[(i + 4) % SAMPLES];
  return window.APEX_AI.curvature(a, b, c);
});

function closestTrack(x, z, hint) {
  let best = Infinity, result = { t: 0, dist: Infinity, offset: 0, px: 0, pz: 0, nx: 0, nz: 0 };
  for (let i = 0; i < SAMPLES; i++) {
    const a = trackSamples[i], b = trackSamples[(i + 1) % SAMPLES];
    const dx = b.x - a.x, dz = b.z - a.z;
    const length2 = dx * dx + dz * dz;
    const u = length2 > 0 ? Math.max(0, Math.min(1, ((x-a.x)*dx + (z-a.z)*dz) / length2)) : 0;
    const px = a.x + u*dx, pz = a.z + u*dz;
    const d2 = (x-px)*(x-px) + (z-pz)*(z-pz);
    const t = ((i + u) / SAMPLES) % 1;
    const delta = hint == null ? 0 : Math.abs(((t - hint + 1.5) % 1) - 0.5);
    // Prefer a continuous local segment at crossings, but allow recovery far away.
    const score = d2 + (delta > 0.08 ? 400 : 0);
    const segLen = Math.sqrt(length2) || 1;
    const nx = dz / segLen, nz = -dx / segLen;
    // Signed lateral offset: positive on the left of travel, matching ribbon().
    const offset = ((x-px)*nx + (z-pz)*nz);
    if (score < best) { best = score; result = { t, dist: Math.sqrt(d2), offset, px, pz, nx, nz }; }
  }
  return result;
}

/* PIT 车库楼、维修区墙和围场来自原版 buildCircuit。
 * 原版不暴露可驾驶 PIT 道路，此处仅补齐从原版车库位置推导的道路与停站框。 */
const pitBuilding = circuit.group.getObjectByName('pit-building');
const pitCenter = pitBuilding ? circuit.nearestSample(pitBuilding.position) : 0;
const pitSide = pitBuilding ? (circuit.lateralAt(pitBuilding.position, pitCenter) < 0 ? -1 : 1) : 1;
const pitEntryT = (((pitCenter * circuit.ds - 115) / TRACK_LEN) % 1 + 1) % 1;
const pitSpan = 230 / TRACK_LEN;
const PIT_BOUNDS = {
  start: pitEntryT, end: (pitEntryT + pitSpan) % 1,
  inner: circuit.wallOff + 1.6, outer: circuit.wallOff + 8.2,
  boxT: pitCenter / SAMPLES, boxOffset: circuit.wallOff + 5.2,
  boxHalfT: 6 / TRACK_LEN, boxHalfOffset: 2.6,
  boxRadius: 6, limit: 16.7, service: 3, penalty: 5,
};
const pitProgress = t => ((t - pitEntryT + 1) % 1);
const inPitRange = t => pitProgress(t) <= pitSpan;
const pitEntryRamp = 32/TRACK_LEN;
const isPitLanePosition = (t, lateral) => inPitRange(t) &&
  window.APEX_PIT.inLane(pitProgress(t), lateral * pitSide,
    { ...PIT_BOUNDS, start: 0, end: pitSpan,
      inner: TRACK_HALF+0.3+(PIT_BOUNDS.inner-TRACK_HALF-0.3)*Math.min(1,pitProgress(t)/pitEntryRamp,(pitSpan-pitProgress(t))/pitEntryRamp) });
const nearPitBox = (t, lateral) => window.APEX_PIT.nearBox(t, lateral * pitSide, PIT_BOUNDS);

if (pitBuilding) {
  // 原版围栏连续封闭；仅在 PIT 两端开口，车库楼/维修墙保持原样。
  circuit.group.updateMatrixWorld(true);
  const atAccess = point => {
    const i = circuit.nearestSample(point);
    if (circuit.lateralAt(point,i) * pitSide < TRACK_HALF) return false;
    const u = pitProgress(i/SAMPLES);
    return u < pitEntryRamp + 8/TRACK_LEN ||
      (u > pitSpan-pitEntryRamp-8/TRACK_LEN && u < pitSpan+8/TRACK_LEN);
  };
  const point = new THREE.Vector3(), matrix = new THREE.Matrix4();
  for (const name of ['wall-armco','wall-tyre','hoardings','catch-fence']) {
    const mesh = circuit.group.getObjectByName(name);
    if (!mesh?.geometry?.index) continue;
    const geometry = mesh.geometry, positions = geometry.attributes.position, index = geometry.index;
    const kept = [];
    for (let k=0;k<index.count;k+=3) {
      const a=index.getX(k),b=index.getX(k+1),c=index.getX(k+2);
      point.set((positions.getX(a)+positions.getX(b)+positions.getX(c))/3,
        (positions.getY(a)+positions.getY(b)+positions.getY(c))/3,
        (positions.getZ(a)+positions.getZ(b)+positions.getZ(c))/3).applyMatrix4(mesh.matrixWorld);
      if (!atAccess(point)) kept.push(a,b,c);
    }
    geometry.setIndex(kept);
  }
  const posts=circuit.group.getObjectByName('barrier-posts');
  if(posts?.isInstancedMesh) {
    for(let i=0;i<posts.count;i++) {
      posts.getMatrixAt(i,matrix);point.setFromMatrixPosition(matrix).applyMatrix4(posts.matrixWorld);
      if(atAccess(point)){matrix.scale(new THREE.Vector3(0,0,0));posts.setMatrixAt(i,matrix);}
    }
    posts.instanceMatrix.needsUpdate=true;
  }
  const sideN = (i) => circuit.samples[((i % SAMPLES) + SAMPLES) % SAMPLES].n;
  const points = [], indices = [];
  const steps = Math.ceil(230 / circuit.ds);
  for (let k=0; k<=steps; k++) {
    const t = (pitEntryT + pitSpan * k / steps) % 1;
    const i = Math.round(t * SAMPLES) % SAMPLES;
    const p = trackCurve.getPointAt(t), n = sideN(i);
    // 保留原版车库楼与 PIT 墙；只在其朝向赛道一侧填充道路。
    const ramp = Math.min(1,k/Math.max(1,Math.round(32/circuit.ds)),
      (steps-k)/Math.max(1,Math.round(32/circuit.ds)));
    const width = [TRACK_HALF+0.3+(PIT_BOUNDS.inner-TRACK_HALF-0.3)*ramp,
      TRACK_HALF+2.5+(PIT_BOUNDS.outer-TRACK_HALF-2.5)*ramp];
    for (const offset of width) points.push(p.x+n.x*pitSide*offset, p.y+0.055, p.z+n.z*pitSide*offset);
    if (k) { const a=k*2; indices.push(a-2,a-1,a,a-1,a+1,a); }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(points,3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  const lane = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({color:0x3b3d43,roughness:.92,side:THREE.DoubleSide}));
  lane.name='apex-pit-drivable-lane'; lane.receiveShadow=true; scene.add(lane);
  const p=trackCurve.getPointAt(PIT_BOUNDS.boxT), n=sideN(pitCenter), heading=trackCurve.getTangentAt(PIT_BOUNDS.boxT);
  const box = new THREE.Mesh(new THREE.PlaneGeometry(4.6,8.2),
    new THREE.MeshBasicMaterial({color:0xeae9e4,side:THREE.DoubleSide}));
  box.rotation.order='YXZ';
  box.rotation.x=-Math.PI/2; box.rotation.z=0;
  box.rotation.y=Math.atan2(heading.x,heading.z);
  box.position.set(p.x+n.x*pitSide*PIT_BOUNDS.boxOffset,p.y+.07,p.z+n.z*pitSide*PIT_BOUNDS.boxOffset);
  box.name='apex-pit-service-box';scene.add(box);
}

/* 原版程序化赛车模型：车身、前后翼、HALO、开放轮胎与车队涂装。 */
function createCar(team, driver) {
  const handle=buildCarMesh(team,driver);
  const g=handle.group;
  g.userData.apexHandle=handle;
  g.userData.frontWheels=[handle.wheels.fl,handle.wheels.fr];
  return g;
}

/* ============================ 玩家状态 ============================ */
const startPt = trackCurve.getPointAt(0);
const startTan = trackCurve.getTangentAt(0);

const pitState = window.APEX_PIT.createState();
let pitChoice = null;
let pitWasInLane = false;
let penaltyTime = 0;
let pitNotice = '';
let pitNoticeTimer = 0;

const car = {
  pos: new THREE.Vector3(startPt.x, 0, startPt.z),
  angle: Math.atan2(startTan.x, startTan.z),
  speed: 0,
};

const carMesh = createCar(TEAMS[0], DRIVERS.find(d=>d.team===TEAMS[0].id));
carMesh.position.set(car.pos.x, startPt.y+0.055, car.pos.z);
carMesh.rotation.y = car.angle;
scene.add(carMesh);

/* 相机初始位置 */
camera.position.set(startPt.x - startTan.x * 10.5, 4.8, startPt.z - startTan.z * 10.5);
camera.lookAt(startPt.x, 1.4, startPt.z);

/* ============================ AI 对手 ============================ */
const aiList = [];
function ensureAI(count) {
  while(aiList.length>count){const a=aiList.pop();scene.remove(a.mesh);}
  while(aiList.length<count){
    const i=aiList.length,team=TEAMS[(i+1)%TEAMS.length],driver=DRIVERS.find(d=>d.team===team.id),mesh=createCar(team,driver);
    scene.add(mesh);aiList.push({mesh,t:0,speed:0,lane:0,baseLane:0,aiProfile:window.APEX_AI.profile('medium')});
  }
}
ensureAI(3);

/* ============================ 输入 ============================ */
const keys = { up: false, down: false, left: false, right: false, boost: false };
const keyMap = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  Space: 'boost',
};

let started = false;
let racePhase = 'grid';
let countdown = 0;
let mode = 'race';
let totalLaps = 5;
let qStage = 0;
let qTime = 0;
let qualifying = null;
let gridOrder = null;
let qualClock = 0;
let qualPlan = [];
let qualPlayerDone = false;
let raceFinished = false;
const centerEl = document.getElementById('center');
const hudLap = document.getElementById('lap');
const hudTime = document.getElementById('time');
const hudBest = document.getElementById('best');
const hudSpeed = document.getElementById('speed');
const hudPosition = document.getElementById('position');
const hudTyre = document.getElementById('tyreHud');
const hudErs = document.getElementById('ersHud');
const hudWeather = document.getElementById('weatherHud');
const hudGrip = document.getElementById('gripHud');
const hudGear = document.getElementById('gear');
const hudPit = document.getElementById('pitHud');
const menuEl = document.getElementById('menu');
const startBtn = document.getElementById('startBtn');
const modeSelect = document.getElementById('modeSelect');
const lengthSelect = document.getElementById('lengthSelect');
const difficultySelect = document.getElementById('difficultySelect');
const resultModal = document.getElementById('resultModal');
const resultText = document.getElementById('resultText');
const restartBtn = document.getElementById('restartBtn');
const pitModal = document.getElementById('pitModal');
const pitConfirm = document.getElementById('pitConfirm');
let pitRequested = false;
let pitLimiter = false;
let tyre = 'M';
let tyreWear = 0;
let ers = 1;
let weatherState = window.APEX_WEATHER.createState();
let weatherClock = 0;
let weather = 0; // wetness copy for backward compat
let gripFactor = 1;
let aquaRisk = 0;
let tyreTemp = 70;

function beginSession() {
  mode = modeSelect.value;
  qualifying = null; gridOrder = null;
  document.getElementById('qualPanel').hidden = mode !== 'qualifying';
  const length = lengthSelect.value;
  totalLaps = window.APEX_RACE.raceLaps(selectedTrack, length);
  started = false;
  raceFinished = false;
  racePhase = mode === 'qualifying' ? 'qualifying' : 'countdown';
  countdown = mode === 'qualifying' ? 0 : 5;
  qStage = mode === 'qualifying' ? 1 : 0;
  qTime = mode === 'qualifying' ? 480 : 0;
  if(mode==='qualifying') beginQualifying(); else resetCar();
  menuEl.style.display = 'none';
  centerEl.classList.remove('hide');
  centerEl.innerHTML = mode === 'qualifying' ? '<b>Q1 · 8:00</b>Push lap / 飞驰圈' : '<b>5</b>准备发车 / Get ready';
}

startBtn.addEventListener('click', beginSession);
restartBtn.addEventListener('click', () => location.reload());
trackSelect.addEventListener('change', () => {
  // Track geometry is initialized once per page in this first stable milestone.
  // Reloading guarantees all dependent meshes, AI and lap state are rebuilt together.
  const url = new URL(location.href);
  url.searchParams.set('track', trackSelect.value);
  location.href = url.href;
});
pitConfirm.addEventListener('click', () => {
  pitChoice = document.querySelector('input[name="tyre"]:checked')?.value || 'M';
  pitRequested = true;
  pitModal.hidden = true;
  pitNotice = `已选择 ${pitChoice}：驶入维修区停稳 / ${pitChoice} selected - stop in the box`;
  pitNoticeTimer = 4;
  centerEl.classList.remove('hide');
  centerEl.innerHTML = '<b>进站请求 / Pit request</b>驶入维修区并在停车位停稳 / Enter the pit lane and stop at the box';
});

addEventListener('keydown', e => {
  const k = keyMap[e.code];
  if (k) {
    keys[k] = true;
    e.preventDefault();
    if (racePhase === 'grid' && menuEl.style.display !== 'none') return;
    if (racePhase === 'countdown') return;
    if(mode==='qualifying' && (qualPlayerDone||racePhase==='qualResults')){keys[k]=false;return;}
    if (racePhase === 'qualifying') { started = true; centerEl.classList.add('hide'); }
  }
  if (e.code === 'KeyR' && !e.repeat && racePhase !== 'grid') {
    if(mode==='qualifying'){beginQualifying();} else resetCar();
  }
  if (e.code === 'KeyP' && started && mode==='race' && !pitState.inLane) {
    pitRequested = true;
    pitNotice = '进站请求 / PIT REQUEST';
    pitNoticeTimer = 3;
    centerEl.classList.remove('hide');
    centerEl.innerHTML = '<b>进站请求 / Pit request</b>驶入维修区，进入后选择轮胎 / Enter pit lane, then choose tyres';
    renderHUD();
  }
  if (e.code === 'KeyL' && started && !e.repeat) pitLimiter = !pitLimiter;
});
addEventListener('blur', () => {
  Object.keys(keys).forEach(k => { keys[k] = false; });
});
addEventListener('keyup', e => {
  const k = keyMap[e.code];
  if (k) { keys[k] = false; e.preventDefault(); }
});

/* ============================ 比赛数据 ============================ */
let lapTime = 0;
const bestLapKey = `apex-best-${selectedTrack.id}`;
function readBestLap() {
  try {
    const value = Number(localStorage.getItem(bestLapKey));
    return Number.isFinite(value) && value > 0 ? value : Infinity;
  } catch (_) { return Infinity; }
}
function saveBestLap(value) {
  try { localStorage.setItem(bestLapKey, value.toFixed(2)); } catch (_) {
    // Storage is optional: private/file:// restrictions must never stop a race.
  }
}
let bestLap = readBestLap();
let lapCount = 1;
let prevT = 0;
let halfPassed = false;

let playerRacer = window.APEX_RACE.createRacer('player', '玩家 / You', 0);
let sessionSerial = 0;
function placeAI(ai) {
  const p = trackCurve.getPointAt(ai.t);
  const tan = trackCurve.getTangentAt(ai.t);
  const normal = new THREE.Vector3(tan.z, 0, -tan.x).normalize();
  ai.mesh.position.set(p.x + normal.x * ai.lane, p.y + 0.055, p.z + normal.z * ai.lane);
  ai.mesh.rotation.y = Math.atan2(tan.x, tan.z);
}
function resetCar() {
  ensureAI(gridOrder ? gridOrder.length-1 : mode==='qualifying' ? 21 : 3);
  sessionSerial++;
  car.pos.set(startPt.x, 0, startPt.z);
  car.angle = Math.atan2(startTan.x, startTan.z);
  car.speed = 0;
  carMesh.position.set(car.pos.x, startPt.y+0.055, car.pos.z);
  carMesh.rotation.y = car.angle;
  [carMesh.userData.apexHandle.wheels.fl,carMesh.userData.apexHandle.wheels.fr].forEach(w => { w.rotation.y = 0; });
  setTyreCompound(carMesh.userData.apexHandle, 'M');
  raceFinished = false;
  started = mode === 'qualifying';
  racePhase = mode === 'qualifying' ? 'qualifying' : 'countdown';
  countdown = mode === 'qualifying' ? 0 : 5;
  resultModal.hidden = true;
  pitModal.hidden = true;
  pitRequested = false;
  pitLimiter = false;
  pitChoice = null;
  pitWasInLane = false;
  penaltyTime = 0;
  pitNotice = '';
  pitNoticeTimer = 0;
  Object.assign(pitState, window.APEX_PIT.createState());
  Object.assign(weatherState, window.APEX_WEATHER.createState());
  weatherClock = 0; weather = 0; tyreTemp = 70; gripFactor = 1; aquaRisk = 0;
  tyre = 'M'; tyreWear = 0; ers = 1;
  const defaultTyre = document.querySelector('input[name="tyre"][value="M"]');
  if (defaultTyre) defaultTyre.checked = true;
  Object.keys(keys).forEach(k => { keys[k] = false; });
  lapTime = 0; lapCount = 1; prevT = 0; halfPassed = false;
  const playerGrid=gridOrder ? gridOrder.indexOf('player') : 0;
  const playerOffset=-playerGrid*6/TRACK_LEN;
  playerRacer=window.APEX_RACE.createRacer('player','玩家 / You',playerGrid,playerOffset);
  const spawn=trackCurve.getPointAt((playerOffset+1)%1), heading=trackCurve.getTangentAt((playerOffset+1)%1);
  car.pos.set(spawn.x,0,spawn.z);car.angle=Math.atan2(heading.x,heading.z);
  carMesh.position.set(car.pos.x,spawn.y+0.055,car.pos.z);carMesh.rotation.y=car.angle;
  aiList.forEach((ai, i) => {
    // Negative progress puts AI behind the start line, without a free lap/head start.
    const gridIndex=gridOrder ? gridOrder.indexOf(`ai-${i}`) : i+1;
    const offset=-gridIndex*6/TRACK_LEN;
    ai.racer = window.APEX_RACE.createRacer(`ai-${i}`, `AI ${i + 1}`, gridIndex, offset);
    ai.t = (offset + 1) % 1;
    ai.prevT = ai.t;
    ai.progress = offset;
    ai.completedLaps = 0;
    ai.finished = false;
    ai.finishTime = Infinity;
    ai.finishPosition = 0;
    ai.speed = 0;
    ai.targetSpeed = 0;
    ai.baseLane = ((i % 3) - 1) * 2.8;
    ai.lane = ai.baseLane;
    ai.aiProfile = window.APEX_AI.profile(document.getElementById('difficultySelect').value);
    ai.pitted = false;
    ai.pitActive = false;
    ai.pitStopping = false;
    ai.pitDone = false;
    ai.pitTimer = 0;
    ai.tyreWear = 0;
    placeAI(ai);
  });
  camera.position.set(car.pos.x-heading.x*10.5,4.8,car.pos.z-heading.z*10.5);
  camera.fov = 62;
  camera.updateProjectionMatrix();
  camera.position.set(car.pos.x-heading.x*10.5,4.8,car.pos.z-heading.z*10.5);
  camera.lookAt(car.pos.x,1.4,car.pos.z);
  centerEl.classList.remove('hide');
  centerEl.innerHTML = mode === 'qualifying' ? `<b>Q${qStage}</b>飞驰圈 / Push lap` : '<b>5</b>准备发车 / Get ready';
  renderHUD();
}

function allRacers() { return [playerRacer].concat(aiList.map(ai => ai.racer).filter(Boolean)); }
function applyFinishPenalty(racer, penalty) {
  if (!(penalty > 0) || !racer || !racer.finished || !Number.isFinite(racer.finishTime)) return penalty;
  racer.finishTime += penalty;
  racer.elapsed += penalty;
  return 0;
}
function renderHUD() {
  const ranked = window.APEX_RACE.rankRacers(allRacers());
  const position = Math.max(1, ranked.findIndex(r => r.id === 'player') + 1);
  const qualRank=mode==='qualifying'&&qualifying?window.APEX_QUAL.standings(qualifying).findIndex(r=>r.id==='player'):-1;
  hudPosition.textContent=mode==='qualifying'&&qualifying?(qualRank<0?'OUT / 已淘汰':`${qualRank+1}/${qualifying.activeIds.length}`):`${position}/${ranked.length}`;
  document.getElementById('totalTime').textContent = (playerRacer.elapsed + (mode==='race'?penaltyTime:0)).toFixed(2);
  const ahead = ranked[position - 2];
  const effective = window.APEX_RACE.raceProgress;
  document.getElementById('gapHud').textContent = ahead ? `${Math.max(0, (effective(ahead) - effective(playerRacer)) * TRACK_LEN).toFixed(0)} m` : '--';
  hudSpeed.textContent = Math.round(Math.abs(car.speed) * 3.6);
  hudGear.textContent = Math.max(1, Math.min(8, Math.floor(Math.abs(car.speed) / 9) + 1));
  hudTyre.textContent = `${tyre} ${Math.round(tyreWear * 100)}% · ${Math.round(tyreTemp)}°C`;
  hudErs.textContent = `${Math.round(ers * 100)}%${keys.boost ? ' BOOST' : ''}`;
  const weatherPhase=weather>.7?'WET':weather>.25?'DAMP':selectedTrack.night?'NIGHT':'DRY';
  const aquaText=aquaRisk>.25?' · AQUA':'';
  hudWeather.textContent = `${weatherPhase} ${Math.round(weather*100)}%${aquaText}`;
  hudGrip.textContent = `${gripFactor.toFixed(2)}${aquaRisk > .25 ? ' · AQUA' : ''}`;
  if (mode === 'qualifying') hudPit.textContent = '--';
  else if (pitNoticeTimer > 0) hudPit.textContent = pitNotice;
  else if (pitState.servicing) hudPit.textContent = `换胎中 ${(PIT_BOUNDS.service - pitState.serviceProgress).toFixed(1)}s`;
  else if (pitState.inLane) hudPit.textContent = `维修区 ${Math.round(Math.abs(car.speed) * 3.6)} km/h`;
  else if (pitRequested) hudPit.textContent = pitChoice ? `已选 ${pitChoice} / PIT` : '进站请求 / REQUEST';
  else hudPit.textContent = '--';
  if (penaltyTime > 0) hudPit.textContent += ` · +${penaltyTime.toFixed(0)}s 罚时`;
  hudLap.textContent = mode === 'qualifying' ? `Q${qStage}` : `${Math.min(lapCount, totalLaps)}/${totalLaps}`;
  hudTime.textContent = mode === 'qualifying' ? `${Math.ceil(qTime)}s` : lapTime.toFixed(2);
  const sessionBest=mode==='qualifying'&&qualifying?qualifying.drivers.player.best:null;
  hudBest.textContent=mode==='qualifying'?(sessionBest==null?'--.--':sessionBest.toFixed(3)):(bestLap===Infinity?'--.--':bestLap.toFixed(2));
  if (raceFinished) {
    const rank = ranked.findIndex(r => r.id === 'player') + 1;
    const total = (playerRacer.finishTime == null ? lapTime : playerRacer.finishTime) + (mode==='race'?penaltyTime:0);
    resultText.textContent = `P${rank} · ${selectedTrack.zh} / ${selectedTrack.en} · ${total.toFixed(2)}s`;
    const classification = document.getElementById('classification');
    classification.replaceChildren();
    ranked.forEach((r, i) => {
      const row = document.createElement('div');
      const best = r.lapTimes.length ? Math.min(...r.lapTimes).toFixed(2) + 's' : '--';
      const finish = r.id === 'player' ? r.finishTime + penaltyTime : r.finishTime;
      row.textContent = `P${i + 1} · ${r.name} · ${r.finished ? finish.toFixed(2) + 's' : '比赛中 / Running'} · ${Math.min(r.completedLaps, totalLaps)}/${totalLaps} · Best ${best}`;
      classification.appendChild(row);
    });
  }
}
function applyWeatherVisuals() {
  var w = Math.min(1, Math.max(0, weather));
  rain.material.opacity = w * 0.45;
  var active = weatherState.rain > 0.02;
  rain.visible = active;
  if (active) {
    // Move rain cloud with the camera.
    rain.position.set(camera.position.x, camera.position.y - 4.2, camera.position.z);
    var rp = rain.geometry.attributes.position.array;
    for (var i = 0; i < RAIN_COUNT; i++) {
      rp[i * 3 + 1] -= (35 + w * 30) * 0.05;
      if (rp[i * 3 + 1] < 0) rp[i * 3 + 1] += 70;
    }
    rain.geometry.attributes.position.needsUpdate = true;
  }
  // Spray behind the player car when racing and moving.
  if (mode === 'race' && started && Math.abs(car.speed) > 15 && w > 0.35) {
    spray.position.set(
      car.pos.x - Math.sin(car.angle) * 3,
      carMesh.position.y + 0.8,
      car.pos.z - Math.cos(car.angle) * 3
    );
    spray.rotation.y = car.angle;
    spray.material.opacity = w * 0.55 * Math.min(1, Math.abs(car.speed) / 50);
    spray.visible = true;
  } else {
    spray.material.opacity = 0;
    spray.visible = false;
  }
  // Track and ground colour.
  var f = Math.min(1, w * 0.85);
  // Fog.
  scene.fog.color.lerpColors(baseFogColor, wetFogColor, f);
  scene.fog.near = baseFogNear - f * 80;
  scene.fog.far  = baseFogFar  - f * 200;
  // Lights.
  sun.intensity = baseSunIntensity * (1 - w * 0.55);
  hemi.intensity = baseHemiIntensity * (1 - w * 0.30);
}
function updateAI(dt, collide) {
  const steps=Math.max(1,Math.ceil(dt*120));
  for(let n=0;n<steps;n++) stepAI(dt/steps,collide);
}
function stepAI(dt, collide) {
  if (!['race', 'finish'].includes(racePhase)) { aiList.forEach(placeAI); return; }
  // Snapshot avoids update-order bias: every driver sees the same traffic frame.
  const traffic = aiList.filter(a => !a.racer.finished).map(a => ({t:a.t,lane:a.lane,speed:a.speed,id:a}));
  if (collide && !playerRacer.finished) traffic.push({t:playerRacer.lastT,lane:0,speed:Math.max(0,car.speed),id:null});
  for (const ai of aiList) {
    if (!ai.racer.finished) {
      const p = ai.aiProfile;
      const index = Math.floor(ai.t * SAMPLES) % SAMPLES;
      const toPitEntry = ((PIT_BOUNDS.start - ai.t + 1) % 1) * TRACK_LEN;
      if (!ai.pitted && window.APEX_PIT.aiShouldPit(ai.racer.completedLaps, totalLaps, ai.pitted)
          && toPitEntry > 0 && toPitEntry < 40) {
        ai.pitted = true;
        ai.pitActive = true;
        ai.pitStopping = false;
        ai.pitDone = false;
        ai.pitTimer = 0;
        ai.defaultLane = ai.baseLane;
      }
      let gap=Infinity, leadSpeed=p.max;
      if (ai.pitActive && pitProgress(ai.t) > pitSpan && pitProgress(ai.t) < 0.5) {
        // Leave the pit phase only at the start of a frame, after the previous
        // frame's lane position has already been rendered. The next lane blend
        // starts from the racing surface immediately.
        ai.pitActive = false;
        ai.baseLane = ai.defaultLane == null ? 0 : ai.defaultLane;
      }
      if (ai.pitActive) {
        const u = pitProgress(ai.t);
        const ramp = u <= pitSpan ? Math.max(0, Math.min(1, u/pitEntryRamp, (pitSpan-u)/pitEntryRamp)) : 0;
        const lane = ai.defaultLane ?? 0;
        ai.baseLane = lane + (PIT_BOUNDS.boxOffset * pitSide - lane) * ramp;
        ai.targetSpeed = ai.pitStopping ? 0 : PIT_BOUNDS.limit;
      } else {
        ai.targetSpeed = window.APEX_AI.targetSpeed(aiCurve,index,TRACK_LEN/SAMPLES,ai.speed,p) * window.APEX_WEATHER.pace(weather);
        for(const other of traffic){
          if(other.id===ai || Math.abs(other.lane-ai.lane)>2.3)continue;
          const distance=((other.t-ai.t+1)%1)*TRACK_LEN;
          if(distance>0 && distance<gap){gap=distance;leadSpeed=other.speed;}
        }
        if(gap<18 && leadSpeed<ai.speed+2){
          for(const lane of [-2.8,2.8,0]){
            if(Math.abs(lane-ai.lane)<1)continue;
            const blocked=traffic.some(o=>o.id!==ai && Math.abs(o.lane-lane)<2.3 && Math.abs((((o.t-ai.t+1.5)%1)-.5)*TRACK_LEN)<12);
            if(!blocked){ai.baseLane=lane;break;}
          }
        }
      }
      const blendRate = ai.pitActive ? dt * 14 : dt * 2;
      ai.lane += Math.max(-blendRate, Math.min(blendRate, ai.baseLane - ai.lane));
      if (!ai.pitActive) {
        ai.lane = Math.max(-TRACK_HALF + 2, Math.min(TRACK_HALF - 2, ai.lane));
      }
      if (ai.pitStopping) {
        ai.speed = 0;
        const stopped = window.APEX_RACE.advance(ai.racer, ai.t, true, dt, 0.2, totalLaps);
        ai.pitTimer += dt;
        if (ai.pitTimer >= PIT_BOUNDS.service) {
          ai.pitDone = true;
          ai.pitStopping = false;
          ai.pitTimer = 0;
          ai.tyreWear = 0;
        }
        ai.progress = ai.racer.progress; ai.completedLaps = ai.racer.completedLaps;
        ai.finished = ai.racer.finished;
        if (stopped.finished) { ai.finishTime = ai.racer.finishTime; ai.speed = 0; }
      } else {
        ai.speed = window.APEX_AI.traffic(ai.speed,ai.targetSpeed,gap,leadSpeed,dt,p);
        // Safe hard gap constraint prevents passing through a stopped same-lane car.
        const distance = Math.min(ai.speed*dt,Math.max(0,gap-4.6));
        const nextT = (ai.t + distance / TRACK_LEN) % 1;
        const event = window.APEX_RACE.advance(ai.racer,nextT,true,dt,
          Math.max(0.006,p.max*dt/TRACK_LEN*3),totalLaps);
        ai.t=nextT; ai.progress=ai.racer.progress; ai.completedLaps=ai.racer.completedLaps;
        ai.finished=ai.racer.finished;
        if(event.finished){ai.finishTime=ai.racer.finishTime;ai.speed=0;
          ai.pitActive=false;ai.baseLane=ai.defaultLane==null?0:ai.defaultLane;ai.lane=ai.baseLane;}
        if (ai.pitActive) {
          const toBox = ((PIT_BOUNDS.boxT - ai.t + 1) % 1) * TRACK_LEN;
          if (!ai.pitDone && toBox > 0 && toBox <= 3) {
            ai.pitStopping = true;
            ai.pitTimer = 0;
          }
        }
      }
      ai.tyreWear = window.APEX_WEATHER.wearStep(ai.tyreWear, Math.abs(ai.speed), weather, 'M', 90, dt);
    }
    placeAI(ai);
    if(collide && !ai.finished && !ai.pitActive){
      let dx=car.pos.x-ai.mesh.position.x,dz=car.pos.z-ai.mesh.position.z;
      const d=Math.hypot(dx,dz);
      if(d<2.5){
        if(d<.0001){const tangent=trackCurve.getTangentAt(ai.t);dx=-tangent.z;dz=tangent.x;}
        const norm=Math.max(Math.hypot(dx,dz),.0001), correction=Math.min(.35,2.5-d);
        car.pos.x+=dx/norm*correction;car.pos.z+=dz/norm*correction;
        // Both cars lose relative closing speed; never inject collision energy.
        const shared=Math.min(Math.max(0,car.speed),ai.speed);
        car.speed+=(shared-car.speed)*Math.min(1,8*dt);
        ai.speed+=(shared-ai.speed)*Math.min(1,8*dt);
      }
    }
  }
}

/* ============================ 主循环 ============================ */
const clock = new THREE.Clock();

function update(dt) {
  if(pitNoticeTimer>0)pitNoticeTimer=Math.max(0,pitNoticeTimer-dt);
  if(mode==='qualifying'&&qualifying&&racePhase==='qualifying'){
    const boundary=qualifying.phase==='running'?qualifying.remaining:qualifying.graceSeconds-qualifying.closingElapsed;
    if(boundary>1e-8&&dt>boundary+1e-8){update(boundary);update(dt-boundary);return;}
  }
  if (racePhase === 'countdown') {
    countdown -= dt;
    centerEl.classList.remove('hide');
    centerEl.innerHTML = countdown > 0 ? `<b>${Math.ceil(countdown)}</b>红灯倒计时 / Lights` : '<b>GO!</b>全油门 / Full throttle';
    if (countdown <= 0) { racePhase = 'race'; started = true; centerEl.classList.add('hide'); }
    renderHUD();
    return;
  }
  if(mode==='qualifying') {
    if(racePhase==='qualResults'){renderHUD();return;}
    if(qualPlayerDone){tickQualifying(dt);renderHUD();return;}
  }
  if (racePhase === 'grid') { renderHUD(); return; }
  if (racePhase === 'finish') { updateAI(dt, false); renderHUD(); return; }
  // Deterministic weather progresses with race time, scaled by the expected
  // race duration so every lap length sees a complete shower cycle.
  if (mode === 'race' && started && racePhase === 'race') {
    const estimatedLap = Math.max(35, TRACK_LEN / 50);
    weatherClock += dt;
    const fraction = totalLaps > 0 ? weatherClock / (totalLaps * estimatedLap) : 0;
    window.APEX_WEATHER.update(weatherState, fraction);
    weather = weatherState.wetness;
  }
  const throttle = keys.up ? 1 : 0;
  const braking  = keys.down ? 1 : 0;
  if (keys.boost && ers > 0) ers = Math.max(0, ers - dt * 0.18);
  else if (!throttle) ers = Math.min(1, ers + dt * 0.035);
  if (pitLimiter) car.speed = Math.min(car.speed, 13.9);
  const steerIn  = (keys.left ? 1 : 0) - (keys.right ? 1 : 0);

  let info = closestTrack(car.pos.x, car.pos.z, playerRacer.lastT);
  let inPitLane = mode === 'race' && isPitLanePosition(info.t, info.offset);
  const speedOnPitEntry = Math.abs(car.speed);
  const prePitOffset = info.offset;
  let onGrass = !inPitLane && info.dist > TRACK_HALF + 0.4;

  /* ---- 纵向动力（M6 天气与轮胎模型） ---- */
  const lineWet = window.APEX_WEATHER.lineWetness(weather, Math.abs(info.offset) < TRACK_HALF * 0.45);
  gripFactor = window.APEX_WEATHER.grip(tyre, lineWet, tyreTemp, tyreWear);
  aquaRisk = window.APEX_WEATHER.aquaplaning(weather, tyre, Math.abs(car.speed), tyreWear);
  const surfaceMax = inPitLane ? PIT_BOUNDS.limit : onGrass ? 26 : 74;
  const speedCap = aquaRisk > 0.25 ? surfaceMax * (1 - aquaRisk * 0.3) : surfaceMax;
  const MAX_SPEED = speedCap * gripFactor * (pitLimiter ? 0.19 : 1);
  const ACCEL     = (onGrass ? 15 : 36) * gripFactor * (keys.boost && ers > 0 ? 1.22 : 1);
  // Tyre temperature and wear step
  tyreTemp = window.APEX_WEATHER.tempStep(tyreTemp, Math.abs(car.speed), weather, tyre, dt, braking > 0);
  tyreWear = window.APEX_WEATHER.wearStep(tyreWear, Math.abs(car.speed), weather, tyre, tyreTemp, dt);

  if (throttle) {
    car.speed = Math.min(MAX_SPEED, car.speed + ACCEL * dt);
  } else if (braking) {
    if (car.speed > 0.4) car.speed = Math.max(0, car.speed - 78 * dt);
    else car.speed = Math.max(-22, car.speed - 24 * dt);
  } else {
    const drag = 15 * dt * (onGrass ? 2.6 : 1);
    if (car.speed > drag) car.speed -= drag;
    else if (car.speed < -drag) car.speed += drag;
    else car.speed = 0;
  }

  /* 冲出赛道后迅速损失速度 */
  if (onGrass && Math.abs(car.speed) > MAX_SPEED) {
    const excess = Math.abs(car.speed) - MAX_SPEED;
    car.speed = Math.sign(car.speed) * (MAX_SPEED + excess * Math.pow(0.12, dt));
  }
  // Low-grip surfaces and aquaplaning bleed off excess momentum even without
  // throttle input; otherwise a wet track would only limit acceleration.
  if (!onGrass && !inPitLane && Math.abs(car.speed) > MAX_SPEED) {
    const excess = Math.abs(car.speed) - MAX_SPEED;
    car.speed = Math.sign(car.speed) * (MAX_SPEED + excess * Math.pow(0.35, dt));
  }
  // Pit-lane limiter is automatic: it caps momentum as well as throttle.
  if (inPitLane && Math.abs(car.speed) > PIT_BOUNDS.limit) {
    car.speed = Math.sign(car.speed) * PIT_BOUNDS.limit;
  }

  /* ---- 转向 ---- */
  const sr = Math.min(Math.abs(car.speed) / 74, 1);
  const turnRate = 2.7 * (1 - 0.42 * sr) * (1 - aquaRisk * 0.35);
  if (Math.abs(car.speed) > 0.5) {
    car.angle += steerIn * turnRate * dt * Math.sign(car.speed);
  }

  /* ---- 位移 ---- */
  const fx = Math.sin(car.angle);
  const fz = Math.cos(car.angle);
  car.pos.x += fx * car.speed * dt;
  car.pos.z += fz * car.speed * dt;

  updateAI(dt, true);
  // Re-sample after movement and collision correction.
  info = closestTrack(car.pos.x, car.pos.z, playerRacer.lastT);
  // The pit wall is solid between the entry and exit openings. Keep the car
  // on the side it approached from instead of allowing a wall cut.
  const wallOffset = circuit.wallOff + 1.2, wallHalf = 0.3;
  if (mode === 'race' && inPitRange(info.t) && pitProgress(info.t) > pitEntryRamp && pitProgress(info.t) < pitSpan - pitEntryRamp) {
    const approachedFromPit = prePitOffset * pitSide >= wallOffset;
    const limit = pitSide * (wallOffset + (approachedFromPit ? wallHalf : -wallHalf));
    const crossed = approachedFromPit ? info.offset * pitSide < wallOffset + wallHalf : info.offset * pitSide > wallOffset - wallHalf;
    if (crossed) {
      car.pos.x = info.px + info.nx * limit;
      car.pos.z = info.pz + info.nz * limit;
      info = closestTrack(car.pos.x, car.pos.z, playerRacer.lastT);
    }
  }
  inPitLane = mode === 'race' && isPitLanePosition(info.t, info.offset);
  onGrass = !inPitLane && info.dist > TRACK_HALF + 0.4;

  /* ---- 维修区：限速、停车位、换胎与处罚 ---- */
  if (inPitLane && !pitWasInLane) {
    pitRequested = true;
    pitNotice = '进入维修区 / PIT LANE';
    pitNoticeTimer = 3;
    if (pitChoice == null) pitModal.hidden = false;
  }
  const atPitBox = nearPitBox(info.t, info.offset);
  if (atPitBox && Math.abs(car.speed) < 1 && pitChoice == null) pitModal.hidden = false;
  const pitEvent = window.APEX_PIT.update(pitState, {
    inLane: inPitLane,
    speed: Math.max(Math.abs(car.speed), inPitLane ? speedOnPitEntry : 0),
    boxDistance: atPitBox ? 0 : 99,
    requested: pitRequested,
    hasTyreChoice: pitChoice != null,
  }, dt, PIT_BOUNDS);
  pitWasInLane = inPitLane;
  if (pitEvent.penaltyAdded) {
    penaltyTime += PIT_BOUNDS.penalty;
    pitNotice = `维修区超速 +${PIT_BOUNDS.penalty}s / Pit speeding`;
    pitNoticeTimer = 5;
    centerEl.classList.remove('hide');
    centerEl.innerHTML = '<b>维修区超速 / Pit speeding</b>+5 秒罚时 / +5s penalty';
  }
  if (pitEvent.serviceStarted) {
    pitNotice = '停站换胎 / Service';
    pitNoticeTimer = 3;
  }
  if (pitEvent.tyreChanged) {
    tyre = pitChoice;
    setTyreCompound(carMesh.userData.apexHandle, tyre);
    tyreWear = 0;
    tyreTemp = 70;
    pitChoice = null;
    pitRequested = false;
    pitModal.hidden = true;
    pitNotice = `换胎完成：${tyre} / Tyres fitted`;
    pitNoticeTimer = 4;
    centerEl.classList.remove('hide');
    centerEl.innerHTML = `<b>换胎完成 / Pit stop complete</b>${tyre} tyres fitted · ${PIT_BOUNDS.service.toFixed(0)}s`;
    const serial = sessionSerial;
    setTimeout(() => { if (serial === sessionSerial && started) centerEl.classList.add('hide'); }, 1400);
  }
  if (pitEvent.serviceCancelled) {
    pitNotice = '停站取消：必须停稳在停车位 / Service cancelled';
    pitNoticeTimer = 4;
  }
  if (pitEvent.leave && pitRequested) {
    pitRequested = false;
    pitChoice = null;
    pitNotice = '未完成换胎离开维修区 / Left without service';
    pitNoticeTimer = 4;
  }

  /* ---- Validated progress; ordered checkpoints prevent start-line farming. ---- */
  const previousQualT=playerRacer.lastT;
  const event = window.APEX_RACE.advance(playerRacer, info.t,
    inPitLane || info.dist <= TRACK_HALF + 1.8, dt, Math.max(0.006, Math.abs(car.speed) * dt / TRACK_LEN * 3),
    mode === 'race' ? totalLaps : Infinity);
  lapTime = playerRacer.lapElapsed;
  lapCount = playerRacer.completedLaps + 1;
  if(mode==='qualifying') {
    const fraction=event.delta>0?Math.max(0,Math.min(1,(1-previousQualT)/event.delta)):1;
    handleQualifyingLap(event,previousQualT,info.t,qualClock+dt*fraction);
    tickQualifying(dt);
  }
  if (event.lapCompleted) {
    bestLap = Math.min(bestLap, playerRacer.lapTimes[playerRacer.lapTimes.length - 1]);
    if (Number.isFinite(bestLap)) saveBestLap(bestLap);
  }
  if (event.finished) {
    // Penalties are part of the official race time, so apply them to the
    // frozen finish time before ranking/result rendering.
    if (penaltyTime > 0) {
      penaltyTime = applyFinishPenalty(playerRacer, penaltyTime);
    }
    raceFinished = true; racePhase = 'finish'; started = false; car.speed = 0;
    resultModal.hidden = false;
    centerEl.classList.remove('hide');
    centerEl.innerHTML = '<b>🏁 CHEQUERED FLAG</b>比赛完成 / Race finished';
  }

  /* ---- 更新玩家车辆外观 ---- */
  carMesh.position.set(car.pos.x, trackCurve.getPointAt(info.t).y + 0.055, car.pos.z);
  carMesh.rotation.y = car.angle;
  const steerVis = steerIn * 0.42;
  [carMesh.userData.apexHandle.wheels.fl,carMesh.userData.apexHandle.wheels.fr].forEach(w => { w.rotation.y = steerVis; });
  for (const wheel of Object.values(carMesh.userData.apexHandle.wheels)) wheel.rotation.x += car.speed*dt/carMesh.userData.apexHandle.wheelRadius;

  /* ---- 相机跟随 ---- */
  const camBack = 10.5;
  const k = 1 - Math.pow(0.0001, dt);
  camera.position.x += (car.pos.x - fx * camBack - camera.position.x) * k;
  camera.position.z += (car.pos.z - fz * camBack - camera.position.z) * k;
  camera.position.y += (carMesh.position.y + 4.2 - camera.position.y) * k;
  camera.lookAt(car.pos.x + fx * 6, carMesh.position.y + 1.0, car.pos.z + fz * 6);

  const targetFov = 62 + Math.abs(car.speed) * 0.18;
  camera.fov += (targetFov - camera.fov) * k;
  camera.updateProjectionMatrix();

  renderHUD();
}

/* M4 page integration. Source snippet inserted into car.html by integrate-m4-ui.py. */
function qualifyingEntries(){
  return [{id:'player',name:'玩家 / You',seed:0}].concat(Array.from({length:21},(_,i)=>({id:`ai-${i}`,name:`AI ${String(i+1).padStart(2,'0')}`,seed:i+1})));
}
let qualPlayerStart=0, qualPlayerInvalid=false;
let qualRenderKey='',qualRenderTime=-Infinity;
function beginQualifying(durations){
  gridOrder=null;mode='qualifying';
  qualifying=window.APEX_QUAL.createSession(qualifyingEntries(),durations||[480,360,300]);
  prepareQualStage();
}
function prepareQualStage(){
  qStage=qualifying.stage;qTime=qualifying.remaining;qualClock=0;qualPlayerDone=false;
  resetCar();racePhase='qualifying';
  const eligible=qualifying.activeIds.includes('player');
  qualPlayerDone=!eligible;started=eligible;
  qualPlayerStart=0;qualPlayerInvalid=false;
  if(eligible)window.APEX_QUAL.startLap(qualifying,'player');
  // Deterministic simulated AI qualifying laps use the same curvature envelope
  // and difficulty as race AI. No imported or fabricated real-world times.
  const p=window.APEX_AI.profile(difficultySelect.value),spacing=TRACK_LEN/SAMPLES;
  const base=aiCurve.reduce((sum,k)=>sum+spacing/Math.max(1,window.APEX_AI.speedLimit(k,p)),0);
  qualPlan=qualifying.activeIds.filter(id=>id!=='player').map(id=>{
    const index=Number(id.split('-')[1]);
    const lap=base*(.985+index*.0065+(3-qStage)*.003);
    window.APEX_QUAL.startLap(qualifying,id);
    return {id,lap,start:0,attempt:0};
  });
  document.getElementById('qualPanel').hidden=false;
  document.getElementById('qualContinue').hidden=true;
  document.getElementById('qualSkip').hidden=false;
  centerEl.innerHTML=eligible?`<b>Q${qStage}</b>完成有效圈 / Set a valid lap`:'<b>已淘汰 / Eliminated</b>可观察后续排位';
  renderQualifying();
}
function renderQualifying(){
  if(!qualifying)return;
  const key=`${sessionSerial}:${qualifying.stage}:${qualifying.phase}`;
  if(key===qualRenderKey&&qualClock>=qualRenderTime&&qualClock-qualRenderTime<.2)return;
  qualRenderKey=key;qualRenderTime=qualClock;
  const finished=qualifying.phase==='finished';
  const final=finished&&qualifying.stage===3;
  document.getElementById('qualTitle').textContent=final?'正赛发车顺序 / Starting grid':`Q${qualifying.stage} · 排位成绩 / Qualifying`;
  document.getElementById('qualStatus').textContent=finished?'本节结束 / Session finished':qualifying.phase==='closing'?'方格旗：只允许完成已开始的圈 / Finish existing laps':`${Math.ceil(qualifying.remaining)}s · AI 为确定性模拟成绩`;
  const target=document.getElementById('qualRows');target.replaceChildren();
  const rows=final?window.APEX_QUAL.grid(qualifying):window.APEX_QUAL.standings(qualifying);
  rows.forEach((r,i)=>{
    const node=document.createElement('div'),cut=qStage===1?16:qStage===2?10:10;
    node.textContent=`${r.position||i+1}. ${r.name} · ${r.time==null?'无成绩 / No time':r.time.toFixed(3)+'s'}${!final&&finished&&i>=cut?' · OUT':''}`;
    if(r.id==='player')node.style.color='#7fe0ff';target.appendChild(node);
  });
  const button=document.getElementById('qualContinue');button.hidden=!finished;
  button.textContent=final?'进入正赛 / Start Race':`进入 Q${qualifying.stage+1} / Next session`;
  document.getElementById('qualSkip').hidden=finished;
}
function tickQualifying(dt){
  if(!qualifying||qualifying.phase==='finished')return;
  // Complete AI attempts chronologically before closing the clock; a lap may
  // start only strictly before expiry. Player crossing is handled by physics.
  const end=qualClock+dt;
  const deadline=qualClock+(qualifying.phase==='running'?qualifying.remaining+qualifying.graceSeconds:qualifying.graceSeconds-qualifying.closingElapsed);
  for(const plan of qualPlan){
    let loops=0;
    while(plan.start+plan.lap<=Math.min(end,deadline) && loops++<100){
      window.APEX_QUAL.completeLap(qualifying,plan.id,plan.lap,true);
      const crossing=plan.start+plan.lap;
      if(crossing<qualClock+qualifying.remaining && qualifying.phase==='running'){
        window.APEX_QUAL.startLap(qualifying,plan.id);
        plan.start=crossing;plan.attempt++;
      }else{plan.start=Infinity;break;}
    }
  }
  qualClock=end;window.APEX_QUAL.tick(qualifying,dt);qTime=qualifying.remaining;
  if(qualifying.phase==='closing' && window.APEX_QUAL.finishStage(qualifying)){
    racePhase='qualResults';started=false;car.speed=0;qualPlayerDone=true;
    Object.keys(keys).forEach(k=>{keys[k]=false;});
  }
  renderQualifying();
}
function handleQualifyingLap(event,previousT,currentT,crossingClock=qualClock){
  if(!qualifying||qualPlayerDone)return;
  if(!event.accepted||event.delta<0)qualPlayerInvalid=true;
  const crossed=event.delta>0&&previousT>.8&&currentT<.2;
  if(crossed){
    window.APEX_QUAL.completeLap(qualifying,'player',crossingClock-qualPlayerStart,!qualPlayerInvalid && event.lapCompleted);
    qualPlayerStart=crossingClock;qualPlayerInvalid=false;
    const beforeExpiry=qualifying.phase==='running' && crossingClock<qualClock+qualifying.remaining-1e-9;
    if(!beforeExpiry || !window.APEX_QUAL.startLap(qualifying,'player')){qualPlayerDone=true;started=false;car.speed=0;}
    renderQualifying();
  }
}
function continueQualifying(){
  if(!qualifying||qualifying.phase!=='finished')return;
  if(qualifying.stage<3){window.APEX_QUAL.nextStage(qualifying);prepareQualStage();return;}
  gridOrder=window.APEX_QUAL.grid(qualifying).map(r=>r.id);
  mode='race';totalLaps=window.APEX_RACE.raceLaps(selectedTrack,lengthSelect.value);
  document.getElementById('qualPanel').hidden=true;resetCar();
}
document.getElementById('qualContinue').addEventListener('click',continueQualifying);
document.getElementById('qualSkip').addEventListener('click',()=>{
  if(qualifying&&qualifying.phase==='running'){
    window.APEX_QUAL.tick(qualifying,qualifying.remaining);qTime=0;renderQualifying();
  }
});


/* 原仓库 hud.js _drawMinimap 同款路径、S/F、PIT 和赛车点位。 */
const minimapCanvas = document.getElementById('minimap');
const minimapCtx = minimapCanvas.getContext('2d');
const mapBounds = circuit.samples.reduce((b,s) => ({
  minX:Math.min(b.minX,s.p.x), maxX:Math.max(b.maxX,s.p.x),
  minZ:Math.min(b.minZ,s.p.z), maxZ:Math.max(b.maxZ,s.p.z)
}),{minX:Infinity,maxX:-Infinity,minZ:Infinity,maxZ:-Infinity});
const mapScale = Math.min((minimapCanvas.width-28)/(mapBounds.maxX-mapBounds.minX),
  (minimapCanvas.height-28)/(mapBounds.maxZ-mapBounds.minZ));
const mapOX = (minimapCanvas.width-(mapBounds.maxX-mapBounds.minX)*mapScale)/2-mapBounds.minX*mapScale;
const mapOZ = (minimapCanvas.height-(mapBounds.maxZ-mapBounds.minZ)*mapScale)/2-mapBounds.minZ*mapScale;
const mapPath = new Path2D();
circuit.samples.forEach((s,i) => {
  const x=s.p.x*mapScale+mapOX, y=s.p.z*mapScale+mapOZ;
  if(i===0)mapPath.moveTo(x,y);else mapPath.lineTo(x,y);
});
mapPath.closePath();
function drawMinimap(){
  const ctx=minimapCtx;
  ctx.clearRect(0,0,minimapCanvas.width,minimapCanvas.height);
  ctx.strokeStyle='rgba(255,255,255,0.85)';ctx.lineWidth=3;ctx.lineJoin='round';ctx.stroke(mapPath);
  const s0=circuit.samples[0].p;
  ctx.fillStyle='#e10600';ctx.fillRect(s0.x*mapScale+mapOX-2.5,s0.z*mapScale+mapOZ-2.5,5,5);
  const p=circuit.samples[pitCenter].p, px=p.x*mapScale+mapOX, py=p.z*mapScale+mapOZ;
  ctx.beginPath();ctx.arc(px,py,4.6,0,7);ctx.fillStyle='rgba(10,10,14,0.9)';ctx.fill();
  ctx.lineWidth=1.2;ctx.strokeStyle='rgba(255,225,74,0.95)';ctx.stroke();
  ctx.fillStyle='rgba(255,225,74,0.95)';ctx.fillRect(px-.7,py-2.6,1.4,5.2);ctx.fillRect(px-.7,py-2.6,3.2,2.4);
  for (const ai of aiList){
    if(!ai.mesh.visible)continue;
    const x=ai.mesh.position.x*mapScale+mapOX,y=ai.mesh.position.z*mapScale+mapOZ;
    ctx.beginPath();ctx.arc(x,y,3,0,7);
    ctx.fillStyle='#'+ai.mesh.userData.apexHandle.team.color.toString(16).padStart(6,'0');ctx.fill();
  }
  const x=car.pos.x*mapScale+mapOX,y=car.pos.z*mapScale+mapOZ;
  ctx.beginPath();ctx.arc(x,y,4.4,0,7);
  ctx.fillStyle='#'+carMesh.userData.apexHandle.team.color.toString(16).padStart(6,'0');ctx.fill();
  ctx.lineWidth=1.6;ctx.strokeStyle='#fff';ctx.stroke();
  ctx.save();ctx.translate(x,y);ctx.rotate(-car.angle);ctx.beginPath();
  ctx.moveTo(0,10.6);ctx.lineTo(-3.4,5.8);ctx.lineTo(3.4,5.8);ctx.closePath();ctx.fillStyle='#fff';ctx.fill();ctx.restore();
}

resetCar();
racePhase = 'grid';
started = false;
centerEl.innerHTML = '<b>🏁 3D 赛车</b>点击开始比赛 / Start Race';
renderHUD();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  update(dt);
  circuit.trackState.setConditions({ wetness:weather, rainfall:weatherState.rain*18, locked:true });
  if (started) circuit.advanceEnvironment(dt, [{sampleIdx:Math.floor(playerRacer.lastT*SAMPLES),speed:car.speed}]);
  applyWeatherVisuals();
  sun.target.position.set(car.pos.x, 0, car.pos.z);
  sun.position.copy(sun.target.position).addScaledVector(sunDirection,420);
  sky.position.set(car.pos.x,0,car.pos.z);
  drawMinimap();
  renderer.render(scene, camera);
}
animate();

/* ============================ 自适应 ============================ */
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
if (new URLSearchParams(location.search).get('selftest') === '1') {
  const smokeScript = document.createElement('script');
  smokeScript.src = './tests/game-smoke.js';
  document.body.appendChild(smokeScript);
}
