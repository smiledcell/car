'use strict';
// Validate static deployment inputs without claiming real browser coverage.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
for (const relative of ['index.html', 'car.html', 'js/apex-runtime.js',
  'js/apex-runtime.js.LEGAL.txt', 'js/car-game.js',
  'third-party/apex-formula-2026/assets/f1car-2026.glb',
  'third-party/apex-formula-2026/LICENSE',
  'third-party/apex-formula-2026/NOTICE',
  'third-party/apex-formula-2026/THIRD_PARTY_NOTICES.md',
  'third-party/apex-formula-2026/LICENSES/three.js-MIT.txt']) {
  assert(fs.statSync(path.join(dist, relative)).size > 0, `Empty release file: ${relative}`);
}
const index = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
assert.equal(index, fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
const redirect = index.match(/<script>([\s\S]*?)<\/script>/);
assert(redirect, 'Homepage redirect script missing');
for (const base of ['https://example.github.io/team-game/',
  'https://example.github.io/team-game/index.html', 'file:///D:/game/index.html']) {
  const current = new URL(base + '?track=japan&selftest=1#test');
  let target;
  vm.runInNewContext(redirect[1], { URL, window: { location: {
    href: current.href, search: current.search, hash: current.hash,
    replace: value => { target = value; },
  } } });
  assert.equal(target, new URL('./car.html?track=japan&selftest=1#test', current).href);
}
const car = fs.readFileSync(path.join(dist, 'car.html'), 'utf8');
assert.equal(car, fs.readFileSync(path.join(root, 'car.html'), 'utf8'));
const scripts = [...car.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)].map(m => m[1]);
assert(scripts.length > 0, 'No local game scripts found');
for (const src of scripts) {
  assert(src.startsWith('./'), `Expected project-relative script: ${src}`);
  assert(fs.statSync(path.join(dist, src)).size > 0, `Missing script: ${src}`);
}
console.log(`PASS release: homepage redirects (project root, explicit index, file URL, query/hash), source copies, ${scripts.length} script links, model and license files.`);
console.log('Not covered: HTTP responses, real browser startup, WebGL rendering, keyboard input or gameplay.');
