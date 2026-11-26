/* Direct-open/HTTP release builder: node scripts/build.cjs.
 * Copy the prebuilt classic runtime, embedded model and supporting files with
 * their relative paths and license notices intact; never rewrite sources or
 * rerun esbuild here. Rebuild js/apex-runtime.js separately after source changes.
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const files = [
  'index.html', 'car.html',
  'js/tracks.js', 'js/race-core.js', 'js/ai-core.js',
  'js/qualifying-core.js', 'js/pit-core.js', 'js/weather-core.js',
  'js/car-game.js', 'js/apex-entry.js', 'js/apex-runtime.js', 'js/apex-runtime.js.LEGAL.txt', 'tests/game-smoke.js',
  'third-party/apex-formula-2026/js', 'third-party/apex-formula-2026/lib', 'third-party/apex-formula-2026/assets',
  'third-party/apex-formula-2026/LICENSE', 'third-party/apex-formula-2026/NOTICE',
  'third-party/apex-formula-2026/THIRD_PARTY_NOTICES.md', 'third-party/apex-formula-2026/LICENSES',
];
// Validate the complete manifest before writing any release files.
for (const relative of files) {
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`Missing release input: ${relative}`);
}
for (const relative of files) {
  const destination = path.join(output, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(path.join(root, relative), destination, { recursive: true });
}
console.log('Built dist/car.html with the prebuilt classic APEX runtime, embedded GLB, local helpers and license notices.');
console.log('Open dist/car.html directly (file://) or serve dist over HTTP; keep the complete directory intact, not just the HTML.');
