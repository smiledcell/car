// Dependency-free checks: node scripts/test.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
let count = 0;
function check(ok, message) { if (!ok) throw new Error(message); count++; }
const nodes = new Map();
const node = id => nodes.get(id) || (nodes.set(id, { textContent: '', className: '' }), nodes.get(id));
const context = vm.createContext({ console, document: { getElementById: node } });
context.window = context;
for (const name of ['js/tracks.js', 'js/race-core.js', 'js/ai-core.js', 'js/qualifying-core.js', 'js/pit-core.js', 'js/weather-core.js']) {
  new vm.Script(read(name), { filename: name });
  count++;
}
vm.runInContext(read('js/tracks.js'), context);
vm.runInContext(read('js/race-core.js'), context);
vm.runInContext(read('js/ai-core.js'), context);
vm.runInContext(read('js/pit-core.js'), context);
vm.runInContext(read('js/weather-core.js'), context);
const ai=context.APEX_AI,p=ai.profile('medium');
check(ai.speedLimit(.08,p)<ai.speedLimit(.001,p),'Curve speed not reduced');
check(ai.profile('easy').max<p.max && p.max<ai.profile('hard').max,'Difficulty order');
check(ai.curvature({x:0,z:0},{x:1,z:0},{x:1,z:1})>0,'Curve estimate');
check(ai.targetSpeed([0,0,.1,.1],0,5,60,p)<p.max,'No braking lookahead');
check(ai.traffic(50,60,5,10,.1,p)<50,'No following brake');
check(ai.approach(20,60,.1,p)<=20+p.accel*.1,'Acceleration limit');
check(context.APEX_TRACKS.TRACKS.length === 24, 'Expected 24 tracks');
check(new Set(context.APEX_TRACKS.TRACKS.map(t => t.id)).size === 24, 'Duplicate track ids');
for (const track of context.APEX_TRACKS.TRACKS) {
  check(context.APEX_TRACKS.controlPoints(track).every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)), 'Invalid points: ' + track.id);
}
const html = read('car.html');
const game = read('js/car-game.js');
const entry = read('js/apex-entry.js');
const runtime = read('js/apex-runtime.js');
check(!/<script\b[^>]*type=["'](?:importmap|module)["']/i.test(html), 'Direct-open page must use classic scripts, not import maps/modules');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-module-check-'));
try {
  // Only syntax-check this bundler input as ESM. Its .glb import is binary data
  // for esbuild's base64 loader, not another JavaScript module to traverse.
  const probe = path.join(temporary, 'entry.mjs');
  fs.writeFileSync(probe, entry);
  execFileSync(process.execPath, ['--check', probe], { stdio: 'inherit' });
  count++;
  for (const match of entry.matchAll(/\bimport\s+(?:[^;'"\n]*?\s+from\s*)?["']([^"']+)["']/g)) {
    const specifier = match[1];
    const filename = path.resolve(root, 'js', specifier);
    check(specifier.startsWith('.') && filename.startsWith(root + path.sep) && fs.existsSync(filename) && fs.statSync(filename).isFile(), `Missing local bundler input: ${specifier}`);
  }
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1];
    if (src) {
      check(src.startsWith('./'), 'Page script must be local: ' + src);
      new vm.Script(read(src), { filename: src });
    } else {
      new vm.Script(match[2], { filename: 'car.html:inline' });
    }
    count++;
  }
} finally {
  // Only remove the exact newly-created OS temporary directory, never sources.
  if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('apex-module-check-')) {
    throw new Error('Unexpected module-check temporary path');
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}
for (const name of ['js/car-game.js', 'tests/game-smoke.js', 'scripts/build.cjs']) {
  new vm.Script(read(name), { filename: name }); count++;
}
check(!html.includes('window.APEX_TRACKS ='), 'Duplicate embedded track source');
vm.runInContext(read('js/weather-core.js'), context);
for (const name of ['js/tracks.js', 'js/race-core.js', 'js/ai-core.js', 'js/qualifying-core.js', 'js/pit-core.js', 'js/weather-core.js', 'js/apex-runtime.js']) {
  check(html.includes(`src="./${name}"`), 'Missing script: ' + name);
}
for (const name of ['tracks.js', 'trackBuilder.js', 'car.js', 'data-fictional.js', 'textures.js']) {
  check(entry.includes(`../third-party/apex-formula-2026/js/${name}`), 'Missing APEX source module: ' + name);
}
check(entry.includes('window.THREE =') && entry.includes('window.APEX_VISUALS =') && entry.includes('window.APEX_READY = new Promise'), 'Source entry must expose Three.js, visuals and readiness');
check(runtime.includes('window.THREE =') && runtime.includes('window.APEX_VISUALS =') && runtime.includes('window.APEX_READY = new Promise'), 'Classic runtime must expose bundled visuals and readiness');
check(html.indexOf('src="./js/apex-runtime.js"') < html.indexOf('window.APEX_READY.then') && html.indexOf('window.APEX_READY.then') < html.indexOf("script.src = './js/car-game.js'"), 'Game must load after classic runtime readiness');
check(game.includes('window.APEX_VISUALS') && game.includes('buildCircuit(') && game.includes('buildCarMesh('), 'Game must use original APEX circuit and car builders');
const modelPath = 'third-party/apex-formula-2026/assets/f1car-2026.glb';
check(entry.includes(`../${modelPath}`) && entry.includes('atob(model)') && entry.includes('new GLTFLoader().parse(bytes.buffer'), 'Source entry must parse embedded GLB bytes');
const model = fs.readFileSync(path.join(root, modelPath));
check(model.toString('ascii', 0, 4) === 'glTF' && model.readUInt32LE(4) === 2 && model.readUInt32LE(8) === model.length, 'Invalid source GLB');
check(runtime.includes(model.toString('base64')), 'Classic runtime must embed the source GLB without a model fetch');
check(!/\bfetch\s*\(|\bnew\s+GLTFLoader\(\)\.load\s*\(/.test(entry), 'Entry must not fetch a model at startup');
check(html.includes('id="minimap"') && game.includes('drawMinimap()'), 'Missing integrated minimap');
check(game.includes("smokeScript.src = './tests/game-smoke.js'"), 'Missing opt-in game smoke loader');
const tests = read('tests/race-core.test.html');
for (const match of tests.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!/\bsrc\s*=/.test(match[1])) vm.runInContext(match[2], context);
}
const results = context.APEX_TEST_RESULTS;
console.log(results.results.join('\n'));
check(results.passed === results.total, 'Core tests failed');
console.log(`PASS: ${count} static/data checks; ${results.passed}/${results.total} core tests.`);
require(path.join(root,'tests/qualifying.test.cjs'));
require(path.join(root,'tests/pit.test.cjs'));
require(path.join(root,'tests/weather.test.cjs'));
console.log('Not covered: actual file:// or HTTP browser startup, real WebGL/GLB rendering, keyboard events, rendered appearance.');
