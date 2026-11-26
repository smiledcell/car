// Runtime visual effects: lit tyre smoke, dust and roost, skid-block sparks,
// brake embers, exhaust flame, spray, mist, rain, lens droplets, tyre marks.
// Procedural, pooled and instanced: one batch per layer, nothing allocated
// while running. Pool records hold the state; instance buffers are rebuilt
// from them before each render, so an outside edit is what the next frame draws.
import * as THREE from 'three';

export const EFFECT_POOL_LIMITS = Object.freeze({
  sparks: 260, smoke: 96, dust: 48, debris: 180, rain: 320, spray: 80, skidSegments: 700,
  mist: 28, rainField: 1400, lens: 26,
});

export const EFFECT_QUALITY_SCALES = Object.freeze({ low: 0.45, medium: 0.72, high: 1 });

export const EFFECT_QUALITY_DUST_LIMITS = Object.freeze({ low: 18, medium: 32, high: 48 });

export const EFFECT_QUALITY_WEATHER_LIMITS = Object.freeze({
  low: Object.freeze({ rain: 72, spray: 20, mist: 6, rainField: 260, lens: 0 }),
  medium: Object.freeze({ rain: 168, spray: 44, mist: 14, rainField: 700, lens: 12 }),
  high: Object.freeze({ rain: 320, spray: 80, mist: 28, rainField: 1400, lens: 26 }),
});

const L = EFFECT_POOL_LIMITS;
const SKID_SEGS = L.skidSegments;
// Wheel centres in car space (x physics lateral, z forward): FL, FR, RL, RR.
const WX = [-0.82, 0.82, -0.85, 0.85];
const WZ = [1.55, 1.55, -1.6, -1.6];
const RAIN_BOX = [34, 15, 46];
const PARK = -50;
const SPARK = 0, EMBER = 1, FLAME = 2, ROOST = 3, RUBBER = 4, DROP = 5;

const { min, max, abs, hypot, sin, cos } = Math;
function clamp01(n) { return max(0, min(1, n)); }

// Road height under a car, `ahead` metres further along.
export function effectSurfaceHeight(physics, ahead = 0) {
  const fallback = Number.isFinite(physics?.pos?.y) ? physics.pos.y : 0;
  const circuit = physics?.circuit;
  const sample = circuit?.samples?.[physics?.sampleIdx];
  if (!sample || typeof circuit?.heightAt !== 'function' || !Number.isFinite(circuit?.ds) || circuit.ds <= 0) {
    return fallback;
  }
  const along = (physics.pos.x - sample.p.x) * sample.t.x +
    (physics.pos.z - sample.p.z) * sample.t.z;
  const height = circuit.heightAt(physics.sampleIdx + (along + ahead) / circuit.ds);
  return Number.isFinite(height) ? height : fallback;
}

function defaultMotionScale(options) {
  if (Number.isFinite(options.motionScale)) return clamp01(options.motionScale);
  const reduced = options.reducedMotion ??
    (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (reduced) return 0.28;
  const memory = typeof navigator !== 'undefined' ? Number(navigator.deviceMemory) : 0;
  const compact = typeof matchMedia === 'function' && matchMedia('(max-width: 700px)').matches;
  // Match the adaptive renderer's conservative initial-tier heuristics without
  // coupling Effects to main.js or the quality controller.
  return compact || (Number.isFinite(memory) && memory > 0 && memory <= 4) ? 0.62 : 1;
}

// Tileable RGBA value noise: shapes and lights every soft particle.
let noiseBytes = null;
function noiseTexture() {
  const S = 64;
  if (!noiseBytes) {
    noiseBytes = new Uint8Array(S * S * 4);
    const hash = (x, y, c) => {
      const v = sin(x * 127.1 + y * 311.7 + c * 74.7) * 43758.5453;
      return v - Math.floor(v);
    };
    for (let i = 0; i < noiseBytes.length; i++) {
      const c = i & 3, x = (i >> 2) % S, y = i >> 8;
      let v = 0;
      // four octaves of lattice noise, each wrapping at the tile edge
      for (let p = 4, amp = 0.5; p <= 32; p *= 2, amp *= 0.5) {
        const fx = x / S * p, fy = y / S * p, x0 = fx | 0, y0 = fy | 0, x1 = (x0 + 1) % p, y1 = (y0 + 1) % p;
        const tx = fx - x0, ty = fy - y0, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const a = hash(x0, y0, c + p), b = hash(x1, y0, c + p), d = hash(x0, y1, c + p);
        v += amp * (a + (b - a) * sx + (d - a) * sy + (a - b - d + hash(x1, y1, c + p)) * sx * sy);
      }
      noiseBytes[i] = v / 0.9375 * 255;
    }
  }
  const t = new THREE.DataTexture(noiseBytes, S, S);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

const OUTPUT = '\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n';
const FOG = 'uniform vec3 fogColor;uniform float fogNear,fogFar;';

// Soft lit billboard. aP = centre, radius; aC = albedo, opacity;
// aM = noise rotation, seed + age, aspect, floor height.
const PUFF_VS = `
attribute vec4 aP,aC,aM;
uniform vec3 uSunW;
varying vec2 vP,vUv;
varying vec4 vC,vS;
varying vec3 vL,vK;
void main(){
vec4 mv=viewMatrix*vec4(aP.xyz,1.);
float sd=floor(aM.y)/61.,c=cos(aM.x),s=sin(aM.x),far=-mv.z;
mat2 turn=mat2(c,s,-s,c)*(.26+sd*.14);
vP=position.xy;
vUv=turn*vP+sd*9.7;
vL=normalize(mat3(viewMatrix)*uSunW);
vS=vec4(vL.xy*.2,turn*vL.xy*.2);
vC=aC;
vC.a*=smoothstep(.3,1.2+aP.w,far);
vK=vec3(fract(aM.y),(aP.y+vP.y*aP.w*aM.z-aM.w)/.3,far);
mv.xy+=vP*aP.w*vec2(1.,aM.z);
gl_Position=vC.a>.004?projectionMatrix*mv:vec4(0.,0.,2.,1.);
}`;
// Density: noise cut by radius and age, a ragged clump eroding into wisps,
// lit where it thins out towards the sun.
const PUFF_FS = `
uniform sampler2D uN;
uniform vec3 uSun,uAmb;
${FOG}
varying vec2 vP,vUv;
varying vec4 vC,vS;
varying vec3 vL,vK;
void main(){
vec4 n=texture2D(uN,vUv);
float d=texture2D(uN,vUv*3.1+n.gb*.3).g*.55-.38-vK.x*.5;
vec2 q=vP+vS.xy;
float rho=n.r*1.25+d-dot(vP,vP)*1.3;
float sunward=texture2D(uN,vUv+vS.zw).r*1.25+d-dot(q,q)*1.3;
float a=smoothstep(0.,.4,rho)*clamp(vK.y,0.,1.)*vC.a;
float lit=clamp(.5+vL.z*.3+(rho-sunward)*1.7,0.,1.);
vec3 col=vC.rgb*(uAmb*(.85+.3*lit)+uSun*(lit*1.3+pow(max(-vL.z,0.),3.)*(1.-a)*.5));
col=mix(col,fogColor,smoothstep(fogNear,fogFar,vK.z));
gl_FragColor=vec4(col,a);${OUTPUT}
gl_FragColor.rgb*=a;
}`;

// Velocity-stretched streak: position = head, aV = velocity, half width,
// aC = premultiplied colour (alpha 0 adds). FIELD: the rain volume, static
// seeds wrapped round the camera on the GPU.
const STREAK_VS = `
attribute vec2 corner;
uniform float uH;
varying vec2 vQ;
varying vec4 vC;
varying float vZ;
#ifdef FIELD
uniform vec3 uBox,uOff,uSV;
uniform vec4 uCol;
#else
attribute vec4 aV,aC;
uniform vec3 uCamV;
#endif
void main(){
#ifdef FIELD
vec3 ctr=cameraPosition-normalize(vec3(viewMatrix[0][2],1e-4,viewMatrix[2][2]))*uBox.z*.36;
ctr.y+=uBox.y*.3;
vec3 h=mod(position*uBox+uOff-ctr,uBox)-uBox*.5+ctr;
vec3 e=abs(h-ctr)/uBox*2.,sv=uSV;
vec4 col=uCol*(.45+position.y)*(1.-smoothstep(.55,1.,max(e.x,e.z)));
float w=0.;
#else
vec3 h=position,sv=(uCamV-aV.xyz)*.02;
vec4 col=aC;
float w=aV.w;
#endif
vec4 a=viewMatrix*vec4(h,1.),d=viewMatrix*vec4(sv,0.);
if(d.z>0.)d*=clamp((-a.z-.25)/d.z,0.,1.);
vec4 b=a+d;
vec2 dir=b.xy/max(-b.z,.05)-a.xy/max(-a.z,.05);
float l=length(dir);
dir=l>1e-6?dir/l:vec2(0.,1.);
vec4 p=mix(a,b,corner.y);
float ww=max(w,-p.z*1.5/(projectionMatrix[1][1]*uH));
#ifdef FIELD
w=ww*=.7+position.z*.6;
#endif
p.xy+=(vec2(dir.y,-dir.x)*corner.x+dir*(corner.y*2.-1.))*ww;
vQ=corner;
vC=col*(w/ww)*smoothstep(.3,1.6,-a.z);
vZ=-p.z;
gl_Position=w>0.&&a.z<-.3?projectionMatrix*p:vec4(0.,0.,2.,1.);
}`;
const STREAK_FS = `
uniform vec3 uLit;
${FOG}
varying vec2 vQ;
varying vec4 vC;
varying float vZ;
void main(){
float m=max(1.-vQ.x*vQ.x,0.)*smoothstep(0.,.08,vQ.y)*pow(max(1.-vQ.y,0.),1.5);
vec4 c=vec4(vC.rgb*(vC.a>0.?uLit:vec3(1.)),vC.a)*m;
c.rgb=mix(c.rgb,fogColor*c.a,smoothstep(fogNear,fogFar,vZ));
gl_FragColor=c;${OUTPUT}
}`;

// Water on the lens: screen-space beads refracting a copy of the frame so
// far. aL = NDC centre, radius, opacity; aS = travel direction, stretch.
const LENS_VS = `
attribute vec4 aL,aS;
uniform vec2 uRes;
varying vec2 vQ;
varying vec3 vA;
void main(){
vQ=position.xy;
vA=vec3(aL.w,aS.z,aL.z*2.2);
vec2 o=(vec2(aS.y,-aS.x)*vQ.x+aS.xy*(vQ.y*(1.+aS.z)-aS.z))*aL.z;
gl_Position=aL.w>0.?vec4(aL.xy+o*vec2(uRes.y/uRes.x,1.),-.999,1.):vec4(0.,0.,2.,1.);
}`;
const LENS_FS = `
uniform sampler2D uScene;
uniform vec2 uRes;
varying vec2 vQ;
varying vec3 vA;
void main(){
vec2 q=vQ;
q.x*=1.+max(-q.y,0.)*vA.y*.9;
float r2=dot(q,q),z=sqrt(max(1.-r2,0.));
vec3 c=texture2D(uScene,gl_FragCoord.xy/uRes-q*(1.3-z)*vA.z).rgb;
c=c*(.5+.58*z)+.03+pow(max(dot(vec3(q,z),vec3(-.37,.56,.74)),0.),22.)*.7;
gl_FragColor=vec4(c,1.)*(1.-smoothstep(.6,1.,r2))*vA.x;
}`;

// Tyre mark: soft shoulders, lengthwise streaks. color = shoulder, -, -, opacity.
const SKID_VS = `
attribute vec4 color;
varying vec4 vK;
void main(){
vec4 mv=viewMatrix*vec4(position,1.);
vK=vec4(color.x*2.-1.,color.w,dot(position.xz,vec2(.031,.027)),-mv.z);
gl_Position=projectionMatrix*mv;
}`;
const SKID_FS = `
uniform sampler2D uN;
${FOG}
varying vec4 vK;
void main(){
float a=vK.y*(1.-pow(abs(vK.x),4.))*(.22+texture2D(uN,vec2(vK.x*.23,vK.z)).r*.66);
gl_FragColor=vec4(mix(vec3(.012),fogColor,smoothstep(fogNear,fogFar,vK.w)),a);${OUTPUT}
gl_FragColor.rgb*=a;
}`;

const BILLBOARD = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
const RIBBON = [-1, 0, 1, 0, 1, 1, -1, 1];

function instancedQuad(cornerName, corners, size, attrs, count) {
  const g = new THREE.InstancedBufferGeometry();
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.setAttribute(cornerName, new THREE.BufferAttribute(new Float32Array(corners), size));
  for (const name in attrs) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(count * attrs[name]), attrs[name]);
    a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(name, a);
  }
  g.instanceCount = count;
  // Instances roam the circuit: one fixed bound, never recomputed.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  return g;
}

function softPool(count, userData) {
  const pool = [];
  for (let i = 0; i < count; i++) {
    pool.push({
      // Stands in for the Sprite each card once was. The card is an instance
      // of a shared batch, whose userData carries its GTAO flag.
      sprite: {
        position: new THREE.Vector3(0, PARK, 0), scale: new THREE.Vector3(1, 1, 1),
        visible: false, material: { opacity: 0 }, userData,
      },
      vel: new THREE.Vector3(), life: 0, maxLife: 1, startScale: 1,
      grow: 0, alpha: 0, drag: 2, rise: 0, floor: 0, rot: 0, spin: 0, seed: 0, r: 1, g: 1, b: 1,
    });
  }
  return pool;
}

export class Effects {
  constructor(scene, random = () => Math.random(), options = {}) {
    this.scene = scene;
    this.random = random;
    this.preferenceScale = defaultMotionScale(options);
    this.emissionCounts = {
      sparks: 0, smoke: 0, dust: 0, debris: 0, gravel: 0, rubber: 0, rain: 0, spray: 0,
      mist: 0, embers: 0, flames: 0, lens: 0,
    };
    this._entryState = new WeakMap();
    this.environment = options.environment || null;
    this._rainEmission = this._lensEmission = this._rain = 0;
    this.rainEmitterY = 0;
    this._sprayK = this._mistK = 1;
    this._wheel = new Float32Array(20);
    this._surface = {};
    this._ground = new THREE.Color(0.05, 0.2, 0.04);
    this._v2 = new THREE.Vector2();

    this._meshes = [];
    const add = (mesh, order) => {
      this._meshes.push(mesh);
      mesh.frustumCulled = false;
      mesh.renderOrder = order;
      // GTAO's opaque override material cannot see particle alpha.
      mesh.userData.gtaoExcluded = true;
      scene.add(mesh);
      return mesh;
    };
    const grey = (v = 0) => ({ value: new THREE.Color(v, v, v) });
    const U = this.uniforms = {
      uN: { value: this.noiseTex = noiseTexture() },
      uSun: grey(0.6), uAmb: grey(0.3), uLit: grey(0.6), fogColor: grey(),
      uSunW: { value: new THREE.Vector3(0.52, 0.76, 0.32) },
      uCamV: { value: new THREE.Vector3() },
      uH: { value: 900 }, fogNear: { value: 1e5 }, fogFar: { value: 1e6 },
    };
    const shader = (vertexShader, fragmentShader, uniforms = U, defines = {}) => new THREE.ShaderMaterial({
      uniforms, defines, vertexShader, fragmentShader,
      transparent: true, premultipliedAlpha: true, depthWrite: false, fog: uniforms === U || !!defines.FIELD,
    });

    // ---- soft particles: smoke, dust, spray and mist share one batch
    this.puffs = add(new THREE.Mesh(instancedQuad('position', BILLBOARD, 3, { aP: 4, aC: 4, aM: 4 },
      L.smoke + L.dust + L.spray + L.mist), shader(PUFF_VS, PUFF_FS)), 6);
    const cards = this.puffs.userData;
    this.smoke = softPool(L.smoke, cards);
    this.dust = softPool(L.dust, cards);
    this.spray = softPool(L.spray, cards);
    this.mist = softPool(L.mist, cards);
    this._smokeCursor = this._dustCursor = this._sprayCursor = this._mistCursor = 0;

    // ---- streaks: sparks/embers/flame, roost and marbles, near rain
    const streakMat = shader(STREAK_VS, STREAK_FS);
    const streaks = (count, order) => {
      const mesh = add(new THREE.Mesh(
        instancedQuad('corner', RIBBON, 2, { position: 3, aV: 4, aC: 4 }, count), streakMat), order);
      const p = mesh.geometry.attributes.position.array, pool = [];
      for (let i = 0; i < count; i++) {
        p[i * 3 + 1] = PARK;
        pool.push({
          vel: new THREE.Vector3(), life: 0, maxLife: 1, floor: 0, w: 0, kind: 0,
          bounces: 0, settled: false, r: 0, g: 0, b: 0,
        });
      }
      return [mesh, pool];
    };
    [this.sparks, this.sparkData] = streaks(L.sparks, 8);
    [this.debris, this.debrisData] = streaks(L.debris, 5);
    [this.rain, this.rainData] = streaks(L.rain, 7);
    this._sparkCursor = this._debrisCursor = this._rainCursor = 0;

    // ---- rain volume
    const seeds = new Float32Array(L.rainField * 3);
    for (let i = 0; i < seeds.length; i++) seeds[i] = random();
    const fieldGeo = instancedQuad('corner', RIBBON, 2, {}, L.rainField);
    fieldGeo.setAttribute('position', new THREE.InstancedBufferAttribute(seeds, 3));
    this._field = {
      ...U,
      uBox: { value: new THREE.Vector3(...RAIN_BOX) },
      uOff: { value: new THREE.Vector3() },
      uSV: { value: new THREE.Vector3(0, 0.5, 0) },
      uCol: { value: new THREE.Vector4() },
    };
    this.rainField = add(new THREE.Mesh(fieldGeo, shader(STREAK_VS, STREAK_FS, this._field, { FIELD: 1 })), 7);

    // ---- overcast veil: greys the sky while it rains
    this.veil = add(new THREE.Mesh(new THREE.SphereGeometry(1850, 16, 8), new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0, depthWrite: false, side: THREE.BackSide, fog: false,
    })), -3);

    // ---- water on the lens
    const lensMat = shader(LENS_VS, LENS_FS,
      { uScene: { value: null }, uRes: { value: new THREE.Vector2(1600, 900) } });
    this.lens = add(new THREE.Mesh(
      instancedQuad('position', BILLBOARD, 3, { aL: 4, aS: 4 }, L.lens), lensMat), 1000);
    this.lensData = [];
    for (let i = 0; i < L.lens; i++) {
      this.lensData.push({ x: 0, y: 0, r: 0, vx: 0, vy: 0, life: 0, maxLife: 1 });
    }
    // Refraction needs the frame as drawn so far: copy it before the beads.
    this.lens.onBeforeRender = (renderer) => {
      const target = renderer.getRenderTarget(), u = lensMat.uniforms;
      const size = target ? this._v2.set(target.width, target.height) : renderer.getDrawingBufferSize(this._v2);
      let tex = this.sceneTex;
      if (!tex || tex.image.width !== size.x || tex.image.height !== size.y) {
        if (tex) tex.dispose();
        tex = this.sceneTex = u.uScene.value = new THREE.FramebufferTexture(size.x, size.y);
        tex.type = target ? target.texture.type : THREE.UnsignedByteType;
        tex.minFilter = tex.magFilter = THREE.LinearFilter;
      }
      u.uRes.value.copy(size);
      renderer.copyFramebufferToTexture(this._v2.set(0, 0), tex);
      lensMat.uniformsNeedUpdate = true;
    };

    // ---- tyre marks: ribbon ring buffer, one axle per segment
    const kg = this.skidGeo = new THREE.BufferGeometry();
    const kidx = [];
    // seg i -> verts [i*8 .. i*8+7]: wheelA(p0,p1,c0,c1), wheelB(p0,p1,c0,c1)
    const kpos = new Float32Array(SKID_SEGS * 8 * 3), kcol = new Uint8Array(SKID_SEGS * 8 * 4);
    for (let i = 0; i < SKID_SEGS; i++) {
      const v = i * 8;
      // Wound to face up (the previous order faced down and was culled).
      kidx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3, v + 4, v + 6, v + 5, v + 5, v + 6, v + 7);
    }
    for (let i = 1; i < kpos.length; i += 3) kpos[i] = PARK;
    for (let i = 4; i < kcol.length; i += 8) kcol[i] = 255;
    kg.setAttribute('position', new THREE.BufferAttribute(kpos, 3));
    kg.setAttribute('color', new THREE.BufferAttribute(kcol, 4, true));
    kg.setIndex(kidx);
    this.skid = add(new THREE.Mesh(kg, shader(SKID_VS, SKID_FS)), 1);
    Object.assign(this.skid.material, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this._skidCursor = 0;
    // Last edge per axle (front, rear): 8 corner coords, y, 2 alphas, valid.
    this._skidEdges = [new Float32Array(12), new Float32Array(12)];
    this._skidPrev = null;

    this._hook = scene.onBeforeRender;
    scene.onBeforeRender = (renderer, s, camera, target) => {
      this._hook.call(s, renderer, s, camera, target);
      // Skip the AO pre-pass, which re-renders through an override material.
      if (!s.overrideMaterial) this._sync(renderer, camera, target);
    };
    this.setQualityTier(options.qualityTier);
  }

  // Tier-change hook. Never replaces a pool, texture, material or buffer.
  setQualityTier(tier) {
    const next = Object.hasOwn(EFFECT_QUALITY_SCALES, tier) ? tier : 'high';
    const weather = EFFECT_QUALITY_WEATHER_LIMITS[next];
    // Reduced motion drops the screen-space and flickering layers.
    const calm = this.preferenceScale < 0.5;
    this.qualityTier = next;
    this.motionScale = this.preferenceScale * EFFECT_QUALITY_SCALES[next];
    this.dustLimit = EFFECT_QUALITY_DUST_LIMITS[next];
    this.rainLimit = weather.rain;
    this.sprayLimit = weather.spray;
    this.mistLimit = weather.mist;
    this.lensLimit = calm ? 0 : weather.lens;
    this.flames = !calm;
    this.rainField.geometry.instanceCount = Math.round(weather.rainField * this.preferenceScale);
    this._dustCursor %= this.dustLimit;
    this._sprayCursor %= this.sprayLimit;
    this._mistCursor %= this.mistLimit;
    this._rainCursor %= this.rainLimit;
    this._lensCursor = this._lensEmission = 0;
    const park = (pool, limit) => {
      for (let i = limit; i < pool.length; i++) {
        pool[i].life = 0;
        if (pool[i].sprite) pool[i].sprite.visible = false;
      }
    };
    park(this.dust, this.dustLimit);
    park(this.spray, this.sprayLimit);
    park(this.mist, this.mistLimit);
    park(this.lensData, this.lensLimit);
    park(this.rainData, this.rainLimit);
    return this.motionScale;
  }

  bindEnvironment(environment) {
    this.environment = environment || null;
    return this;
  }

  // ---- emitters

  _take(cursor, limit) {
    const i = this[cursor];
    this[cursor] = (i + 1) % limit;
    return i;
  }

  _soft(pool, i, x, y, z, vx, vy, vz, life, size, grow, alpha, floor, drag, rise, aspect = 1) {
    const s = pool[i], sprite = s.sprite;
    s.life = s.maxLife = life;
    s.startScale = size;
    s.grow = grow;
    s.alpha = alpha;
    s.floor = floor;
    s.drag = drag;
    s.rise = rise;
    s.rot = this.random() * 6.283;
    s.spin = (this.random() - 0.5) * 1.1;
    s.seed = Math.floor(this.random() * 61);
    sprite.visible = true;
    sprite.position.set(x, y, z);
    sprite.scale.set(size, size * aspect, 1);
    sprite.material.opacity = 0;
    s.vel.set(vx, vy, vz);
    return s;
  }

  _emitSmoke(x, y, z, heading = 0, speed = 0, strength = 1, floor = y - 0.3) {
    const i = this._take('_smokeCursor', L.smoke), random = this.random;
    const k = clamp01(strength), carry = speed * (0.52 + random() * 0.26);
    const s = this._soft(this.smoke, i, x, y, z,
      sin(heading) * carry + (random() - 0.5) * 1.3, 0.7 + random() * 1.1,
      cos(heading) * carry + (random() - 0.5) * 1.3,
      (1.1 + random() * 0.9) * (0.55 + k * 0.6), 0.9 + random() * 0.5, 1.6 + k * 2 + random(),
      0.45 + k * 0.5, floor, 3.6, 0.55 + k * 0.5);
    s.r = s.g = 0.84 + random() * 0.08;
    s.b = s.r + 0.03;
    this.emissionCounts.smoke++;
    return s;
  }

  _emitDust(x, y, z, vx, vz, strength, floor, kerb) {
    const i = this._take('_dustCursor', this.dustLimit), random = this.random, ground = this._ground;
    // A kerb raises only a small puff of the dirt lying on it.
    const k = clamp01(strength), m = kerb ? 0.5 : 1, tone = 0.85 + random() * 0.3;
    const s = this._soft(this.dust, i, x, y, z,
      vx + (random() - 0.5) * 2.4, 1.6 + random() * 2.4 + k * 1.5, vz + (random() - 0.5) * 2.4,
      (1.5 + random() * 1.2) * m, (1 + random() * 0.6) * m, (2.6 + k * 2.4) * m,
      (0.55 + k * 0.35) * m, floor, 2.2, 0.1);
    // Dust is the venue's ground, bleached.
    s.r = (ground.r * 0.25 + 0.42) * tone;
    s.g = (ground.g * 0.2 + 0.35) * tone;
    s.b = (ground.b * 0.15 + 0.25) * tone;
    this.emissionCounts.dust++;
  }

  // tall: rear rooster tail, else wheel-arch spray. scale: fewer, larger cards
  // for far cars. thin: keeps the focal car's plume off the camera.
  _emitSpray(x, y, z, vx, vz, strength, floor, scale, tall, thin) {
    const i = this._take('_sprayCursor', this.sprayLimit), random = this.random;
    const k = clamp01(strength), speed = hypot(vx, vz), carry = 0.6 + random() * 0.22;
    const s = this._soft(this.spray, i, x, y, z,
      vx * carry + (random() - 0.5) * 2.2,
      (tall ? 3 + speed * 0.06 : 0.7 + speed * 0.012) * (0.7 + random() * 0.6),
      vz * carry + (random() - 0.5) * 2.2,
      (0.85 + random() * 0.4) * (0.6 + scale * 0.4) * (thin ? 0.6 : 1),
      (tall ? 1.3 : 0.8) * scale, (tall ? 4.4 : 2) * scale * (0.8 + k * 0.5),
      (0.4 + k * 0.45) * (tall ? 1 : 0.7) * (thin ? 0.5 : 1), floor, 2.4, -0.4, tall ? 1.25 : 0.8);
    s.r = 0.8; s.g = 0.84; s.b = 0.88;
    this.emissionCounts.spray++;
  }

  // What a plume leaves behind: slow, wide, faint, long-lived.
  _emitMist(x, y, z, vx, vz, strength, floor) {
    const i = this._take('_mistCursor', this.mistLimit), random = this.random;
    const s = this._soft(this.mist, i, x, y + 0.9 + random() * 0.8, z,
      vx * 0.32 + (random() - 0.5) * 1.5, 0.25, vz * 0.32 + (random() - 0.5) * 1.5,
      5 + random() * 3, 3 + random() * 1.5, 3.5 + random() * 1.5,
      0.22 + clamp01(strength) * 0.16, floor - 0.6, 1.2, 0.05, 0.62);
    s.spin *= 0.2;
    s.r = 0.78; s.g = 0.82; s.b = 0.87;
    this.emissionCounts.mist++;
  }

  _streak(mesh, pool, i, x, y, z, vx, vy, vz, floor, kind, life, width) {
    const p = mesh.geometry.attributes.position.array, d = pool[i];
    p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z;
    d.floor = floor;
    d.kind = kind;
    d.bounces = 0;
    d.settled = false;
    d.life = d.maxLife = life;
    d.w = width;
    d.vel.set(vx, vy, vz);
    return d;
  }

  _spark(x, y, z, vx, vy, vz, floor, kind) {
    const i = this._take('_sparkCursor', L.sparks), random = this.random;
    this._streak(this.sparks, this.sparkData, i, x, y, z, vx, vy, vz, floor, kind,
      kind === FLAME ? 0.07 + random() * 0.08 : kind ? 0.22 + random() * 0.36 : 0.32 + random() * 0.7,
      kind === FLAME ? 0.07 + random() * 0.05 : 0.011 + random() * 0.011);
    this.emissionCounts[kind === FLAME ? 'flames' : kind ? 'embers' : 'sparks']++;
  }

  // Sparks leave the plank slower than the car and stream back from it.
  _emitSpark(x, y, z, heading, v, floor = 0) {
    const random = this.random, keep = abs(v) * (0.3 + random() * 0.42);
    this._spark(x, y, z, sin(heading) * keep + (random() - 0.5) * 7, 0.6 + random() * 4.4,
      cos(heading) * keep + (random() - 0.5) * 7, floor, SPARK);
  }

  // Roost (stones, soil, torn turf) or shed tyre rubber.
  _emitDebris(x, y, z, vx, vz, floor, rubber) {
    const i = this._take('_debrisCursor', L.debris), random = this.random, ground = this._ground;
    const keep = rubber ? 0.82 : 0.45 + random() * 0.35, tone = random();
    const d = this._streak(this.debris, this.debrisData, i, x, y, z,
      vx * keep + (random() - 0.5) * 5, rubber ? 0.4 + random() * 0.7 : 1.2 + random() * 4.6,
      vz * keep + (random() - 0.5) * 5, floor, rubber ? RUBBER : ROOST,
      rubber ? 5 + random() * 5 : 0.9 + random() * 0.9, rubber ? 0.012 + tone * 0.01 : 0.018 + tone * 0.026);
    if (rubber) d.r = d.g = d.b = 0.03 + tone * 0.03;
    else if (random() < 0.55) {
      d.r = 0.09 + tone * tone * 0.5; d.g = d.r * 0.8; d.b = d.r * 0.6;   // soil to pale stone
    } else {
      d.r = ground.r * (0.8 + tone * 0.9) + 0.03;                         // torn turf
      d.g = ground.g * (0.8 + tone * 0.9) + 0.03;
      d.b = ground.b * (0.8 + tone * 0.9) + 0.02;
    }
    this.emissionCounts.debris++;
    this.emissionCounts[rubber ? 'rubber' : 'gravel']++;
  }

  // Near rain falls where the focal car is heading, so it stays in view.
  _emitRain(x, y, z, fx, fz, wx, wz, fall) {
    const i = this._take('_rainCursor', this.rainLimit), random = this.random;
    const ahead = -8 + random() * 50, side = (random() - 0.5) * 34;
    this._streak(this.rain, this.rainData, i, x + fx * ahead + fz * side, y + 4 + random() * 10,
      z + fz * ahead - fx * side, wx, -fall, wz, y, DROP, 0.75, 0.005 + random() * 0.004);
    this.emissionCounts.rain++;
  }

  _stateFor(entry) {
    let state = this._entryState.get(entry);
    if (!state) {
      state = {
        sparks: 0, smoke: 0, dust: 0, debris: 0, rubber: 0, spray: 0, mist: 0, embers: 0,
        wallCooldown: 0, gear: 0, pop: 0,
      };
      this._entryState.set(entry, state);
    }
    return state;
  }

  _emissions(state, key, dt, rate, maxBurst = 2) {
    if (rate <= 0 || dt <= 0 || this.motionScale <= 0) {
      state[key] = 0;
      return 0;
    }
    state[key] = min(maxBurst + 0.99, state[key] + rate * dt * this.motionScale);
    const count = min(maxBurst, Math.floor(state[key]));
    state[key] -= count;
    return count;
  }

  // ---- tyre marks

  // Extend an axle's two ribbons to new contact points. Opacity is per edge,
  // so a mark fades in and out with the slide that laid it.
  _skidLay(axle, ax, az, bx, bz, lx, lz, ry, half, ia, ib, minStep) {
    const edges = this._skidEdges, e = edges[axle], y = ry + 0.045;
    // Clearing the public handle (skidBreak, test scrubs) ends both ribbons.
    if (!this._skidPrev) edges[0][11] = edges[1][11] = 0;
    if (e[11]) {
      const dx = ax - (e[0] + e[2]) * 0.5, dz = az - (e[1] + e[3]) * 0.5, gap = dx * dx + dz * dz;
      if (gap < minStep * minStep) return;
      // A teleport (pit stop, reset) must not drag a ribbon across the track.
      if (gap > 64) e[11] = 0;
    }
    if (e[11]) {
      const i = this._skidCursor, attrs = this.skidGeo.attributes;
      const a = attrs.position.array, c = attrs.color.array;
      this._skidCursor = (i + 1) % SKID_SEGS;
      for (let w = 0; w < 2; w++) {
        const o = i * 24 + w * 12, k = w * 4, alpha = i * 32 + w * 16 + 3;
        const cx = w ? bx : ax, cz = w ? bz : az;
        a[o] = e[k]; a[o + 1] = e[8]; a[o + 2] = e[k + 1];
        a[o + 3] = e[k + 2]; a[o + 4] = e[8]; a[o + 5] = e[k + 3];
        a[o + 6] = cx - lx * half; a[o + 7] = y; a[o + 8] = cz - lz * half;
        a[o + 9] = cx + lx * half; a[o + 10] = y; a[o + 11] = cz + lz * half;
        c[alpha] = c[alpha + 4] = e[9 + w] * 255;
        c[alpha + 8] = c[alpha + 12] = (w ? ib : ia) * 255;
      }
      // The oldest marks thin out ahead of the cursor rather than pop.
      for (let ahead = 12; ahead <= 48; ahead += 12) {
        const j = ((i + ahead) % SKID_SEGS) * 32 + 3;
        for (let v = 0; v < 32; v += 4) c[j + v] >>= 1;
      }
      attrs.position.needsUpdate = attrs.color.needsUpdate = true;
    }
    e[0] = ax - lx * half; e[1] = az - lz * half; e[2] = ax + lx * half; e[3] = az + lz * half;
    e[4] = bx - lx * half; e[5] = bz - lz * half; e[6] = bx + lx * half; e[7] = bz + lz * half;
    e[8] = y; e[9] = ia; e[10] = ib; e[11] = 1;
    this._skidPrev = edges;
  }

  _skidSegment(l, r, left, ry = 0) {
    // l/r: rear-left & rear-right contact points (Vector3-ish {x,z}).
    this._skidLay(1, l.x, l.z, r.x, r.z, left.x, left.z, ry, 0.2, 0.6, 0.6, 0);
  }

  skidBreak(axle = -1) {
    const edges = this._skidEdges;
    if (axle !== 1) edges[0][11] = 0;
    if (axle !== 0) edges[1][11] = 0;
    if (!edges[0][11] && !edges[1][11]) this._skidPrev = null;
  }

  // ---- simulation

  _stepSoft(pool, dt, wx, wz) {
    for (const s of pool) {
      if (s.life <= 0) continue;
      const sprite = s.sprite, aspect = sprite.scale.y / sprite.scale.x;
      s.life -= dt;
      if (s.life <= 0) {
        s.life = 0;
        sprite.visible = false;
        continue;
      }
      const t = 1 - s.life / s.maxLife, k = min(1, s.drag * dt), v = s.vel, p = sprite.position;
      // Drag bleeds inherited motion into the wind; buoyancy takes over.
      v.x += (wx - v.x) * k;
      v.z += (wz - v.z) * k;
      v.y += (s.rise - v.y) * k;
      p.x += v.x * dt;
      p.y = max(s.floor, p.y + v.y * dt);
      p.z += v.z * dt;
      const size = s.startScale + s.grow * (1 - (1 - t) * (1 - t));
      sprite.scale.set(size, size * aspect, 1);
      sprite.material.opacity = s.alpha * min(1, t * 30) * Math.pow(1 - t, 1.4);
      s.rot += s.spin * dt;
    }
  }

  _stepStreaks(mesh, pool, dt) {
    const attr = mesh.geometry.attributes.position, a = attr.array;
    for (let i = 0; i < pool.length; i++) {
      const d = pool[i];
      if (d.life <= 0) continue;
      const o = i * 3, v = d.vel, k = d.kind, solid = k === ROOST || k === RUBBER;
      d.life -= dt;
      if (!d.settled) {
        if (k === FLAME) v.multiplyScalar(max(0, 1 - 5 * dt));
        else if (k !== DROP) v.y -= (solid ? 13 : k ? 6 : 11) * dt;
        if (k < FLAME) v.multiplyScalar(max(0, 1 - 0.9 * dt));
        a[o] += v.x * dt;
        a[o + 1] += v.y * dt;
        a[o + 2] += v.z * dt;
        const floor = (d.floor || 0) + (solid ? 0.035 : k === DROP ? 0 : 0.02);
        if (a[o + 1] < floor) {
          // Titanium skips off the asphalt; stones bounce once, then lie still.
          const lively = solid ? abs(v.y) > 0.9 && d.bounces < 1 : k === SPARK && d.bounces < 2 && v.y < -0.8;
          d.bounces++;
          a[o + 1] = floor;
          if (lively) {
            v.y *= solid ? -0.24 : -0.34;
            v.x *= solid ? 0.58 : 0.7;
            v.z *= solid ? 0.58 : 0.7;
          } else if (solid) {
            d.settled = true;
            v.set(0, 0, 0);
          } else d.life = 0;
        }
      }
      if (d.life <= 0) {
        d.life = 0;
        a[o + 1] = PARK;
      }
    }
    attr.needsUpdate = true;
  }

  update(delta, entries, environment = this.environment) {
    const dt = Number.isFinite(delta) ? max(0, min(0.1, delta)) : 0;
    const random = this.random;
    const weather = environment?.weather?.current || environment?.current || environment?.weather || null;
    const raining = this._rain = clamp01((weather?.rainfall || 0) / 18);
    const wind = weather?.windSpeed || 0, bearing = weather?.windDirection || 0;
    const windX = sin(bearing) * wind, windZ = cos(bearing) * wind;

    this._stepStreaks(this.sparks, this.sparkData, dt);
    this._stepStreaks(this.debris, this.debrisData, dt);
    this._stepStreaks(this.rain, this.rainData, dt);
    this._stepSoft(this.smoke, dt, windX * 0.3, windZ * 0.3);
    this._stepSoft(this.dust, dt, windX * 0.3, windZ * 0.3);
    this._stepSoft(this.spray, dt, windX * 0.5, windZ * 0.5);
    this._stepSoft(this.mist, dt, windX * 0.5, windZ * 0.5);

    // Rain is local to the player/lead car; pool and burst are bounded.
    let focal = null;
    for (const entry of entries) {
      if (entry.dnf) continue;
      if (!focal || entry.isPlayer) focal = entry.phys;
      if (entry.isPlayer) break;
    }
    const focalV = focal ? focal.v || 0 : 0;
    const focalX = focal ? sin(focal.heading) : 0, focalZ = focal ? cos(focal.heading) : 1;
    this.uniforms.uCamV.value.set(focalX * focalV, 0, focalZ * focalV);
    const fall = 21 + raining * 9, driftX = windX * 0.6, driftZ = windZ * 0.6;
    if (raining > 0.004 && focal) {
      const rainFloor = this.rainEmitterY = effectSurfaceHeight(focal);
      this._rainEmission = min(24.99,
        this._rainEmission + dt * (60 + raining * 620) * this.motionScale);
      const count = min(24, Math.floor(this._rainEmission));
      this._rainEmission -= count;
      for (let i = 0; i < count; i++) {
        this._emitRain(focal.pos.x, rainFloor, focal.pos.z, focalX, focalZ, driftX, driftZ, fall);
      }
    } else this._rainEmission = 0;
    // The rain volume takes the same wind and fall, wrapped to its box.
    const field = this._field, drift = field.uOff.value;
    drift.x = (drift.x + driftX * dt) % RAIN_BOX[0];
    drift.y = (drift.y - fall * dt) % RAIN_BOX[1];
    drift.z = (drift.z + driftZ * dt) % RAIN_BOX[2];
    field.uSV.value.set((focalX * focalV - driftX) * 0.02, fall * 0.02, (focalZ * focalV - driftZ) * 0.02);

    let sprayNeed = 0, mistNeed = 0;
    const wheel = this._wheel;
    for (const e of entries) {
      const p = e.phys;
      if (p.disabled || e.dnf) continue;
      const state = this._stateFor(e);
      state.wallCooldown = max(0, state.wallCooldown - dt);
      const cc = p.circuit, sm = cc?.samples?.[p.sampleIdx];
      // render-only elevation offset (physics is planar)
      const ry = effectSurfaceHeight(p);
      const fx = sin(p.heading), fz = cos(p.heading);
      // (sx, sz): physics lateral axis; wheel.left is on its negative side.
      const sx = fz, sz = -fx;
      const speed = abs(p.v), slide = p.velocityLat || 0;
      const vx = fx * p.v + sx * slide, vz = fz * p.v + sz * slide;
      // Emit along this tick's path, not its end: the car is drawn there, and
      // trails stay unbroken.
      const lag = random() * dt, px = p.pos.x - vx * lag, pz = p.pos.z - vz * lag;
      const own = p === focal;
      const dxF = focal ? p.pos.x - focal.pos.x : 0, dzF = focal ? p.pos.z - focal.pos.z : 0;
      const range = hypot(dxF, dzF), ahead = dxF * focalX + dzF * focalZ;
      // Every camera looks ahead of the focal car; nothing far behind shows.
      const lod = ahead < -30 ? 0 : range < 45 ? 1 : range < 140 ? 0.5 : 0.22;

      let wetness = clamp01(p.surfaceWetness || 0), puddling = 0;
      if (environment?.sampleSurface && Number.isFinite(p.sampleIdx)) {
        const surface = environment.sampleSurface(p.sampleIdx, p.lat || 0, this._surface);
        wetness = clamp01(surface.wetness);
        puddling = clamp01(surface.puddling || 0);
      }
      const dry = 1 - wetness;
      if (own && cc?.theme?.ground != null) this._ground.set(cc.theme.ground);

      // Per wheel: slide intensity, off the road, on a kerb, world offset x, z.
      const wheels = p.wheels, half = cc?.halfWidth;
      const edge = sm?.n && half > 0 && !p.corridor;
      const sideN = edge ? sx * sm.n.x + sz * sm.n.z : 1, foreN = edge ? fx * sm.n.x + fz * sm.n.z : 0;
      const corner = abs(sm?.curv || 0) > 1 / 260;
      let slip = 0, off = 0, kerbs = 0;
      for (let i = 0; i < 4; i++) {
        let out = p.offTrack ? 1 : 0, kerb = p.onKerb && !edge ? 1 : 0, k = 0;
        if (edge) {
          const a = abs(p.lat + WX[i] * sideN + WZ[i] * foreN);
          kerb = corner && a > half - 0.35 && a < half + 1.3 ? 1 : 0;
          out = a > half + 0.15 && !kerb ? 1 : 0;
        }
        if (wheels) {
          const w = wheels[i], ratio = w.slipRatio || 0;
          // Wheel speed only means something on a braked or driven axle.
          const lock = p.brake > 0.2 ? clamp01((-ratio - 0.16) * 2.2) * clamp01(speed / 9) : 0;
          const spin = i > 1 && p.throttle > 0.3 ? clamp01((ratio - 0.2) * 1.3) : 0;
          const scrub = clamp01((abs(w.slipAngle || 0) - 0.15) * 4) * clamp01(speed / 22);
          k = w.contact === false ? 0 : max(lock, spin, scrub);
        } else if (p.slip && i > 1 && speed > 12) {
          k = clamp01(0.45 + p.brake * 0.45 + max(0, p.throttle - 0.7));
        }
        // Wet tarmac and grass smoke far less than dry asphalt.
        k *= (1 - wetness * 0.9) * (out ? 0.25 : 1);
        wheel[i] = k;
        wheel[4 + i] = out;
        wheel[8 + i] = kerb;
        wheel[12 + i] = fx * WZ[i] + sx * WX[i];
        wheel[16 + i] = fz * WZ[i] + sz * WX[i];
        slip += k;
        off += out;
        kerbs += kerb;
      }

      // tyre smoke: each sliding wheel sheds its own plume
      const smokeCount = this._emissions(state, 'smoke', dt,
        slip > 0.04 ? min(52, (9 + speed * 0.5) * min(2, slip)) * lod : 0, 3);
      for (let n = 0; n < smokeCount; n++) {
        let pick = random() * slip, i = 0;
        while (i < 3 && (pick -= wheel[i]) > 0) i++;
        const back = i > 1 && p.throttle > 0.3 ? 2.5 * wheel[i] : 0, along = WZ[i] - back * 0.2;
        this._emitSmoke(px + fx * along + sx * WX[i] + (random() - 0.5) * 0.3, ry + 0.2 + random() * 0.2,
          pz + fz * along + sz * WX[i] + (random() - 0.5) * 0.3,
          p.heading, p.v - back * 4, 0.3 + wheel[i] * 0.7, ry);
      }

      // off-track: each wheel off the road digs out dust and roost
      const sink = p.offTrackSink || 0;
      const dustCount = this._emissions(state, 'dust', dt, speed > 5
        ? (min(22, off * (1.6 + speed * 0.085 + sink * 1.6)) * dry + (speed > 18 ? kerbs * 2.5 : 0)) * dry * lod
        : 0);
      const roostCount = this._emissions(state, 'debris', dt,
        speed > 7 ? min(60, off * (2 + speed * 0.3)) * lod : 0);
      for (let n = 0; n < dustCount + roostCount; n++) {
        // From a wheel that is off the road; dust also from one on a kerb.
        const dust = n < dustCount;
        let i = Math.floor(random() * 4), tries = 0;
        while (tries++ < 3 && !wheel[4 + i] && !(dust && wheel[8 + i])) i = (i + 1) % 4;
        const x = px + wheel[12 + i], z = pz + wheel[16 + i];
        if (dust) {
          this._emitDust(x, ry + 0.25, z, vx * 0.3, vz * 0.3, 0.45 + sink * 0.4 + speed * 0.004, ry, !wheel[4 + i]);
        } else this._emitDebris(x, ry + 0.08, z, vx, vz, ry, false);
      }
      // Sustained slip sheds rubber that settles as marbles.
      const rubberCount = this._emissions(state, 'rubber', dt,
        (p.slip || slip > 0.3) && !p.offTrack && speed > 24 ? 1.25 * lod : 0, 1);
      for (let n = 0; n < rubberCount; n++) {
        const i = 2 + (random() < 0.5 ? 1 : 0);
        this._emitDebris(px + wheel[12 + i], ry + 0.1, pz + wheel[16 + i], vx * 0.03, vz * 0.03, ry, true);
      }

      // skid block: kerbs, bottoming over bumps, brake dive, wall scrapes
      const bump = (p.surface?.bump || 0) / 0.0045;
      const bottoming = speed > 70 ? clamp01((speed - 70) / 16) * clamp01((bump - 0.5) * 2.5) : 0;
      const kerbHit = p.onKerb && speed > 30
        ? (70 + speed * 1.2) * clamp01(0.25 + abs(p.rideBump ?? 0.02) * 70) : 0;
      const dive = p.brake > 0.75 && speed > 52 ? 26 + (speed - 52) * 1.5 : 0;
      const scrape = max(p.wallScrape || 0, p.carScrape || 0);
      const wallSide = (p.lat < 0 ? -0.9 : 0.9) * (sideN < 0 ? -1 : 1);
      const sparkCount = this._emissions(state, 'sparks', dt,
        (kerbHit + bottoming * 240 + dive + scrape * 150) * (lod < 1 ? lod * 1.2 : 1), 6);
      for (let n = 0; n < sparkCount; n++) {
        // Off the plank's trailing edge; a scrape sparks at the wall.
        const rub = scrape > 0.05 && random() < 0.7;
        const along = rub ? (random() - 0.5) * 3.4 : -1.2 - random() * 0.9;
        const across = rub ? wallSide : (random() - 0.5) * (kerbHit ? 1.7 : 0.7);
        this._emitSpark(px + fx * along + sx * across, ry + 0.05, pz + fz * along + sz * across,
          p.heading, p.v, ry);
      }
      // One burst per wall impact: the contact signal spans several ticks.
      if (p.wallHit > 0.35 && state.wallCooldown <= 0 && lod) {
        state.wallCooldown = 0.32;
        const burst = min(30, Math.ceil((8 + p.wallHit * 22) * this.motionScale));
        const x = p.pos.x + sx * wallSide, z = p.pos.z + sz * wallSide;
        for (let n = 0; n < burst; n++) {
          this._emitSpark(x, ry + 0.35, z, p.heading, speed * 0.5, ry);
          if (n % 3 === 0) this._emitDebris(x, ry + 0.25, z, vx * 0.5, vz * 0.5, ry, false);
        }
      }
      // Glowing carbon discs shed embers from the front wheels.
      const glow = clamp01(((p.brakeTemp || 0) - 480) / 480) * clamp01((p.brake - 0.25) * 2);
      const emberCount = this._emissions(state, 'embers', dt, speed > 14 ? glow * 34 * lod : 0);
      for (let n = 0; n < emberCount; n++) {
        const i = n & 1, keep = 0.55 + random() * 0.3;
        this._spark(px + wheel[12 + i], ry + 0.22 + random() * 0.2, pz + wheel[16 + i],
          vx * keep + (random() - 0.5) * 3, 0.4 + random() * 1.6, vz * keep + (random() - 0.5) * 3, ry, EMBER);
      }
      // Unburnt fuel lights in the exhaust on an off-throttle downshift.
      if (state.gear > p.gear && speed > 16 && p.throttle < 0.4 && this.flames && lod > 0.4) state.pop = 0.09;
      state.gear = p.gear || 0;
      if (state.pop > 0) {
        state.pop -= dt;
        for (let n = 0; n < 2; n++) {
          const jet = 3 + random() * 7;
          this._spark(px - fx * 2.25, ry + 0.47 + (random() - 0.5) * 0.05, pz - fz * 2.25,
            vx - fx * jet + random() - 0.5, (random() - 0.3) * 1.4, vz - fz * jet + random() - 0.5, ry - 5, FLAME);
        }
      }

      // wet track: rooster tail, wheel-arch spray, and the mist they leave
      const water = clamp01(wetness + puddling * 0.6);
      if (water > 0.04 && speed > 8 && !p.offTrack && lod) {
        const rate = Math.pow(water, 0.7) * (4 + speed * 0.26) * lod;
        sprayNeed += rate;
        const sprayCount = this._emissions(state, 'spray', dt, rate * this._sprayK, 3);
        const scale = lod > 0.9 ? 1 : lod > 0.4 ? 1.5 : 2.1;
        for (let n = 0; n < sprayCount; n++) {
          const i = random() < 0.24 ? (n & 1) : 2 + (n & 1), across = WX[i] * random() * 1.2;
          this._emitSpray(px + fx * (WZ[i] - 0.4) + sx * across, ry + 0.3, pz + fz * (WZ[i] - 0.4) + sz * across,
            vx, vz, water * (0.45 + speed * 0.008), ry, scale, i > 1, own);
        }
        const mistRate = speed > 14 ? water * 3 * lod : 0;
        mistNeed += mistRate;
        if (this._emissions(state, 'mist', dt, mistRate * this._mistK, 1)) {
          this._emitMist(px - fx * 3, ry, pz - fz * 3, vx, vz, water, ry);
        }
      } else state.spray = state.mist = 0;

      // tyre marks: player only
      if (e.isPlayer) {
        for (let axle = 0; axle < 2; axle++) {
          const a = axle * 2, b = a + 1;
          const ia = wheel[4 + a] ? 0 : clamp01(wheel[a] * 1.3), ib = wheel[4 + b] ? 0 : clamp01(wheel[b] * 1.3);
          if (max(ia, ib) > 0.05 && speed > 3) {
            // The road is flat across, not along: use the axle's own height.
            this._skidLay(axle, p.pos.x + wheel[12 + a], p.pos.z + wheel[16 + a],
              p.pos.x + wheel[12 + b], p.pos.z + wheel[16 + b], sx, sz, effectSurfaceHeight(p, WZ[a]), axle ? 0.2 : 0.15, ia, ib, 0.55);
          } else this.skidBreak(axle);
        }
      }
    }
    // Share the fixed spray and mist pools between the cars that want them.
    this._sprayK = min(1, this.sprayLimit / 1.25 / max(1, sprayNeed * this.motionScale));
    this._mistK = min(1, this.mistLimit / 6.5 / max(0.2, mistNeed * this.motionScale));

    // water on the lens, faster at speed
    const blow = abs(focalV) * 0.012;
    const lensRate = this.lensLimit > 0 ? Math.pow(raining, 1.3) * (2.5 + blow * 8) : 0;
    this._lensEmission = lensRate > 0 ? min(2.99, this._lensEmission + lensRate * dt) : 0;
    while (this._lensEmission >= 1) {
      this._lensEmission--;
      const d = this.lensData[this._take('_lensCursor', this.lensLimit)];
      d.x = (random() - 0.5) * 2.1;
      d.y = (random() - 0.5) * 2.1;
      d.r = 0.009 + random() * random() * 0.04;
      d.life = d.maxLife = 1.2 + random() * 2.8;
      this.emissionCounts.lens++;
    }
    for (const d of this.lensData) {
      if (d.life <= 0) continue;
      d.life -= dt * (1 + blow * 0.6);
      // Airflow drives beads outwards from the centre; at rest they creep down.
      const dy = d.y + 0.25, push = blow * (0.4 + d.r * 22) / (hypot(d.x, dy) || 1);
      d.vx = d.x * push;
      d.vy = dy * push - 0.03 - d.r * 1.5;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if (d.life <= 0 || abs(d.x) > 1.2 || abs(d.y) > 1.2) d.life = 0;
    }
  }

  // ---- presentation

  _fill(pool, limit, cursor, n) {
    const geo = this.puffs.geometry.attributes;
    const P = geo.aP.array, C = geo.aC.array, M = geo.aM.array;
    // Newest first: from behind the car the newest card is the farthest.
    for (let k = 1; k <= limit; k++) {
      const s = pool[(cursor - k + limit) % limit], sprite = s.sprite;
      if (s.life <= 0 || !sprite.visible) continue;
      const o = n++ * 4, p = sprite.position;
      P[o] = p.x; P[o + 1] = p.y; P[o + 2] = p.z; P[o + 3] = sprite.scale.x * 0.5;
      C[o] = s.r; C[o + 1] = s.g; C[o + 2] = s.b; C[o + 3] = sprite.material.opacity;
      M[o] = s.rot; M[o + 1] = s.seed + min(0.999, 1 - s.life / s.maxLife);
      M[o + 2] = sprite.scale.y / sprite.scale.x; M[o + 3] = s.floor;
    }
    return n;
  }

  _fillStreaks(mesh, pool) {
    const geo = mesh.geometry.attributes, V = geo.aV.array, C = geo.aC.array;
    const lit = this.uniforms.uLit.value, cam = this.uniforms.uCamV.value;
    // Drizzle is fainter than a downpour.
    const wet = min(0.56, 0.16 + this._rain * 1.7);
    let live = 0;
    for (let i = 0; i < pool.length; i++) {
      const d = pool[i], o = i * 4, k = d.kind;
      if (d.life <= 0) { V[o + 3] = 0; continue; }
      const h = d.life / d.maxLife, v = d.vel;
      let r = d.r, g = d.g, b = d.b, a = 0;
      live++;
      // A settled marble must not streak: give it the camera's own motion.
      V[o] = d.settled ? cam.x : v.x; V[o + 1] = v.y; V[o + 2] = d.settled ? cam.z : v.z; V[o + 3] = d.w;
      if (k < FLAME) {
        // white-hot, cooling through orange to dull red; embers start at orange
        const heat = k ? h * 0.3 : h;
        r = 2 + heat * 14; g = (0.22 + heat * 0.7) * r; b = (0.03 + heat * heat * 0.7) * r;
      } else if (k === FLAME) {
        const e = 1.5 + h * 5;
        r = (1 - h * 0.45) * e; g = (0.42 + h * 0.3) * e; b = (0.08 + h * 0.9) * e;
      } else if (k === DROP) {
        r = lit.r * wet; g = lit.g * wet; b = lit.b * wet * 1.08;
      } else {
        a = min(1, d.life * 3);
        r *= a; g *= a; b *= a;
      }
      C[o] = r; C[o + 1] = g; C[o + 2] = b; C[o + 3] = a;
    }
    mesh.visible = live > 0;
    geo.aV.needsUpdate = geo.aC.needsUpdate = true;
  }

  // Once per rendered frame, before attributes upload: pools -> buffers.
  _sync(renderer, camera, target) {
    const U = this.uniforms, scene = this.scene;
    if (!this._lights) {
      this._lights = [];
      scene.traverse((o) => { if (o.isLight) this._lights.push(o); });
    }
    // Sun and sky tint every particle: warm at dusk, cold at night.
    let sun = null;
    const amb = U.uAmb.value.setScalar(scene.environment ? 0.14 * (scene.environmentIntensity ?? 1) : 0.04);
    for (const light of this._lights) {
      if (light.isDirectionalLight && (!sun || light.intensity > sun.intensity)) sun = light;
    }
    for (const light of this._lights) {
      if (light === sun) continue;
      const k = light.intensity * 0.3, c = light.color, g = light.groundColor;
      const w = g ? 0.7 : light.isAmbientLight ? 1 : 0.4;
      amb.r += (c.r * w + (g ? g.r * 0.3 : 0)) * k;
      amb.g += (c.g * w + (g ? g.g * 0.3 : 0)) * k;
      amb.b += (c.b * w + (g ? g.b * 0.3 : 0)) * k;
    }
    if (sun) {
      U.uSun.value.copy(sun.color).multiplyScalar(sun.intensity * 0.3);
      U.uSunW.value.copy(sun.position).sub(sun.target.position).normalize();
    }
    const lit = U.uLit.value.copy(U.uSun.value).multiplyScalar(0.5).add(amb);
    U.uH.value = target ? target.height : renderer.getDrawingBufferSize(this._v2).y;

    let n = this._fill(this.mist, this.mistLimit, this._mistCursor, 0);
    n = this._fill(this.dust, this.dustLimit, this._dustCursor, n);
    n = this._fill(this.spray, this.sprayLimit, this._sprayCursor, n);
    n = this._fill(this.smoke, L.smoke, this._smokeCursor, n);
    let geo = this.puffs.geometry;
    geo.instanceCount = n;
    this.puffs.visible = n > 0;
    geo.attributes.aP.needsUpdate = geo.attributes.aC.needsUpdate = geo.attributes.aM.needsUpdate = true;

    this._fillStreaks(this.sparks, this.sparkData);
    this._fillStreaks(this.debris, this.debrisData);
    this._fillStreaks(this.rain, this.rainData);

    const rain = this._rain, wet = clamp01(rain * 1.6);
    this.rainField.visible = rain > 0.01;
    this._field.uCol.value.set(lit.r * 0.42 * wet, lit.g * 0.44 * wet, lit.b * 0.46 * wet, 0);
    // Overcast follows the rain: a veil beyond all scenery, in front of the
    // sky, in the venue's own horizon colour.
    const veil = this.veil, sky = veil.material.color;
    sky.copy(scene.fog?.color || lit);
    sky.multiplyScalar(0.3).addScalar((sky.r + sky.g + sky.b) * 0.6);
    veil.visible = rain > 0.02;
    veil.position.copy(camera.position);
    veil.material.opacity = min(0.86, wet * 0.9);

    n = 0;
    geo = this.lens.geometry.attributes;
    const A = geo.aL.array, S = geo.aS.array;
    for (let i = 0; i < L.lens; i++) {
      const d = this.lensData[i], o = i * 4;
      A[o + 3] = 0;
      if (d.life <= 0) continue;
      n++;
      const t = 1 - d.life / d.maxLife, len = hypot(d.vx, d.vy) || 1;
      A[o] = d.x; A[o + 1] = d.y; A[o + 2] = d.r; A[o + 3] = min(1, t * 20, (1 - t) * 4);
      S[o] = d.vx / len; S[o + 1] = d.vy / len; S[o + 2] = min(1.8, len * 5);
    }
    this.lens.visible = n > 0;
    geo.aL.needsUpdate = geo.aS.needsUpdate = true;
  }

  dispose() {
    const scene = this.scene;
    scene.onBeforeRender = this._hook;
    for (const mesh of this._meshes) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.noiseTex.dispose();
    if (this.sceneTex) this.sceneTex.dispose();
    this.sceneTex = null;
  }
}
