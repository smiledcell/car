// APEX FORMULA 2026 — boot, renderer, cameras, input, and the game state machine.
import * as THREE from 'three';
import { EffectComposer } from '../lib/postprocessing/EffectComposer.js';
import { RenderPass } from '../lib/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../lib/postprocessing/UnrealBloomPass.js';
import { ScaledGTAOPass } from '../lib/postprocessing/ScaledGTAOPass.js';
import { OutputPass } from '../lib/postprocessing/OutputPass.js';
import { FXAAPass } from '../lib/postprocessing/FXAAPass.js';
import { ShaderPass } from '../lib/postprocessing/ShaderPass.js';
import { RGBELoader } from '../lib/loaders/RGBELoader.js';
import {
  CAMERA_FEEL, CAMERA_FRAMING, ONBOARD_MOUNTS, damp, resolveCameraMotion, resolveChaseCamera,
  shakeAmplitude, shakeNoise, speedSensation,
} from './cameraFraming.js';
import {
  GamepadRumble,
  WheelInputManager,
  advanceSteeringInput,
  analogSteeringInput,
  digitalSteeringLimit,
  tyreLimitState,
  wheelInputIsNeutral,
} from './controls.js';
import { cockpitFov, cockpitSeat, driverLateral } from './cockpit.js';
import { createTelemetrySnapshot } from './telemetry.js';
import { ReplayDirector } from './replay.js';
import { installLocalSaves } from './local-saves.js';
installLocalSaves();

// Photographic HDRI skies (CC0, PolyHaven). Load only the selected session's
// theme; fetching all three at boot used 19.8 MB before the player chose a race.
const HDRI = { day: null, dusk: null, night: null, promises: {} };
// Visible sky dome: the upper hemisphere of the SAME Poly Haven sky that lights
// the scene, prepared by tools/blender/build_sky.py and rotated so its sun sits
// on SUN_OFFSET. One sun for the sky, the shadows, the IBL and the reflections.
// Night venues keep their procedural skies.
const SKY_PHOTO = { day: 'textures/sky-day.jpg', dusk: 'textures/sky-dusk.jpg' };
const SKY_PHOTO_GAIN = 1.15;                       // DOME_GAIN in build_sky.py
const SKY = { day: null, dusk: null, promises: {} };
// World-space offset from the player to the sun light, per look. build_sky.py
// carries the same vectors: change one, re-run the other.
const SUN_OFFSET = { day: [260, 380, 160], dusk: [419, 134, 210], night: [260, 380, 160] };
// Linear horizon colour of each dome photo (printed by build_sky.py), so fog can
// dissolve distant scenery into the sky it is actually drawn against.
const SKY_PHOTO_HORIZON = { day: [0.459, 0.494, 0.600], dusk: [0.619, 0.474, 0.341] };
const photoManifest = {
  asphalt: 'textures/asphalt.png', grass: 'textures/grass.png',
  gravel: 'textures/gravel.png', crowd: 'textures/crowd.png',
  facadeDay: 'textures/facade-day.png', facadeNight: 'textures/facade-night.png',
  treeBroadleaf: 'textures/tree-broadleaf.png', treePine: 'textures/tree-pine.png',
  treePalm: 'textures/tree-palm.png', scrub: 'textures/scrub.png',
  armco: 'textures/armco.png', tyreWall: 'textures/tyre-wall.png',
  catchFence: 'textures/catch-fence.png',
};
let coreAssetPromise = null;
let RaceSession = null;
let buildCircuit = null;
let TEX = null;

function loadCoreAssets() {
  if (coreAssetPromise) return coreAssetPromise;
  const photos = Promise.allSettled(Object.entries(photoManifest).map(([key, url]) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ key, img });
      img.onerror = reject;
      img.src = globalThis.APEX_LOCAL_ASSETS?.[url] || url;
    })));
  // Keep the menu's module graph lean: the circuit, simulation, car and large
  // procedural-texture modules are only evaluated after a venue is chosen.
  // Their network work overlaps the photo fetches and the selected HDR.
  coreAssetPromise = Promise.all([
    import('./race.js'),
    import('./trackBuilder.js'),
    import('./textures.js'),
    import('./car.js'),
    photos,
  ]).then(([raceModule, circuitModule, textureModule, carModule, loadedPhotos]) => {
    RaceSession = raceModule.RaceSession;
    buildCircuit = circuitModule.buildCircuit;
    TEX = textureModule;
    for (const result of loadedPhotos) {
      if (result.status === 'fulfilled') TEX.registerPhoto(result.value.key, result.value.img);
    }
    return carModule.preloadCarModel();
  }).catch((error) => {
    // A rejected cached promise can never recover. Leave successfully fetched
    // browser modules cached, but allow the user-facing Retry action to rebuild
    // the aggregate load and refetch the missing resource.
    coreAssetPromise = null;
    throw error;
  });
  return coreAssetPromise;
}

function environmentKeyForTrack(trackId) {
  if (['jeddah', 'lusail', 'singapore', 'lasvegas', 'qatar'].includes(trackId)) return 'night';
  if (trackId === 'bahrain' || trackId === 'yasmarina') return 'dusk';
  return 'day';
}

function documentIsActive() {
  return !document.hidden &&
    (typeof document.hasFocus !== 'function' || document.hasFocus());
}

function finiteCameraValue(value) {
  return Number.isFinite(value) ? value : 0;
}

// Resolves with the dome texture, or null when the look has no photo or it
// failed to load (the procedural canvas dome then simply stays). Never rejects.
function loadSkyPhoto(key) {
  const url = SKY_PHOTO[key];
  if (!url) return Promise.resolve(null);
  if (SKY[key]) return Promise.resolve(SKY[key]);
  if (!SKY.promises[key]) {
    SKY.promises[key] = new Promise((resolve) => {
      new THREE.TextureLoader().load(globalThis.APEX_LOCAL_ASSETS?.[url] || url, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        // The image is the upper hemisphere only: stretch it over the top half
        // of the sphere and let the horizon row clamp down the lower half.
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.repeat.set(1, 2);
        tex.offset.set(0, -1);
        tex.anisotropy = 4;
        SKY[key] = tex;
        resolve(tex);
      }, undefined, () => {
        delete SKY.promises[key];
        resolve(null);
      });
    });
  }
  return SKY.promises[key];
}

function loadHDRI(key) {
  if (!['day', 'dusk', 'night'].includes(key)) return Promise.reject(new Error(`Unknown HDRI theme: ${key}`));
  if (HDRI[key]) return Promise.resolve(HDRI[key]);
  if (!HDRI.promises[key]) {
    // The dome photo rides the same promise so the lighting and the visible sky
    // switch from their procedural fallbacks in one step, never one frame apart.
    const skyPhoto = loadSkyPhoto(key);
    HDRI.promises[key] = new Promise((resolve, reject) => {
      const url = `textures/hdri/${key}.hdr`;
      new RGBELoader().load(globalThis.APEX_LOCAL_ASSETS?.[url] || url, (tex) => {
        tex.mapping = THREE.EquirectangularReflectionMapping;
        // ...but a slow or failed photo must not hold the lighting on its
        // fallback: after 2.5 s the HDR goes in alone and the dome follows.
        Promise.race([skyPhoto, new Promise((r) => setTimeout(r, 2500))]).then(() => {
          HDRI[key] = tex;
          resolve(tex);
        });
      }, undefined, reject);
    }).catch((error) => {
      delete HDRI.promises[key];
      throw error;
    });
  }
  return HDRI.promises[key];
}
import { HUD } from './hud.js';
import { UI } from './ui.js';
import { AudioEngine } from './audio.js';
import { Championship } from './championship.js';
import { Effects } from './effects.js';
import { RacingLine } from './racingLine.js';
import { QualityController } from './quality.js';
import {
  TimeTrialManager, bestStoredGhost, personalBestMessage, storedPersonalBests,
} from './timeTrial.js';
import { fmtTime } from './format.js';
import { FixedStepAccumulator } from './fixedStep.js';
import { createRandom, createRendererNoiseRandom, deriveSeed, normalizeSeed } from './random.js';
import { TRACKS } from './tracks.js';
import { CALENDAR, DRIVERS } from './data.js';

// The private-race subsystem (netcode, invite codec, WebRTC transport) is
// deferred: nobody pays for it at boot, and it is only parsed when a player
// actually opens or joins a race. `#race=` in the URL is the one thing the
// boot path has to recognise before that.
const INVITE_IN_URL = /[#&?]race=/;
let multiplayerModule = null;
function loadMultiplayer() {
  if (!multiplayerModule) multiplayerModule = import('./multiplayer.js');
  return multiplayerModule;
}

// The public-services client is deferred for the same reason and one more: a
// build with no lobby server configured never loads it at all, so the optional
// backend costs a player who has none exactly nothing.
let backendModule = null;
function loadBackend() {
  if (!backendModule) backendModule = import('./net/backend.js');
  return backendModule;
}
let publicRaceModule = null;
function loadPublicRace() {
  if (!publicRaceModule) publicRaceModule = import('./net/publicRace.js');
  return publicRaceModule;
}

const RETRY_SESSION_KEY = 'apexf1_retry_session_v1';
const RENDER_LOOK = Object.freeze({
  day: Object.freeze({
    exposure: 0.94,
    bloomStrength: 0.18, bloomRadius: 0.55, bloomThreshold: 0.86,
    environmentIntensity: 0.9, fallbackEnvironmentIntensity: 0.85,
  }),
  dusk: Object.freeze({
    exposure: 1.05,
    bloomStrength: 0.18, bloomRadius: 0.55, bloomThreshold: 0.86,
    environmentIntensity: 1.05, fallbackEnvironmentIntensity: 1.0,
    hemiIntensity: 0.74, hemiGround: 0x59606b, sunIntensity: 1.55,
  }),
  night: Object.freeze({
    exposure: 0.92,
    bloomStrength: 0.22, bloomRadius: 0.36, bloomThreshold: 0.92,
    environmentIntensity: 0.55, fallbackEnvironmentIntensity: 0.5,
  }),
  nightJeddah: Object.freeze({
    exposure: 0.95,
    bloomStrength: 0.18, bloomRadius: 0.28, bloomThreshold: 0.98,
    environmentIntensity: 0.48, fallbackEnvironmentIntensity: 0.44,
    hemiIntensity: 0.50, hemiGround: 0x242a32, sunIntensity: 1.05,
    ambientColor: 0x91a9d0, ambientIntensity: 0.34,
  }),
  nightSingapore: Object.freeze({
    exposure: 1.02,
    bloomStrength: 0.16, bloomRadius: 0.20, bloomThreshold: 1.02,
    environmentIntensity: 0.64, fallbackEnvironmentIntensity: 0.60,
    hemiIntensity: 0.72, hemiGround: 0x30363a, sunIntensity: 0.82,
    ambientColor: 0xc0d6ee, ambientIntensity: 0.52,
  }),
  nightLusail: Object.freeze({
    exposure: 0.86,
    bloomStrength: 0.14, bloomRadius: 0.18, bloomThreshold: 1.04,
    environmentIntensity: 0.30, fallbackEnvironmentIntensity: 0.26,
    hemiIntensity: 0.30, hemiGround: 0x11110f, sunIntensity: 0.92,
    ambientColor: 0x746b5e, ambientIntensity: 0.20,
  }),
  nightLasvegas: Object.freeze({
    exposure: 0.96,
    bloomStrength: 0.08, bloomRadius: 0.10, bloomThreshold: 1.10,
    environmentIntensity: 0.42, fallbackEnvironmentIntensity: 0.38,
    hemiIntensity: 0.40, hemiGround: 0x292128, sunIntensity: 0.72,
    ambientColor: 0x826579, ambientIntensity: 0.28,
  }),
});

// ---- final "film" pass ------------------------------------------------------
// One full-screen pass after OutputPass + FXAA, so it grades display-referred
// colour and its grain is not smeared by the anti-aliasing filter. RENDER_LOOK
// stays the pinned exposure/bloom contract; this layers the grade on top.
// Rows: contrast, saturation, vignette, chromatic aberration, grain, tint rgb.
// `speed` (0..1) is a radial blur toward the frame centre; `wx` (0..1) is the
// overcast/rain grade. `seed` only advances while the simulation runs, so a
// paused or frozen frame is bit-stable.
const FILM_LOOK = {
  day: [0.20, 1.10, 0.20, 0.0030, 0.016, 1.0, 1.0, 1.0],
  dusk: [0.24, 1.12, 0.26, 0.0034, 0.020, 1.03, 1.0, 0.95],
  night: [0.14, 1.06, 0.30, 0.0030, 0.026, 0.98, 1.0, 1.03],
};
const FILM_SHADER = {
  uniforms: {
    tDiffuse: { value: null }, g: { value: new THREE.Vector4() }, tint: { value: new THREE.Vector3(1, 1, 1) },
    speed: { value: 0 }, grain: { value: 0 }, seed: { value: 0 }, wx: { value: 0 },
  },
  vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: `uniform sampler2D tDiffuse;uniform vec4 g;uniform vec3 tint;uniform float speed,grain,seed,wx;varying vec2 vUv;
void main(){
  vec2 c=vUv-.5;float r2=dot(c,c);
  vec3 col=texture2D(tDiffuse,vUv).rgb;
  float n=fract(sin(dot(gl_FragCoord.xy+seed*17.,vec2(12.9898,78.233)))*43758.5453);
  if(speed>.004){
    vec2 d=c*(speed*.052*smoothstep(.035,.34,r2));
    vec2 u=vUv-d*(n*.2);
    col=(texture2D(tDiffuse,u).rgb+texture2D(tDiffuse,u-d*.2).rgb+texture2D(tDiffuse,u-d*.4).rgb+texture2D(tDiffuse,u-d*.6).rgb+texture2D(tDiffuse,u-d*.8).rgb)*.2;
  }
  vec2 ca=c*r2*g.w;
  col.r+=texture2D(tDiffuse,vUv+ca).r-texture2D(tDiffuse,vUv).r;
  col.b+=texture2D(tDiffuse,vUv-ca).b-texture2D(tDiffuse,vUv).b;
  col=clamp(col,0.,1.);
  col=mix(col,col*col*(3.-2.*col),g.x);
  float l=dot(col,vec3(.2126,.7152,.0722));
  col=mix(vec3(l),col,g.y)*tint;
  col=mix(col,vec3(l)*vec3(.93,.98,1.05),wx*.42)*(1.-.07*wx);
  col*=1.-g.z*smoothstep(.10,.56,r2);
  col+=(n-.5)*grain*(1.-.6*l);
  gl_FragColor=vec4(col,1.);
}`,
};
// Scenery large and cheap enough to rasterise into the sun's shadow map, and
// the surfaces that should show those shadows. Alpha-tested cards cast a
// correct cut-out because WebGLShadowMap carries map + alphaTest into depth.
// Matched on the mesh's own name, so unnamed detail (the TV screen's lattice
// members, lamp bezels) stays out, as do the six-material brake boards: a
// sub-texel shadow is not worth six draw calls a board.
const SHADOW_CASTERS = /^(pit-(body|garage-(shells|piers)|upper-hospitality|roof-coping|wall-face)|grandstand-(base|seating|frame)|gantry|footbridge|tv-(cabinet|back-panel|support-beam)|team-pit-stand-(bodies|roofs)|infra-(paddock-(building|vehicle|tents)|spectator-banks|camping|parked)|hoardings|wall-|trees-|vegetation-near|venue-near|floodlight-poles)/;
const SHADOW_RECEIVERS = /^(kerbs|gravel-traps|edge-line|grid-boxes|sf-line|pit-(stop-boxes|lane-|exit-|entry-|wall-face)|hoardings|wall-|infra-(surface|access|parking|paddock-aprons)|grandstand-(base|seating)|pit-(body|garage-shells))/;
const _lookV = new THREE.Vector3(), _lookC = new THREE.Color();
// Sky shadowing. The venues' sun:ambient ratios are pinned low (IBL + two
// hemispheres carry most of the light), so a shadow that only removes the
// direct term is barely visible. A surface inside the sun's shadow of a stand
// or treeline also sees less sky, so the shadow-casting directional light's
// visibility additionally scales indirect diffuse and specular. The strength
// (0..1) rides in that light's `shadow.radius` as 1 + strength: the renderer
// uses PCFSoftShadowMap, which never reads radius, and a light left at the
// default radius of 1 gets none. Surfaces with receiveShadow = false are
// untouched. The map's outer band also fades to unshadowed, so the edge of
// the frustum is never a hard line sweeping over the ground ahead.
{
  const C = THREE.ShaderChunk;
  C.lights_fragment_begin = 'float sunShade = 1.0;\n' + C.lights_fragment_begin.replace(
    'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap',
    'sunShade = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap',
  ).replace('vDirectionalShadowCoord[ i ] ) : 1.0;',
    'vDirectionalShadowCoord[ i ] ) : 1.0;\n'
    + '\t\tsunShade = mix( sunShade, 1.0, smoothstep( 0.42, 0.5, max( abs( vDirectionalShadowCoord[ i ].x - 0.5 ), abs( vDirectionalShadowCoord[ i ].y - 0.5 ) ) ) );\n'
    + '\t\tdirectLight.color *= sunShade;\n'
    // A receiver turned away from the sun is in its own shade whether or not
    // the map reaches it, so shaded sides read the same inside and outside the
    // frustum and the map's noise at the terminator never reaches the fill.
    + '\t\tif ( receiveShadow ) sunShade = min( sunShade, smoothstep( 0.0, 0.3, dot( geometryNormal, directLight.direction ) ) );\n'
    + '\t\tsunShade = 1.0 - clamp( directionalLightShadow.shadowRadius - 1.0, 0.0, 1.0 ) * ( 1.0 - sunShade );');
  C.lights_fragment_end = '#if defined( RE_IndirectDiffuse )\n\tirradiance *= sunShade;\n\tiblIrradiance *= sunShade;\n#endif\n'
    + '#if defined( RE_IndirectSpecular )\n\tradiance *= sunShade;\n#endif\n' + C.lights_fragment_end;
  // Aerial perspective: colour drains out of scenery well before linear fog
  // closes over it. Scaled by fog brightness, so black night fog adds none.
  C.fog_fragment = C.fog_fragment.replace('gl_FragColor.rgb = mix(',
    '#ifndef FOG_EXP2\n\tgl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) ),'
    + ' 0.4 * smoothstep( fogNear * 0.15, fogFar * 0.7, vFogDepth ) * min( 1.0, dot( fogColor, vec3( 0.5 ) ) ) );\n#endif\n\tgl_FragColor.rgb = mix(');
}

function renderLookKeyForTrack(trackId, environmentKey) {
  const night = {
    jeddah: 'nightJeddah', singapore: 'nightSingapore',
    lusail: 'nightLusail', qatar: 'nightLusail', lasvegas: 'nightLasvegas',
  }[trackId];
  return night || environmentKey;
}

function showGraphicsUnavailable() {
  const screen = document.getElementById('screen-boot');
  const inner = screen?.querySelector('.boot-inner');
  if (!screen || !inner) return;
  screen.className = 'screen active';
  inner.innerHTML = `
    <div id="graphics-unavailable" role="alert" aria-live="assertive">
      <div class="boot-logo">APEX<span>FORMULA</span></div>
      <div class="boot-sub">GRAPHICS COULD NOT START</div>
      <p style="max-width:520px;margin:28px auto 22px;color:#aeb4bd;line-height:1.7;letter-spacing:.04em">
        This simulator needs WebGL. Enable hardware acceleration or update your browser, then try again.
      </p>
      <button type="button" class="f1-btn" id="retry-graphics"><span>RETRY GRAPHICS</span></button>
    </div>`;
  const retry = document.getElementById('retry-graphics');
  retry?.addEventListener('click', () => location.reload());
  retry?.focus();
}

class Game {
  constructor() {
    this.state = 'boot';
    // The live scene always resolves through the composer and its final FXAA
    // pass. Native MSAA would only allocate extra samples for the default
    // framebuffer, which the composer does not render the scene into.
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    } catch {
      this.renderer = null;
      showGraphicsUnavailable();
      return;
    }
    // A logical game frame contains many renderer.render() calls across GTAO,
    // bloom, output and FXAA. Reset once around the whole pipeline so info is a
    // bounded per-frame aggregate instead of only describing the final pass.
    this.renderer.info.autoReset = false;
    // Start conservatively; QualityController selects the persisted/automatic
    // tier immediately after UI settings are available.
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = RENDER_LOOK.day.exposure;
    document.getElementById('app').appendChild(this.renderer.domElement);

    this.scene = null;
    this.circuit = null;
    this.session = null;
    this.camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.3, 6500);
    this.camMode = 0; // 0 chase, 1 seated cockpit, 2 T-cam, 3 nose
    this._camPos = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this._camForward = new THREE.Vector3();
    this._camAhead = new THREE.Vector3();
    this._camLeft = new THREE.Vector3();
    this._camPlayerPos = new THREE.Vector3();
    this._camTargetPos = new THREE.Vector3();
    this._camTargetLook = new THREE.Vector3();
    this._camFraming = { back: 0, height: 0, look: 0, fov: 0 };

    this.hud = new HUD(document.getElementById('hud'));
    this.hud.cockpit.onPage = () => this.hud.nextCockpitPage();
    this.hud.cockpit.onExport = () => this.exportGhostReplay();
    this.audio = new AudioEngine();
    this.champ = new Championship();
    this.wheelInput = new WheelInputManager();
    this.ui = new UI((action, payload) => this.onUI(action, payload), this.wheelInput);
    this.quality = new QualityController(this.renderer, (tier, automatic) => {
      this.effects?.setQualityTier?.(tier);
      if (this.session) this.hud.message(`GRAPHICS: ${tier.toUpperCase()}${automatic ? ' · AUTO' : ''}`);
    });
    this.quality.setMode(this.ui.settings.graphicsQuality);

    this.keys = {};
    this.keySteer = 0;
    this._steerInputMode = null;
    this.paused = false;
    this.awaitingStart = false;
    this.raceConfig = null;
    this.clock = new THREE.Clock();
    this.fixedStep = new FixedStepAccumulator();
    this.pacing = { steps: 0, simulatedDt: 0, alpha: 0, droppedDt: 0 };
    this._shiftQueue = [];
    this._gamepadShiftUp = false;
    this._gamepadShiftDown = false;
    this._gamepadNeedsNeutral = true;
    this._gamepadSteeringActive = false;
    this._wheelNeedsNeutral = true;
    this._wheelSteeringActive = false;
    this._wheelState = null;
    this.pitLimiter = false;
    this._timeTrialStatus = null;
    this._lightsShown = 0;
    this._resultsShown = false;
    this._sessionGeneration = 0;
    this._sessionBuildTimer = null;
    this.onboardingActive = false;
    this._celestialObjects = [];
    this._frameTelemetry = { count: 0, lastMs: 0, smoothedMs: 0, maxMs: 0 };
    this._renderTelemetry = { calls: 0, triangles: 0, points: 0, lines: 0 };
    this._graphicsContextLost = false;
    this._graphicsContextLosses = 0;
    this._graphicsContextRestores = 0;
    this._wasPausedBeforeContextLoss = null;
    this._simStatusTimer = 0;
    this._audioNearbyEntries = [null, null, null, null];
    this._audioNearbyDistances = [Infinity, Infinity, Infinity, Infinity];
    this._audioOpponentCuePool = Array.from({ length: 4 }, () => ({
      id: '', side: 0, distance: 0, relativeSpeed: 0, rpmFrac: 0, intensity: 0,
    }));
    this._audioOpponentCues = [];
    this._trackGripOptions = {};
    this._trackGripResult = { surface: {} };
    this._trackConditionsSource = null;
    this._trackConditionsTime = -1;

    // ---- private multiplayer ----
    // `netHandle` owns the peer connections; `net` is the MultiplayerSession
    // the race loop pumps. Both are null in every single-player session.
    try { this._simOnly = new URLSearchParams(location.search).has('simOnly'); }
    catch { this._simOnly = false; }
    this.net = null;
    this.netHandle = null;
    this._netLobby = null;
    this._netEvent = null;
    this._netPumps = null;
    this._netClosing = false;
    this._netResultsPublished = false;

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.quality.resize(innerWidth, innerHeight);
    });
    addEventListener('keydown', e => this.onKey(e, true));
    addEventListener('keyup', e => this.onKey(e, false));
    // audio unlock on first gesture
    const unlock = () => {
      this.audio.init();
      this.audio.setVolume(this.ui.settings.volume);
      // A Retry reload can restore a live session before this new document has
      // received an autoplay-unlocking gesture. Start its engine on that first
      // gesture instead of leaving the recovered race permanently silent.
      if ((this.state === 'race' || this.state === 'quali') && !this.paused && documentIsActive()) {
        this.audio.startEngine();
      }
      removeEventListener('pointerdown', unlock);
      removeEventListener('keydown', unlock);
    };
    addEventListener('pointerdown', unlock);
    addEventListener('keydown', unlock);
    document.addEventListener('visibilitychange', () => {
      // Never let time spent hidden become simulation catch-up work.
      this.resetSimulationTiming();
      if (document.hidden) {
        if (this.autoPauseEnabled() && this.state === 'loading') this._pauseOnReady = true;
        this.audio.stopEngine();
        if (this.autoPauseEnabled() && (this.state === 'race' || this.state === 'quali') && !this.paused) {
          this.togglePause(true);
        }
      }
      else {
        if (documentIsActive()) this._pauseOnReady = false;
        if ((this.state === 'race' || this.state === 'quali') && !this.paused && documentIsActive()) {
          this.audio.startEngine();
        }
      }
    });
    addEventListener('blur', () => {
      // Key-up/pointer-up can be lost when focus leaves the window. Never let
      // that turn into a stuck throttle, brake, steer, or boost input.
      this.releaseDrivingInputs();
      this.audio.stopEngine();
      if (this.autoPauseEnabled() && this.state === 'loading') this._pauseOnReady = true;
      if (this.autoPauseEnabled() && (this.state === 'race' || this.state === 'quali') && !this.paused) {
        this.togglePause(true);
      }
    });
    addEventListener('focus', () => {
      this.resetSimulationTiming();
      if (documentIsActive()) this._pauseOnReady = false;
      if ((this.state === 'race' || this.state === 'quali') && !this.paused && documentIsActive()) {
        this.audio.startEngine();
      }
    });
    this.renderer.domElement.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this._graphicsContextLost = true;
      this._graphicsContextLosses++;
      const driving = this.state === 'race' || this.state === 'quali';
      this._wasPausedBeforeContextLoss = driving ? this.paused : null;
      if (driving && !this.paused) this.togglePause(true);
      this.showGraphicsRecovery('GRAPHICS RESET DETECTED', 'Restoring the renderer…');
    });
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this._graphicsContextLost = false;
      this._graphicsContextRestores++;
      // Three preserves this flag internally, but reassert the aggregate mode
      // and the active venue look so recovery remains correct if renderer
      // internals change.
      this.renderer.info.autoReset = false;
      this.renderer.toneMappingExposure = RENDER_LOOK[this._renderLookKey || 'day'].exposure;
      this.quality.apply(true);
      this.showGraphicsRecovery('', '');
      if (this.session) this.hud.message('GRAPHICS RESTORED');
      const shouldResume = this._wasPausedBeforeContextLoss === false &&
        (this.state === 'race' || this.state === 'quali') && documentIsActive();
      this._wasPausedBeforeContextLoss = null;
      if (shouldResume && this.paused) this.togglePause(false);
    });

    this.boot();
    this.loop();
  }

  showGraphicsRecovery(title, detail) {
    let el = document.getElementById('graphics-recovery');
    if (!title) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'graphics-recovery';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'assertive');
      Object.assign(el.style, {
        position: 'fixed', inset: '0', zIndex: '10000', display: 'grid', placeContent: 'center',
        textAlign: 'center', color: '#fff', background: '#050608ee', fontFamily: 'Arial, sans-serif',
        letterSpacing: '.12em', textTransform: 'uppercase',
      });
      document.body.appendChild(el);
    }
    el.innerHTML = `<strong style="font-size:clamp(18px,3vw,34px)">${title}</strong><span style="margin-top:12px;color:#aeb4bd;font-size:12px">${detail}</span>`;
  }

  snapshot() {
    const session = this.session;
    const entry = session?.player;
    const physics = entry?.phys;
    const trackState = this.circuit?.trackState;
    const visual = trackState?.visualState || {};
    const weatherState = this.circuit?.weather?.current || {};
    const wetness = Number.isFinite(visual.wetness) ? visual.wetness : (physics?.surface?.wetness || 0);
    const damage = entry?.damage || {};
    const frontWingDamage = Number.isFinite(damage.frontWing)
      ? 1 - damage.frontWing : (entry?.wingDamage || 0);
    const strategy = entry?.strategyDecision || {};
    const telemetry = createTelemetrySnapshot(physics, {
      lap: entry?.lap,
      delta: this._timeTrialStatus?.delta,
    });
    telemetry.visible = this.camMode === 1 && !!this.hud?.cockpit?.active;
    const tier = this.quality?.appliedTier || this.quality?.tier || 'medium';
    const mobile = typeof innerWidth === 'number' && innerWidth <= 700;
    const cameraMode = ['chase', 'cockpit', 't-cam', 'nose'][this.camMode] || 'chase';
    const round = (value, places = 4) => Number.isFinite(value)
      ? Number(value.toFixed(places)) : 0;
    return {
      state: this.state,
      paused: !!this.paused,
      awaitingStart: !!this.awaitingStart,
      player: {
        driverId: entry?.driver?.id || null,
        teamId: entry?.team?.id || entry?.driver?.team || null,
        physics: telemetry,
      },
      track: {
        id: this.circuit?.id || this.raceConfig?.race?.trackId || null,
        name: this.circuit?.publicName || this.raceConfig?.race?.circuitName || this.circuit?.def?.name || null,
        state: {
          surface: wetness >= 0.15 ? 'wet' : 'dry',
          wetness: round(wetness, 3),
          puddling: round(visual.puddling, 3),
          rubber: round(visual.rubber, 3),
        },
      },
      controls: {
        throttle: this.paused || this.awaitingStart ? 0 : round(physics?.throttle),
        brake: this.paused || this.awaitingStart ? 0 : round(physics?.brake),
        steer: this.paused || this.awaitingStart ? 0 : round(this.keySteer),
      },
      camera: { mode: cameraMode },
      telemetry,
      weather: {
        condition: weatherState.condition || (weatherState.raining ? 'rain' : 'clear'),
        intensity: round(weatherState.intensity ?? ((weatherState.rainfall || 0) / 18), 3),
        rainfall: round(weatherState.rainfall, 3),
      },
      raceControl: { state: session?.raceControl?.state || (session?.vsc?.active ? 'vsc' : 'green') },
      damage: { frontWing: round(frontWingDamage, 3), severity: round(frontWingDamage, 3) },
      strategy: {
        recommendation: strategy.recommendation || (strategy.shouldPit ? 'pit-now' : 'stay-out'),
        compound: strategy.compound || strategy.nextCompound || entry?.strategyCompound || physics?.compound || 'M',
      },
      quality: {
        adaptive: this.quality?.mode === 'auto',
        profile: `${mobile ? 'mobile' : 'desktop'}-${tier}`,
      },
    };
  }

  // Offline authored-race adapter. Every field is applied to the production
  // track, race-control, damage and strategy models before the resulting state
  // is observed; no parallel test-only simulation is maintained.
  applyScenario(scenario = {}) {
    const session = this.session;
    const entry = session?.player;
    const track = this.circuit?.trackState;
    const weather = scenario.weather || {};
    const trackScenario = scenario.track || {};
    const condition = String(weather.condition || '').toLowerCase();
    const surface = String(trackScenario.surface || '').toLowerCase();
    const clearEnvironment = scenario.environment?.clear === true ||
      condition === 'dynamic' || surface === 'dynamic';
    const hasEnvironmentScenario = clearEnvironment || condition || surface ||
      Number.isFinite(weather.intensity) || Number.isFinite(weather.rainfall) ||
      Number.isFinite(weather.cloudCover) || Number.isFinite(trackScenario.wetness) ||
      Number.isFinite(trackScenario.puddling) || Number.isFinite(trackScenario.temperature);
    if (clearEnvironment) track?.clearConditions?.();
    else if (hasEnvironmentScenario) {
      let intensity = Number.isFinite(weather.intensity) ? weather.intensity : undefined;
      if (!Number.isFinite(intensity) && condition === 'rain') intensity = 0.5;
      else if (!Number.isFinite(intensity) && (condition === 'clear' || condition === 'overcast')) intensity = 0;
      let wetness = Number.isFinite(trackScenario.wetness) ? trackScenario.wetness : undefined;
      if (!Number.isFinite(wetness) && surface === 'wet') wetness = 0.6;
      else if (!Number.isFinite(wetness) && surface === 'dry') wetness = 0;
      const rainfall = Number.isFinite(weather.rainfall)
        ? weather.rainfall : (Number.isFinite(intensity) ? intensity * 18 : undefined);
      const cloudCover = Number.isFinite(weather.cloudCover) ? weather.cloudCover
        : condition === 'rain' ? Math.max(0.78, intensity || 0)
          : condition === 'overcast' ? 0.82 : condition === 'clear' ? 0.18 : undefined;
      track?.setConditions?.({
        wetness,
        puddling: trackScenario.puddling,
        temperature: trackScenario.temperature,
        rubber: trackScenario.rubber,
        dust: trackScenario.dust,
        intensity,
        rainfall,
        cloudCover,
        airTemperature: weather.airTemperature,
        humidity: weather.humidity,
        windSpeed: weather.windSpeed,
        windDirection: weather.windDirection,
        locked: scenario.environment?.locked !== false,
      });
    }
    if (hasEnvironmentScenario && session?.setTrackConditions) {
      const visual = track?.visualState;
      session.setTrackConditions({
        wetness: visual?.wetness,
        trackGrip: this.circuit?.gripAt?.(
          entry?.phys?.sampleIdx || 0,
          entry?.phys?.lat || 0,
          this._trackGripOptions,
          this._trackGripResult,
        )?.multiplier,
        rainfall: this.circuit?.weather?.current?.rainfall,
      });
      this._trackConditionsSource = track || null;
      this._trackConditionsTime = track?.time ?? -1;
    }
    const requestedControl = scenario.raceControl?.state;
    if (requestedControl === 'green') session?.resumeRace?.({ immediate: true });
    else if (requestedControl && session?.raceControl?.state !== requestedControl) {
      session?.requestRaceControl?.(requestedControl, { duration: 90, reason: 'authored-scenario' });
    }
    if (entry?.damage && scenario.damage?.component === 'frontWing') {
      const severity = Math.max(0, Math.min(1, Number(scenario.damage.severity) || 0));
      entry.damage.frontWing = 1 - severity;
      entry.wingDamage = severity;
    }
    if (entry && scenario.strategy) {
      entry.strategyDecision = {
        ...(entry.strategyDecision || {}),
        recommendation: scenario.strategy.recommendation || 'stay-out',
        shouldPit: scenario.strategy.recommendation === 'pit-now',
        compound: scenario.strategy.compound || entry.strategyCompound || 'M',
        nextCompound: scenario.strategy.compound || entry.strategyCompound || 'M',
      };
    }
    const result = this.snapshot();
    this.hud?.updateSimulationState?.(result);
    return result;
  }

  get renderTelemetry() {
    const composerTarget = this.composer?.renderTarget1;
    const gtaoTarget = this.gtao?.gtaoRenderTarget;
    const fxaaResolution = this.fxaa?.uniforms?.resolution?.value;
    return {
      frame: { ...this._frameTelemetry },
      quality: {
        mode: this.quality.mode,
        tier: this.quality.appliedTier,
        pixelRatio: this.renderer.getPixelRatio(),
        composerPixelRatio: this.composer?._pixelRatio ?? null,
      },
      targets: {
        drawingBuffer: {
          width: this.renderer.domElement.width,
          height: this.renderer.domElement.height,
        },
        composer: composerTarget ? { width: composerTarget.width, height: composerTarget.height } : null,
        gtao: gtaoTarget ? {
          width: gtaoTarget.width,
          height: gtaoTarget.height,
          scale: this.gtao.resolutionScale,
        } : null,
      },
      passes: {
        gtao: !!this.gtao?.enabled,
        bloom: !!this.bloom?.enabled,
        fxaa: !!this.fxaa?.enabled,
        fxaaResolution: fxaaResolution ? { x: fxaaResolution.x, y: fxaaResolution.y } : null,
      },
      renderer: {
        ...this._renderTelemetry,
        autoReset: this.renderer.info.autoReset,
        textures: this.renderer.info.memory.textures,
        geometries: this.renderer.info.memory.geometries,
      },
      carLod: this.session?.carLodTelemetry ?? null,
      context: {
        lost: this._graphicsContextLost,
        losses: this._graphicsContextLosses,
        restores: this._graphicsContextRestores,
      },
    };
  }

  // ---------- boot ----------
  async boot() {
    const bar = document.getElementById('boot-progress');
    const status = document.getElementById('boot-status');
    // Track photography, the GLB, and the selected HDR are deferred until the
    // player chooses a venue. The menu is fully interactive without them.
    status.textContent = 'INITIALIZING AUDIO…';
    bar.style.width = '72%';
    // Whether the public entries exist at all. Started here so it overlaps the
    // rest of boot rather than delaying the title screen: resolving it costs a
    // module fetch, and the menu behind that screen must not wait on one.
    const publicReady = loadBackend()
      .then(backend => { this.ui.publicEnabled = backend.available(); })
      .catch(() => { this.ui.publicEnabled = false; });
    // The published build intentionally ships only the synthesized WebAudio
    // engine. Avoid probing every optional MP3 (and generating a burst of 404s)
    // unless a local sample-pack user explicitly opts in.
    const sampleAudio = new URLSearchParams(location.search).get('sampleAudio') === '1';
    if (sampleAudio && this.audio.loadSamplePack) {
      await this.audio.loadSamplePack('sounds/').catch(() => {});
    }
    bar.style.width = '94%';
    status.textContent = 'VERIFYING 2026 ENTRY LIST — 11 TEAMS · 22 DRIVERS';
    await sleep(80);
    status.textContent = 'READY';
    bar.style.width = '100%';
    await sleep(120);
    const retryConfig = this.consumeRetrySession();
    if (retryConfig) {
      this.startSession(retryConfig);
      return;
    }
    // A friend's invite link boots straight into the join flow, with the code
    // already filled in — the link is the whole handover.
    if (INVITE_IN_URL.test(location.hash) || INVITE_IN_URL.test(location.search)) {
      const { readInviteCode } = await this.netModule();
      const invite = readInviteCode(location.hash) || readInviteCode(location.search);
      if (invite) {
        this.state = 'multiplayer';
        this.openJoinScreen(invite);
        return;
      }
    }
    await publicReady;

    // First stop is the title screen, not the menu. A retry session and an
    // invite link both bypass it above — one is a recovery, the other is a
    // handover that already knows where the player is going.
    this.state = 'landing';
    this.ui.showLanding(this.champ);
  }

  consumeRetrySession() {
    let saved = null;
    try {
      const raw = sessionStorage.getItem(RETRY_SESSION_KEY);
      sessionStorage.removeItem(RETRY_SESSION_KEY); // one shot: never reload-loop
      if (raw) saved = JSON.parse(raw);
    } catch {}
    if (!saved || typeof saved !== 'object') return null;
    const race = CALENDAR.find(item => item.trackId === saved.trackId);
    if (!race || !DRIVERS.some(driver => driver.id === saved.driverId)) return null;
    if (!['race', 'quali', 'practice'].includes(saved.mode)) return null;
    const driverIds = new Set(DRIVERS.map(driver => driver.id));
    const gridOrder = Array.isArray(saved.gridOrder) &&
      saved.gridOrder.length === DRIVERS.length &&
      new Set(saved.gridOrder).size === DRIVERS.length &&
      saved.gridOrder.every(id => driverIds.has(id))
      ? saved.gridOrder : null;
    return {
      race,
      driverId: saved.driverId,
      mode: saved.mode,
      trial: saved.trial === true,
      pilot: saved.pilot === true,
      fullWeekend: saved.fullWeekend === true,
      weekendSeed: Number.isInteger(saved.weekendSeed) ? saved.weekendSeed : undefined,
      qualiStage: typeof saved.qualiStage === 'string' ? saved.qualiStage : undefined,
      qualiFormat: typeof saved.qualiFormat === 'string' ? saved.qualiFormat : undefined,
      formationLap: saved.formationLap === true,
      champRound: saved.champRound === true,
      gridOrder,
      seed: Number.isInteger(saved.seed) ? saved.seed : undefined,
    };
  }

  reloadForSessionRetry() {
    const cfg = this.raceConfig;
    if (cfg?.race?.trackId && cfg.driverId) {
      try {
        sessionStorage.setItem(RETRY_SESSION_KEY, JSON.stringify({
          trackId: cfg.race.trackId,
          driverId: cfg.driverId,
          mode: cfg.mode,
          trial: cfg.trial === true,
          pilot: cfg.pilot === true,
          fullWeekend: cfg.fullWeekend === true,
          weekendSeed: cfg.weekendSeed,
          qualiStage: cfg.qualiStage,
          qualiFormat: cfg.qualiFormat,
          formationLap: cfg.formationLap === true,
          champRound: cfg.champRound === true,
          gridOrder: cfg.gridOrder || null,
          seed: cfg.seed,
        }));
      } catch {}
    }
    // Failed module imports are cached for the lifetime of this document. A
    // reload is the only standards-compliant retry without cache-busting URLs.
    location.reload();
  }

  // ---------- UI events ----------
  onUI(action, payload) {
    this.audio.uiClick && this.audio.uiClick();
    switch (action) {
      case 'enterMenu':
        this.state = 'menu';
        this.ui.showMain(this.champ);
        break;
      case 'menu':
        if (payload === 'pilot') {
          const race = CALENDAR.find(r => r.trackId === 'spa');
          const driverId = DRIVERS.find(d => d.id === 'hacker' && d.team === 'tacn')?.id
            || DRIVERS.find(d => d.team === 'tacn')?.id;
          if (!race || !driverId) break;
          this.ui.sel.mode = 'weekend';
          this.ui.sel.driverId = driverId;
          this.ui.sel.trackId = 'spa';
          this.startSession({
            race, driverId, mode: 'practice', pilot: true, fullWeekend: true,
            qualiStage: 'FP1', qualiFormat: 'staged',
          });
        }
        else if (payload === 'raceNow') {
          const last = this.ui.lastSelection;
          const race = last && CALENDAR.find(r => r.trackId === last.trackId);
          if (race && last.driverId) this.startSession({ race, driverId: last.driverId, mode: 'race' });
        }
        else if (payload === 'quick') { this.state = 'team'; this.ui.showTeamSelect('quick'); }
        else if (payload === 'trial') { this.state = 'team'; this.ui.showTeamSelect('trial'); }
        else if (payload === 'champ') {
          if (this.champ.active) this.startChampRace();
          else { this.state = 'team'; this.ui.showTeamSelect('champ'); }
        }
        else if (payload === 'standings') { this.state = 'standings'; this.ui.showStandings(this.champ, true); }
        else if (payload === 'settings') { this.state = 'settings'; this.ui.showSettings('main'); }
        else if (payload === 'multiplayer') this.openMultiplayerHub();
        else if (payload === 'leaderboard') this.openLeaderboard();
        else if (payload === 'controls') { this.state = 'controls'; this.ui.showControls('main'); }
        break;
      case 'mpHub':
        this.closeNet('left');
        this.openMultiplayerHub();
        break;
      case 'mpHostSetup':
        this.state = 'multiplayer';
        this.ui.showMultiplayerHostSetup();
        break;
      case 'mpHostCreate':
        // One setup screen serves both kinds of race; which one it opens is
        // decided by the door the player came through.
        if (this._hostPublic) { this._hostPublic = false; this.hostPublicRace(payload); }
        else this.hostPrivateRace(payload);
        break;
      case 'mpHostAccept':
        this.acceptGuestReply(payload?.code || '');
        break;
      case 'mpStart':
        this.startNetworkRaceAsHost();
        break;
      case 'mpJoinSetup':
        this.openJoinScreen('');
        break;
      case 'mpBrowse':
        this.browsePublicRooms();
        break;
      case 'mpQuickMatch':
        this.quickMatchPublicRace();
        break;
      case 'mpHostPublicSetup':
        // A public race is listed under your name, so the name comes first.
        // Browsing needs none — looking is anonymous, joining is not.
        this.openPublicHostSetup();
        break;
      case 'mpJoinPublic':
        this.joinPublicRace(payload?.roomId || '');
        break;
      case 'mpRegisterHandle':
        this.registerPublicHandle(payload?.handle || '');
        break;
      case 'mpClaimHandle':
        this.claimPublicHandle(payload?.handle || '', payload?.claimCode || '');
        break;
      case 'mpHandleDone':
        this.finishHandleSetup();
        break;
      case 'mpLeaderboard':
        this.openLeaderboard(payload?.trackId || null);
        break;
      case 'mpSubmitBest':
        this.submitStoredBest(payload?.trackId);
        break;
      case 'mpLeaderboardDrive':
        this.ui.mpSetup.trackId = payload?.trackId || this.ui.mpSetup.trackId;
        this.startTimeTrialFromLeaderboard(payload?.trackId);
        break;
      case 'mpRaceGhost':
        this.raceRivalGhost(payload?.trackId, payload?.playerId);
        break;
      case 'mpJoinPreview':
        this.previewJoinCode(payload?.code || '');
        break;
      case 'mpJoin':
        this.joinPrivateRace(payload?.code || '', payload?.driverId);
        break;
      case 'mpLeave':
        this.closeNet('left');
        this.teardownSession();
        this.state = 'menu';
        this.ui.showMain(this.champ);
        break;
      case 'teamChosen':
        if (payload.mode === 'champ') {
          this.champ.startNew(payload.driverId);
          this.startChampRace();
        } else {
          this.state = 'track';
          this.ui.showTrackSelect();
        }
        break;
      case 'trackChosen': {
        const race = CALENDAR.find(r => r.trackId === payload.trackId);
        if (payload.mode === 'trial') {
          this.startSession({ race, driverId: payload.driverId, mode: 'quali', trial: true });
        } else if (this.ui.settings.quali) {
          this.startSession({ race, driverId: payload.driverId, mode: 'quali' });
        } else {
          this.startSession({ race, driverId: payload.driverId, mode: 'race' });
        }
        break;
      }
      case 'startRaceAfterQuali': {
        const grid = this.session.qualiClassification().map(r => r.driverId);
        const cfg = this.raceConfig;
        this.startSession({
          race: cfg.race, driverId: cfg.driverId, mode: 'race', gridOrder: grid,
          champRound: cfg.champRound, seed: cfg.seed,
        });
        break;
      }
      case 'startPilotQualifying': {
        const cfg = this.raceConfig;
        if (!cfg?.fullWeekend) break;
        const weekendSeed = cfg.weekendSeed ?? cfg.seed;
        this.startSession({
          race: cfg.race,
          driverId: cfg.driverId,
          mode: 'quali',
          pilot: true,
          fullWeekend: true,
          weekendSeed,
          qualiStage: 'Q1',
          qualiFormat: 'staged',
          seed: deriveSeed(weekendSeed, 'qualifying'),
        });
        break;
      }
      case 'advancePilotQualifying': {
        const cfg = this.raceConfig;
        const session = this.session;
        if (!cfg?.fullWeekend || session?.mode !== 'quali') break;
        const advanced = session.advanceQualifyingStage();
        if (!advanced) break;
        if (advanced.stage === 'done') {
          const gridOrder = advanced.classification.map(row => row.driverId);
          const weekendSeed = cfg.weekendSeed ?? cfg.seed;
          this.startSession({
            race: cfg.race,
            driverId: cfg.driverId,
            mode: 'race',
            pilot: true,
            fullWeekend: true,
            weekendSeed,
            formationLap: true,
            gridOrder,
            seed: deriveSeed(weekendSeed, 'race'),
          });
          break;
        }
        this._qualiDoneShown = false;
        this.state = 'quali';
        this.ui.hideAll();
        this.hud.show();
        this.camMode = advanced.playerActive ? 0 : 2;
        this.updateTouchControls();
        this.snapCamera();
        this.resetSimulationTiming();
        if (documentIsActive()) this.audio.startEngine();
        break;
      }
      case 'restartRace':
        // A private race cannot be re-run from one side: the grid, the seed and
        // the connection all belong to the lobby that created them.
        if (this.raceConfig?.multiplayer) {
          this.closeNet('left');
          this.openMultiplayerHub('That race is over. Open a new one to race again.');
          break;
        }
        this.startSession(this.raceConfig);
        break;
      case 'retryLoad':
        this.reloadForSessionRetry();
        break;
      case 'afterRaceChamp':
        this.teardownSession();
        this.state = 'standings';
        this.ui.showStandings(this.champ, true);
        break;
      case 'champNextRace':
        this.startChampRace();
        break;
      case 'abandonSeason':
        this.teardownSession();
        this.champ.abandon();
        this.state = 'menu';
        this.ui.showMain(this.champ);
        break;
      case 'champNew':
        this.state = 'team';
        this.ui.showTeamSelect('champ');
        break;
      case 'uiclick':
        break;
      case 'settingsChanged':
        this.audio.setVolume(payload.volume);
        if (this.session) this.session.setNametags(payload.nametags);
        this.quality.setMode(payload.graphicsQuality);
        this.updateTouchControls();
        break;
      case 'back':
        this.teardownSession();
        this.closeNet('left');
        this.state = payload === 'team' ? 'team' : payload === 'main' ? 'menu' : payload;
        if (payload === 'main') this.ui.showMain(this.champ);
        else if (payload === 'team') this.ui.showTeamSelect(this.ui.sel.mode);
        break;
      case 'pause':
        if (payload === 'resume') this.togglePause(false);
        else if (payload === 'restart') {
          this.togglePause(false);
          if (this.raceConfig?.multiplayer) {
            this.closeNet('left');
            this.teardownSession();
            this.openMultiplayerHub('A private race cannot be restarted. Open a new one to race again.');
            break;
          }
          this.startSession(this.raceConfig);
        }
        else if (payload === 'quit') {
          this.togglePause(false);
          if (this.raceConfig?.multiplayer) {
            this.closeNet('left');
            this.teardownSession();
            this.state = 'menu';
            this.ui.showMain(this.champ);
            break;
          }
          const wasTrial = this.raceConfig?.trial;
          if (wasTrial && this.session) {
            const p = this.session.player;
            const bestLap = p.bestLap || this.timeTrial?.personalBest || 0;
            this.teardownSession(true);
            this.state = 'results';
            this.ui.showResults([{ bestLap }], null, this.raceConfig.race, 'trial', false);
          } else {
            this.teardownSession();
            this.state = 'menu';
            this.ui.showMain(this.champ);
          }
        }
        break;
    }
  }

  // ---------- private multiplayer ----------

  /**
   * Resolve the deferred private-race module, caching the two pieces the hot
   * paths need: the event names the router switches on, and the per-frame
   * pumps the race loop calls.
   */
  async netModule() {
    const module = await loadMultiplayer();
    this._netEvent = module.NET_EVENT;
    this._netPumps = module;
    return module;
  }

  /**
   * Auto-pause is a single-player courtesy. In a private race the world keeps
   * turning on the other machine, so silently pausing on a lost focus would
   * park this player's car on the racing line without them knowing. An explicit
   * ESC pause is still theirs to take.
   */
  autoPauseEnabled() {
    return !!this.ui.settings.autoPause && !this.raceConfig?.multiplayer;
  }

  /** One monotonic timeline for packet arrival and interpolation replay. */
  netNow() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000; }

  async openMultiplayerHub(notice = '') {
    this.teardownSession();
    this.state = 'multiplayer';
    const { peerConnectionSupported } = await this.netModule();
    if (!peerConnectionSupported()) {
      this.ui.showMultiplayerHub(
        'This browser cannot open a direct connection to another player, so races against other people are unavailable here. ' +
        'A current desktop or mobile browser with WebRTC support is required.');
      return;
    }
    // Paint immediately with whatever is already known, then fill in the crowd
    // count if a lobby answers. A slow or absent server must never be something
    // the player waits on to see a menu.
    const backend = await loadBackend();
    const publicEnabled = backend.available();
    this.ui.showMultiplayerHub(notice, { publicEnabled });
    if (!publicEnabled) return;
    const stats = await backend.health();
    if (this.state === 'multiplayer' && stats) {
      this.ui.showMultiplayerHub(notice, { publicEnabled, stats });
    }
  }

  // ---------- public races ----------

  /** The handle this browser holds, or null when one has not been claimed. */
  async publicIdentity() {
    const backend = await loadBackend();
    return backend.storedIdentity();
  }

  /**
   * Public features need a name. Anything that requires one routes through here
   * first, and resumes once the player has claimed one.
   */
  async requirePublicHandle(resume, notice = '') {
    const identity = await this.publicIdentity();
    if (identity) return identity;
    this._afterHandle = resume;
    this.state = 'multiplayer';
    // The first player to hit this screen clicked POST, landed on a name form
    // with no explanation, and reasonably walked away — say why we are asking.
    this.ui.showHandleSetup({ notice });
    return null;
  }

  async registerPublicHandle(handle) {
    const backend = await loadBackend();
    try {
      const identity = await backend.registerHandle(handle);
      this.ui.showHandleSetup({ handle: identity.handle, claimCode: identity.claimCode });
    } catch (error) {
      this.ui.showHandleSetup({ handle, error: error?.message || 'That name could not be claimed.' });
    }
  }

  async claimPublicHandle(handle, claimCode) {
    const backend = await loadBackend();
    try {
      await backend.claimHandle(handle, claimCode);
      this.finishHandleSetup();
    } catch (error) {
      this.ui.showHandleSetup({ handle, error: error?.message || 'That name and code did not match.' });
    }
  }

  /** Continue whatever the player was doing before they had to pick a name. */
  finishHandleSetup() {
    const resume = this._afterHandle;
    this._afterHandle = null;
    if (typeof resume === 'function') resume();
    else this.openMultiplayerHub();
  }

  /** Claim a name if needed, then configure the race that will carry it. */
  async openPublicHostSetup() {
    const identity = await this.requirePublicHandle(() => this.openPublicHostSetup());
    if (!identity) return;
    this.state = 'multiplayer';
    this._hostPublic = true;
    this.ui.showMultiplayerHostSetup();
  }

  async browsePublicRooms(notice = '') {
    this.state = 'multiplayer';
    const backend = await loadBackend();
    this.ui.showPublicRooms({ rooms: [], status: 'Looking for open races…', error: notice });
    const rooms = await backend.listRooms();
    if (this.state !== 'multiplayer') return;
    this.ui.showPublicRooms({ rooms, error: notice });
  }

  /** Drop into whatever race is closest to starting. */
  async quickMatchPublicRace() {
    const identity = await this.requirePublicHandle(() => this.quickMatchPublicRace());
    if (!identity) return;
    this.state = 'multiplayer';
    this.ui.showPublicRooms({ rooms: [], status: 'Finding a race…' });
    const backend = await loadBackend();
    const room = await backend.quickMatch();
    if (!room) { this.browsePublicRooms('No open races right now. Open one and someone will find it.'); return; }
    this.joinPublicRace(room.id);
  }

  /** Host: open a race that appears in the public list. */
  async hostPublicRace(setup = {}) {
    const identity = await this.requirePublicHandle(() => this.hostPublicRace(setup));
    if (!identity) return;
    this.closeNet('restart');
    this.teardownSession();
    this.state = 'multiplayer';
    const laps = Math.max(1, Math.round(setup.laps || 5));
    try {
      const { hostPublicRace } = await loadPublicRace();
      const handle = await hostPublicRace({
        driverId: setup.driverId,
        handle: identity.handle,
        trackId: setup.trackId,
        laps,
        difficulty: this.ui.settings.difficulty,
        aiOpponents: setup.aiOpponents !== false,
        onEvent: (type, data) => this.onNetEvent(type, data),
        onStatus: (text) => { if (this.state === 'multiplayer') this.ui.setMultiplayerStatus(text); },
      });
      this.netHandle = handle;
      this.net = handle.session;
      this.startNetHeartbeat();
      this._netLobby = {
        role: 'host', trackId: setup.trackId, laps,
        aiOpponents: setup.aiOpponents !== false,
        roomId: handle.roomId, link: '', code: '', isPublic: true,
      };
      this.ui.showMultiplayerHostLobby({
        ...this._netLobby,
        roster: handle.session.roster(),
        canStart: false,
        status: 'Your race is listed. Anyone can join it — start when you have enough drivers.',
      });
    } catch (error) {
      this.ui.showMultiplayerHostSetup(error?.message || 'Could not open a public race.');
    }
  }

  /** Guest: join a race from the public list. */
  async joinPublicRace(roomId) {
    const identity = await this.requirePublicHandle(() => this.joinPublicRace(roomId));
    if (!identity) return;
    this.closeNet('restart');
    this.teardownSession();
    this.state = 'multiplayer';
    this.ui.showPublicRooms({ rooms: [], status: 'Connecting to the race…' });
    try {
      const { joinPublicRace } = await loadPublicRace();
      const handle = await joinPublicRace({
        roomId,
        driverId: this.ui.mpSetup.driverId,
        handle: identity.handle,
        onEvent: (type, data) => this.onNetEvent(type, data),
        onStatus: (text) => { if (this.state === 'multiplayer') this.ui.setMultiplayerStatus(text); },
      });
      this.netHandle = handle;
      this.net = handle.session;
      this.startNetHeartbeat();
      this._netLobby = { role: 'guest', roomId, isPublic: true };
      this.ui.showMultiplayerJoin({
        code: '', replyCode: '',
        preview: { trackId: handle.offer.trackId, laps: handle.offer.laps, hostName: handle.offer.hostName },
        status: 'Connected. Waiting for the host to start the race…',
      });
    } catch (error) {
      this.browsePublicRooms(error?.message || 'Could not join that race.');
    }
  }

  // ---------- public leaderboard ----------

  async openLeaderboard(trackId = null, extra = {}) {
    this.teardownSession();
    this.state = 'multiplayer';
    const backend = await loadBackend();
    // Default to wherever the player most recently set a best: the person most
    // likely to open this screen is the one who just got out of the car.
    const track = trackId || storedPersonalBests()[0]?.trackId || this.ui.mpSetup?.trackId || 'monza';
    this.ui.showLeaderboard({ trackId: track, entries: [], status: 'Loading the board…', ...extra });
    const board = await backend.leaderboard(track);
    if (this.state !== 'multiplayer') return;

    // A best sitting in this browser that beats the player's entry on the
    // board — or that the board has never seen — gets offered for posting.
    // This is what rescues a lap driven before the player had a handle.
    let pendingBest = null;
    const stored = bestStoredGhost(track);
    if (stored && (!board.you || stored.lapSeconds < board.you.lapSeconds - 0.001)) {
      pendingBest = { lapSeconds: stored.lapSeconds, hasHandle: !!backend.storedIdentity() };
    }
    this.ui.showLeaderboard({ trackId: track, ...board, pendingBest, ...extra });
  }

  /** Post the stored personal best for a circuit, claiming a name if needed. */
  async submitStoredBest(trackId) {
    const ghost = bestStoredGhost(trackId);
    if (!ghost) { this.openLeaderboard(trackId, { error: 'No saved lap found for this circuit on this device.' }); return; }
    const identity = await this.requirePublicHandle(() => this.submitStoredBest(trackId),
      `One step left: your ${fmtTime(ghost.lapSeconds)} lap posts the moment your name is saved.`);
    if (!identity) return;
    const backend = await loadBackend();
    this.ui.setMultiplayerStatus('Submitting your lap…');
    try {
      const result = await backend.submitLap(trackId, ghost);
      this.openLeaderboard(trackId, {
        notice: result.improved
          ? `Your ${fmtTime(result.best)} is on the board — P${result.rank} of ${result.total}.`
          : `The board already has your ${fmtTime(result.best)}, which is faster.`,
      });
    } catch (error) {
      this.openLeaderboard(trackId, {
        error: error?.reasons?.length
          ? `That lap could not be verified: ${error.reasons[0]}`
          : (error?.message || 'The lap could not be submitted.'),
      });
    }
  }

  /**
   * Submit a personal best.
   *
   * Called when the time-trial manager records a new best. It is deliberately
   * quiet: a player who has not claimed a handle, or who has no lobby server,
   * keeps their personal best locally and is not nagged about a feature they
   * have not opted into.
   */
  async submitPersonalBest(trackId, ghost) {
    if (!ghost) return null;
    const backend = await loadBackend();
    if (!backend.available()) return null;
    if (!backend.storedIdentity()) {
      // The best is safe locally, and the leaderboard screen will offer it for
      // posting. Silence here was a bug: the first real player set a time,
      // assumed it was on the board, and found nothing there.
      this.hud.message('PB SAVED — POST IT FROM THE LEADERBOARD MENU', 'yellow');
      return null;
    }
    try {
      return await backend.submitLap(trackId, ghost);
    } catch (error) {
      // A rejected lap is worth telling the player about, without interrupting.
      this.hud.message('PB SAVED LOCALLY — LEADERBOARD REFUSED IT', 'yellow');
      return null;
    }
  }

  /** Jump straight from the board into a time trial on that circuit. */
  startTimeTrialFromLeaderboard(trackId) {
    const race = CALENDAR.find(r => r.trackId === trackId);
    if (!race) { this.openLeaderboard(trackId, { error: 'That circuit is not in this build.' }); return; }
    const driverId = this.ui.mpSetup?.driverId || DRIVERS[0].id;
    this.startSession({ race, driverId, mode: 'quali', trial: true });
  }

  /** Pull a rival's ghost down and drive against it. */
  async raceRivalGhost(trackId, playerId) {
    const backend = await loadBackend();
    this.ui.setMultiplayerStatus('Fetching that lap…');
    const ghost = await backend.rivalGhost(trackId, playerId);
    if (!ghost) { this.openLeaderboard(trackId, { error: 'That ghost could not be downloaded.' }); return; }
    this._rivalGhost = { trackId, ghost };
    this.ui.mpSetup.trackId = trackId;
    this.openLeaderboard(trackId, { notice: 'Ghost loaded. Start a time trial on this circuit to race it.' });
  }

  /** Host: build the offer and show the lobby with the invite ready to send. */
  async hostPrivateRace(setup = {}) {
    this.closeNet('restart');
    this.teardownSession();
    this.state = 'multiplayer';
    const laps = Math.max(1, Math.round(setup.laps || 5));
    try {
      const { createPrivateRace } = await this.netModule();
      const handle = await createPrivateRace({
        driverId: setup.driverId,
        trackId: setup.trackId,
        laps,
        difficulty: this.ui.settings.difficulty,
        aiOpponents: setup.aiOpponents !== false,
        // LAN ONLY means literally no external contact: no STUN lookup at all.
        iceServers: setup.connection === 'lan' ? [] : undefined,
        baseHref: location.href.split('#')[0],
        onEvent: (type, data) => this.onNetEvent(type, data),
      });
      this.netHandle = handle;
      this.net = handle.session;
      this.startNetHeartbeat();
      this._netLobby = {
        role: 'host',
        trackId: setup.trackId,
        laps,
        aiOpponents: setup.aiOpponents !== false,
        roomId: handle.roomId,
        link: handle.invite.link,
        code: handle.invite.code,
      };
      this.ui.showMultiplayerHostLobby({
        ...this._netLobby,
        roster: handle.session.roster(),
        canStart: false,
        status: 'Send the invite. When your friend sends a reply code back, paste it above.',
      });
    } catch (error) {
      this.ui.showMultiplayerHostSetup(error?.message || 'Could not open a private race.');
    }
  }

  /** Host: complete the handshake with the code the guest sent back. */
  async acceptGuestReply(code) {
    if (!this.netHandle?.invite) return;
    if (!code.trim()) { this.ui.setMultiplayerStatus('Paste the reply code your friend sent you.'); return; }
    this.ui.setMultiplayerStatus('Opening the connection…');
    try {
      await this.netHandle.invite.accept(code);
      this.ui.setMultiplayerStatus('Connecting to your friend…');
    } catch (error) {
      this.ui.setMultiplayerStatus(error?.message || 'That reply code did not work.');
    }
  }

  /** Host: freeze the grid and send everyone to the start. */
  async startNetworkRaceAsHost() {
    if (!this.net?.isHost) return;
    const base = this.net.raceConfig;
    if (!base) return;
    const { buildGridOrder } = await this.netModule();
    const gridRandom = createRandom(deriveSeed(base.seed, 'grid'));
    const config = {
      ...base,
      gridOrder: buildGridOrder({
        humanDriverIds: this.net.humanDriverIds(),
        aiOpponents: base.aiOpponents,
        random: gridRandom,
      }),
    };
    await this.netHandle?.seal?.();
    this.net.startRace(config);
  }

  /** Guest: show the join screen, optionally pre-filled from an invite link. */
  async openJoinScreen(code = '') {
    this.teardownSession();
    this.state = 'multiplayer';
    const { peerConnectionSupported, previewInvite } = await this.netModule();
    if (!peerConnectionSupported()) { this.openMultiplayerHub(); return; }
    if (!code) { this.ui.showMultiplayerJoin({ code: '' }); return; }
    const preview = await previewInvite(code).catch(() => null);
    this.ui.showMultiplayerJoin({
      code,
      preview: preview && preview.playable && preview.compatible ? preview : null,
      error: this.describeInvite(preview),
    });
  }

  describeInvite(preview) {
    if (!preview) return '';
    if (!preview.compatible) return 'That invite was made with a different version of the game. Both of you need the same build.';
    if (!preview.playable) return 'That invite is for a circuit this build does not have.';
    return '';
  }

  /** Guest: decode an invite without connecting, so the race can be previewed. */
  async previewJoinCode(code) {
    const trimmed = (code || '').trim();
    if (!trimmed) { this.ui.showMultiplayerJoin({ code: '', error: 'Paste the invite link or code your friend sent.' }); return; }
    const { previewInvite } = await this.netModule();
    const preview = await previewInvite(trimmed).catch(() => null);
    const error = preview ? this.describeInvite(preview) : 'That invite could not be read. Ask your friend to send the whole link or code.';
    this.ui.showMultiplayerJoin({
      code: trimmed,
      preview: preview && preview.playable && preview.compatible ? preview : null,
      error,
    });
  }

  /** Guest: accept the invite and produce the reply code the host needs. */
  async joinPrivateRace(code, driverId) {
    this.closeNet('restart');
    this.state = 'multiplayer';
    try {
      const { acceptPrivateRace } = await this.netModule();
      const handle = await acceptPrivateRace({
        code,
        driverId: driverId || this.ui.mpSetup.driverId,
        onEvent: (type, data) => this.onNetEvent(type, data),
      });
      this.netHandle = handle;
      this.net = handle.session;
      this.startNetHeartbeat();
      this._netLobby = { role: 'guest', ...handle.offer };
      this.ui.showMultiplayerJoin({
        code,
        preview: handle.offer,
        replyCode: handle.replyCode,
        status: 'Send this reply code to your friend. The race starts once they paste it in.',
      });
    } catch (error) {
      this.ui.showMultiplayerJoin({ code, error: error?.message || 'Could not join that race.' });
    }
  }

  /** Every lobby and in-race event from the network session lands here. */
  onNetEvent(type, payload = {}) {
    const NET_EVENT = this._netEvent;
    if (!NET_EVENT) return;
    switch (type) {
      case NET_EVENT.JOINED:
        // One offer answers one guest. Mint a fresh invite so the host can
        // bring in another friend without restarting the lobby.
        this.refreshHostInvite();
        break;
      case NET_EVENT.ROSTER:
        this.paintNetLobby(payload.roster);
        break;
      case NET_EVENT.LEFT:
        this.paintNetLobby();
        if (this.state === 'race' && this.session) {
          this.session.retireNetworkDriver?.(payload.peer?.driverId);
          this.hud.message(`${(payload.peer?.name || 'A PLAYER').toUpperCase()} LEFT THE RACE`, 'yellow');
        }
        break;
      case NET_EVENT.START:
        this.beginNetworkRace(payload.config);
        break;
      case NET_EVENT.PHASE:
        this.session?.applyNetworkPhase?.(payload);
        break;
      case NET_EVENT.RESULT:
        this.session?.applyNetworkResults?.(payload.rows, payload.fastestLap);
        break;
      case NET_EVENT.ERROR:
        if (this.state === 'multiplayer') this.ui.setMultiplayerStatus(payload.message || 'Connection problem.');
        break;
      case NET_EVENT.CLOSED:
        this.onNetClosed(payload.reason);
        break;
      default:
        break;
    }
  }

  async refreshHostInvite() {
    if (!this.netHandle?.newInvite || !this._netLobby || this._netLobby.role !== 'host') return;
    try {
      const invite = await this.netHandle.newInvite();
      this.netHandle.invite = invite;
      this._netLobby.link = invite.link;
      this._netLobby.code = invite.code;
      const linkField = document.getElementById('mp-link');
      const codeField = document.getElementById('mp-code');
      const replyField = document.getElementById('mp-reply');
      if (linkField) linkField.value = invite.link;
      if (codeField) codeField.value = invite.code;
      if (replyField) replyField.value = '';
    } catch {
      // A failed refresh only costs the ability to invite a third player; the
      // race that is already assembled stays perfectly usable.
    }
  }

  paintNetLobby(roster) {
    if (!this.net || this.state !== 'multiplayer') return;
    const rows = roster || this.net.roster();
    const connected = rows.length > 1;
    this.ui.updateMultiplayerLobby({
      roster: rows,
      canStart: this.net.isHost && connected,
      status: this.net.isHost
        ? (connected
          ? `${rows.length} drivers ready. Start when you are.`
          : 'Send the invite. When your friend sends a reply code back, paste it above.')
        : 'Connected. Waiting for the host to start the race…',
      replyCode: this.netHandle?.replyCode,
    });
  }

  onNetClosed(reason) {
    // A local teardown already knows where it is going next; only an unplanned
    // disconnect should redirect the player.
    if (this._netClosing) return;
    const wasRacing = this.state === 'race';
    const handle = this.netHandle;
    this.net = null;
    this.netHandle = null;
    try { handle?.close?.(reason); } catch { /* already gone */ }
    if (wasRacing) {
      // Retire the cars this machine can no longer hear from, so the player
      // finishes a real race against nobody rather than dodging statues.
      this.session?.retireAllNetworkDrivers?.();
      this.hud.message('CONNECTION LOST — FINISHING ALONE', 'red');
      return;
    }
    if (this.state !== 'multiplayer') return;
    this.openMultiplayerHub(reason === 'host-disconnected' || reason === 'host-left'
      ? 'The host closed the race.'
      : 'The connection closed.');
  }

  /** Both roles: build the identical race the lobby agreed on. */
  beginNetworkRace(config) {
    if (!this.net || !config) return;
    const race = CALENDAR.find(item => item.trackId === config.trackId);
    if (!race) {
      this.openMultiplayerHub('That race is set at a circuit this build does not have.');
      return;
    }
    this._netResultsPublished = false;
    this.ui.sel.mode = 'multiplayer';
    this.camMode = 0;
    this.startSession({
      race,
      driverId: this.net.localDriverId,
      mode: 'race',
      laps: config.laps,
      difficulty: config.difficulty,
      seed: config.seed,
      gridOrder: config.gridOrder,
      multiplayer: { role: this.net.role, remoteDriverIds: this.net.remoteDriverIds() },
    });
  }

  closeNet(reason = 'left') {
    const handle = this.netHandle;
    const session = this.net;
    this.netHandle = null;
    this.net = null;
    this._netLobby = null;
    this._netClosing = true;
    try { handle?.close(reason); } catch { /* already gone */ }
    if (!handle && session) { try { session.close(reason); } catch { /* already gone */ } }
    this._netClosing = false;
  }

  startChampRace() {
    this.ui.sel.mode = 'champ'; // clear stale 'trial' so loading-screen copy matches the session
    const race = this.champ.nextRace;
    if (!race) { this.state = 'standings'; this.ui.showStandings(this.champ, false); return; }
    const driverId = this.champ.playerDriverId;
    if (this.ui.settings.quali) {
      this.startSession({ race, driverId, mode: 'quali', champRound: true });
    } else {
      this.startSession({ race, driverId, mode: 'race', champRound: true });
    }
  }

  // ---------- session lifecycle ----------
  startSession(cfg) {
    this.teardownSession();
    this.resetSimulationTiming();
    const querySeed = new URLSearchParams(location.search).get('seed');
    const requestedSeed = cfg.seed ?? querySeed;
    const sessionSeed = requestedSeed == null ? createRandom().state : normalizeSeed(requestedSeed);
    cfg = { ...cfg, seed: sessionSeed };
    if (cfg.fullWeekend) cfg.weekendSeed = normalizeSeed(cfg.weekendSeed ?? sessionSeed);
    // Every player-controlled session opens in the elevated rear chase view.
    // Cockpit/T-cam/nose remain available through C after the session is ready.
    this.camMode = 0;
    this.raceConfig = cfg;
    const simulationRandom = createRandom(deriveSeed(sessionSeed, 'simulation'));
    const effectsRandom = createRandom(deriveSeed(sessionSeed, 'effects'));
    this.sessionSeed = sessionSeed;
    const track = TRACKS[cfg.race.trackId];
    this.state = 'loading';
    this.ui.showLoading(cfg.race, track, cfg);
    this._resultsShown = false;
    this._lightsShown = 0;
    this._qualiDoneShown = false;
    this.ersMode = 1; // every session starts in BALANCED
    this.pitLimiter = false;
    this._pauseOnReady = !!(this.autoPauseEnabled() && !documentIsActive());
    const sessionGeneration = this._sessionGeneration;
    const environmentKey = environmentKeyForTrack(cfg.race.trackId);
    // Begin the one relevant lighting environment in parallel with photos/GLB.
    loadHDRI(environmentKey).catch(() => {});
    // let the loading screen paint before the (sync) circuit build
    this._sessionBuildTimer = setTimeout(async () => {
      this._sessionBuildTimer = null;
      if (sessionGeneration !== this._sessionGeneration) return;
      try {
        await loadCoreAssets();
      } catch (error) {
        if (sessionGeneration !== this._sessionGeneration) return;
        console.error('Race assets failed to load', error);
        this.state = 'loadError';
        this.ui.showLoadError(cfg.race, track);
        return;
      }
      if (sessionGeneration !== this._sessionGeneration) return;
      this.scene = new THREE.Scene();
      this.circuit = buildCircuit(cfg.race.trackId, track, this.scene, {
        weatherSeed: deriveSeed(sessionSeed, 'weather'),
      });
      // Authored trackside props replace the box scenery if and when the optional
      // kit arrives: never awaited, and skipped once this circuit is not current.
      this.circuit.installTracksideKit?.((circuit) => this.circuit === circuit);
      this.setupEnvironment(effectsRandom, environmentKey);
      // A networked race carries its own agreed distance: both machines must
      // build the same session, so local Settings cannot be allowed to win.
      const laps = cfg.mode === 'race'
        ? Math.max(1, Math.round(cfg.laps || this.ui.raceLapsFor(cfg.race.trackId)))
        : 1;
      this.session = new RaceSession({
        scene: this.scene,
        circuit: this.circuit,
        playerDriverId: cfg.driverId,
        laps,
        difficulty: cfg.difficulty ?? this.ui.settings.difficulty,
        netRole: cfg.multiplayer?.role || null,
        remoteDriverIds: cfg.multiplayer?.remoteDriverIds || [],
        assists: { tc: this.ui.settings.tc, abs: this.ui.settings.abs, autoGear: this.ui.settings.autoGear },
        mode: cfg.mode,
        trial: cfg.trial,
        qualiStage: cfg.qualiStage,
        qualiFormat: cfg.qualiFormat,
        formationLap: cfg.formationLap,
        gridOrder: cfg.gridOrder || null,
        random: simulationRandom,
        seed: sessionSeed,
        onMessage: (t, c, meta) => { this.hud.message(t, c, meta); },
        onPitLimiter: v => { this.pitLimiter = v; },
      });
      this.applyVenueCarLighting();
      this.session.setNametags(this.ui.settings.nametags);
      this.hud.bindSession(this.session, this.circuit);
      if (!this._simOnly) this.racingLine = new RacingLine(this.scene, this.circuit);
      this.replay = this._simOnly || cfg.multiplayer ? null : new ReplayDirector(this);
      if (cfg.formationLap) this.session.startFormation();
      if (cfg.trial) {
        this.timeTrial = new TimeTrialManager({
          scene: this.scene,
          circuit: this.circuit,
          session: this.session,
          trackId: cfg.race.trackId,
          driverId: cfg.driverId,
          onPersonalBest: (record, { saved } = {}) => {
            this.hud.message(personalBestMessage(record, saved), saved ? 'purple' : 'yellow');
            // Offering the lap to the public board is a side effect of setting
            // it, never a precondition of keeping it. Even when device storage
            // is unavailable, the in-memory lap can still be submitted during
            // this session; no backend or no claimed handle simply skips it.
            const ghost = this.timeTrial?.exportData();
            if (!ghost) return;
            this.submitPersonalBest(cfg.race.trackId, ghost).then((result) => {
              if (!result) return;
              if (result.improved) {
                this.hud.message(`LEADERBOARD · P${result.rank} OF ${result.total}`, 'purple');
              }
            });
          },
        });
        this._timeTrialStatus = { personalBest: this.timeTrial.personalBest, delta: null };
        this.hud.updateTimeTrial(this._timeTrialStatus.personalBest, null);
      }
      this.hud.showPitOverlay(k => {
        this.session.playerChooseTyre(k);
        this.audio.uiConfirm();
      });
      this.ui.hideAll();
      this.hud.show();
      this.state = cfg.mode === 'race' ? 'race' : 'quali';
      this.updateTouchControls();
      this.snapCamera();
      // Populate the stationary start screen from real session state without
      // advancing physics. Otherwise the frozen gate displayed constructor
      // placeholders (neutral/Medium) until after the player pressed Start.
      this.hud.update(0);
      this.hud.updateSimulationState?.(this.snapshot());
      // Circuit/PMREM/car construction is synchronous and can take hundreds of
      // milliseconds. Rebase after it so no build time becomes simulation time.
      this.resetSimulationTiming();
      this.awaitingStart = true;
      let onboardingSeen = false;
      try { onboardingSeen = localStorage.getItem('apexf1_onboarding_v1') === '1'; } catch {}
      const shouldPauseOnReady = () => !!(this.autoPauseEnabled() &&
        (this._pauseOnReady || !documentIsActive()));
      if (!onboardingSeen) {
        this.onboardingActive = true;
        this.paused = true;
        this.resetSimulationTiming();
        this.audio.stopEngine();
        this.hud.showOnboarding(() => {
          try { localStorage.setItem('apexf1_onboarding_v1', '1'); } catch {}
          this.onboardingActive = false;
          if (documentIsActive()) this._pauseOnReady = false;
          if (shouldPauseOnReady()) {
            this.paused = true;
            this.resetSimulationTiming();
            this.audio.stopEngine();
            this.ui.showPause();
            return;
          }
          this.paused = false;
          this.resetSimulationTiming();
          this.beginSessionFromGate();
        });
      } else if (shouldPauseOnReady()) {
        // Visibility or window focus may have changed while assets/build ran.
        this.togglePause(true);
      } else if (this.raceConfig?.multiplayer) {
        // A network race has no local start gate. The start belongs to the
        // host's phase machine, whose light sequence runs on its own clock on
        // every connected machine — a player parked at a PRESS ENTER prompt
        // would still be sitting on the grid as the field pulled away. Same
        // reasoning that exempts these sessions from auto-pause.
        this.paused = false;
        this.beginSessionFromGate();
      } else {
        this.paused = false;
        this.audio.stopEngine();
        this.hud.showSessionReady(() => this.beginSessionFromGate());
      }
    }, 60);
  }

  updateTouchControls() {
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    this.hud.enableTouchControls(
      !!(this.session && this.ui.settings.touchControls && coarse),
      () => this.togglePause(),
    );
  }

  teardownSession(keepConfig = false) {
    this._sessionGeneration++;
    clearTimeout(this._sessionBuildTimer); this._sessionBuildTimer = null;
    clearTimeout(this._qualiTimer); this._qualiTimer = null;
    clearTimeout(this._resultsTimer); this._resultsTimer = null;
    if (this.replay) { this.replay.dispose(); this.replay = null; }
    if (this.timeTrial) { this.timeTrial.dispose(); this.timeTrial = null; }
    if (this.racingLine) { this.racingLine.dispose(); this.racingLine = null; }
    if (this.session) { this.session.dispose(); this.session = null; }
    if (this.circuit) { this.circuit.dispose(); this.circuit = null; }
    if (this.sky) {
      this.sky.geometry.dispose();
      const skyMap = this.sky.material.map;
      if (skyMap && skyMap !== SKY.day && skyMap !== SKY.dusk) skyMap.dispose();
      this.sky.material.dispose();
      this.sky = null;
    }
    // HDRI env textures are module-cached and shared across sessions — never
    // dispose those; the PMREM fallback owns a per-session render target.
    if (this._envRT) { this._envRT.dispose(); this._envRT = null; }
    if (this.scene) this.scene.environment = null;
    if (this.sun) { this.sun.dispose(); this.sun = null; }
    if (this._celestialObjects.length) {
      const geometries = new Set(), materials = new Set(), textures = new Set();
      for (const root of this._celestialObjects) {
        root.traverse((object) => {
          // Sprite geometry is shared internally by Three.js.
          if (object.geometry && !object.isSprite) geometries.add(object.geometry);
          const ownedMaterials = object.material
            ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
          for (const material of ownedMaterials) {
            materials.add(material);
            if (material.map) textures.add(material.map);
          }
        });
        root.removeFromParent();
      }
      for (const texture of textures) texture.dispose();
      for (const material of materials) material.dispose();
      for (const geometry of geometries) geometry.dispose();
      this._celestialObjects = [];
    }
    if (this.effects) { this.effects.dispose(); this.effects = null; }
    this.quality.bind({});
    if (this.composer) {
      for (const pass of this.composer.passes) pass.dispose && pass.dispose();
      this.composer.dispose();
      this.composer = null; this.bloom = null; this.gtao = null; this.fxaa = null;
      this._filmPass = null; this._look = null;
      this.renderer.shadowMap.autoUpdate = true;
    }
    this.hemi = null;
    this.scene = null;
    // Do not let a completed night session tint the menu or the next venue while
    // its scene is being assembled. setupEnvironment() reapplies the selected
    // venue's look once the new circuit exists.
    this._environmentKey = null;
    this._renderLookKey = null;
    this.renderer.toneMappingExposure = RENDER_LOOK.day.exposure;
    this.hud.hide();
    this.hud.setCockpitMode(false);
    this.audio.stopEngine();
    if (this.audio.crowdAmbience) this.audio.crowdAmbience(0);
    if (this.audio.stopCrescendo) this.audio.stopCrescendo();
    this._vscAudio = false; this._radioLen = 0; this._pitAudio = false;
    this._timeTrialStatus = null;
    this.onboardingActive = false;
    this.awaitingStart = false;
    this.resetSimulationTiming();
    if (!keepConfig) this.paused = false;
  }

  setupEnvironment(effectsRandom = () => Math.random(), environmentKey) {
    this._celestialObjects = [];
    const th = this.circuit.theme;
    const renderLookKey = renderLookKeyForTrack(this.circuit.id, environmentKey);
    const renderLook = RENDER_LOOK[renderLookKey] || RENDER_LOOK.day;
    this._environmentKey = environmentKey;
    this._renderLookKey = renderLookKey;
    // Day, dusk and night are independently graded. Day holds highlight
    // headroom; dusk trades warm sun/ground lift for neutral sky/IBL fill; night
    // preserves the established restrained fixture response.
    this.renderer.toneMappingExposure = renderLook.exposure;
    this.scene.fog = new THREE.Fog(th.fog, th.fogNear ?? 300, th.fogFar ?? 1600);
    // Day/dusk scenery dissolves into the sky's own horizon colour rather than
    // a darker theme tint, so distant structures sit in the air instead of
    // reading as cut-outs against the dome. Night fog is a pinned extinction
    // colour (see the additive-fog contract) and is left alone.
    if (!th.night) this.scene.fog.color.lerp(_lookC.set(th.skyBot), 0.6);
    // sky dome: gradient + soft clouds BAKED into the texture (day/dusk).
    // Clouds must never be separate transparent quads again -- sprites read as
    // tinted slab panes (removed in e29383d); baked into the dome they cannot.
    const skyTex = new THREE.CanvasTexture(TEX.skyDome(
      '#' + new THREE.Color(th.skyTop).getHexString(),
      '#' + new THREE.Color(th.skyBot).getHexString(),
      { clouds: !th.night, dusk: environmentKey === 'dusk',
        horizonStop: th.night && !th.proceduralSky ? 1 : 0.52 }
    ));
    skyTex.colorSpace = THREE.SRGBColorSpace;
    const sky = new THREE.Mesh(
      // 64x32: a photographic panorama shears visibly across 15-degree quads
      new THREE.SphereGeometry(2600, 64, 32),
      new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false })
    );
    // The sky is at infinity. The dome used to sit at the world origin, so on a
    // circuit that reaches 1.5 km from it the sun and every cloud slid across
    // the sky as the car moved (up to 25 degrees of parallax, 2 degrees a second
    // on a straight). The dome, sun, moon and stars now ride a rig that is
    // re-centred on the camera before every render; drawn first with no depth
    // test or write, the dome can never hide far scenery either.
    const skyRig = new THREE.Group();
    skyRig.name = 'sky-rig';
    sky.frustumCulled = false;
    sky.renderOrder = -1000;
    sky.material.depthTest = false;
    sky.material.depthWrite = false;
    skyRig.add(sky);
    this.scene.add(skyRig);
    this.scene.onBeforeRender = (_renderer, _scene, camera) => {
      skyRig.position.setFromMatrixPosition(camera.matrixWorld);
      skyRig.updateMatrixWorld(true);
    };
    this.sky = sky;
    const hemi = new THREE.HemisphereLight(
      th.skyTop,
      renderLook.hemiGround ?? th.ground,
      renderLook.hemiIntensity ?? th.hemi,
    );
    this.scene.add(hemi);
    this.hemi = hemi;
    const sun = new THREE.DirectionalLight(th.sun, renderLook.sunIntensity ?? th.sunI);
    this._sunOffset = SUN_OFFSET[environmentKey] || SUN_OFFSET.day;
    sun.position.set(...this._sunOffset);
    {
      // Light-space right/up axes of the sun's shadow camera for this look, and
      // the 2x2 solve that turns a light-space texel snap into a horizontal
      // move of the frustum centre (used by _lookUpdate every frame).
      const [ox, oy, oz] = this._sunOffset;
      const il = 1 / Math.hypot(ox, oy, oz);
      const dx = ox * il, dy = oy * il, dz = oz * il;
      const ir = 1 / Math.hypot(dz, dx);
      const rx = dz * ir, rz = -dx * ir;                 // right = up x d
      const ux = dy * rz, uy = dz * rx - dx * rz, uz = -dy * rx;   // up' = d x right
      this._sunBasis = { rx, rz, ux, uy, uz, det: rx * uz - rz * ux };
    }
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -110; sc.right = 110; sc.top = 110; sc.bottom = -110;
    sc.near = 50; sc.far = 900;
    sc.updateProjectionMatrix(); // without this the frustum stays at the ±5m default → no visible shadows
    sun.shadow.bias = -0.0004;
    // Trackside structures cast into the same map as the cars. _lookUpdate()
    // owns the frustum (size, texel snapping, biases) once a frame is painted.
    this._shadowSize = 0;
    this._reducedMotion = !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const night = !!th.night;
    this.circuit.group.traverse((o) => {
      if (!o.isMesh || !o.name) return;
      // Night venues are lit by masts, not by the moon key: only the low
      // barriers cast there, so stands do not throw hard "moonlight" slabs.
      if (SHADOW_CASTERS.test(o.name) && (!night || /^(hoardings|wall-)/.test(o.name))) o.castShadow = true;
      if (SHADOW_RECEIVERS.test(o.name) && !o.material.transparent) o.receiveShadow = true;
    });
    this._look = {
      sun: sun.color.clone(), fog: this.scene.fog.color.clone(), env: 0,
      // sky-shadow strength (see the ShaderChunk patch); overcast flattens it
      shade: th.night ? 0.2 : (environmentKey === 'dusk' ? 0.5 : 0.62),
      near: this.scene.fog.near, far: this.scene.fog.far, wx: 0, rain: 0, speed: 0, frame: 0,
    };
    sun.shadow.radius = 1 + this._look.shade;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
    if (th.night) {
      const amb = new THREE.AmbientLight(
        renderLook.ambientColor ?? 0x8899cc,
        renderLook.ambientIntensity ?? 0.5,
      );
      this.scene.add(amb);
    }

    // ---- celestial dressing ----
    const mkTex = (canvas) => {
      const t = new THREE.CanvasTexture(canvas);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    const sunDir = sun.position.clone().normalize();
    const sunSprites = [];
    if (!th.night) {
      // sun disc + glow
      const glow = (inner, outer, size) => {
        const c = document.createElement('canvas');
        c.width = c.height = 128;
        const g = c.getContext('2d');
        const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
        grad.addColorStop(0, inner);
        grad.addColorStop(1, outer);
        g.fillStyle = grad;
        g.fillRect(0, 0, 128, 128);
        const m = new THREE.SpriteMaterial({ map: mkTex(c), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
        const s = new THREE.Sprite(m);
        s.scale.setScalar(size);
        return s;
      };
      const sunDisc = glow('rgba(255,252,240,1)', 'rgba(255,240,200,0)', 260);
      sunDisc.position.copy(sunDir).multiplyScalar(2300);
      const sunGlow = glow('rgba(255,230,180,0.55)', 'rgba(255,210,140,0)', 760);
      sunGlow.position.copy(sunDir).multiplyScalar(2280);
      skyRig.add(sunDisc, sunGlow);
      sunSprites.push(sunDisc, sunGlow);
      this._celestialObjects.push(sunDisc, sunGlow);
      // No cloud sprites: semi-transparent sky quads read as tinted slabs at
      // certain angles (verified by hiding all sprites — sky went clean).
      // Clouds belong painted into the sky-dome texture, where alpha blending
      // and sprite shear cannot produce panes.
    } else if (th.stars !== false) {
      // Dark rural/coastal nights retain small round stars. Urban Singapore and
      // Las Vegas deliberately skip this whole branch in favour of skyglow.
      const starGeo = new THREE.BufferGeometry();
      const sp = new Float32Array(420 * 3);
      for (let i = 0; i < 420; i++) {
        const az = effectsRandom() * Math.PI * 2, el = effectsRandom() * Math.PI * 0.42 + 0.14;
        const r = 2350;
        sp[i * 3] = Math.cos(az) * Math.cos(el) * r;
        sp[i * 3 + 1] = Math.sin(el) * r;
        sp[i * 3 + 2] = Math.sin(az) * Math.cos(el) * r;
      }
      starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
      // soft round star sprite (hard unfiltered squares read as stray pixels)
      const starC = document.createElement('canvas');
      starC.width = starC.height = 32;
      const sg2 = starC.getContext('2d');
      const sgr = sg2.createRadialGradient(16, 16, 0, 16, 16, 16);
      sgr.addColorStop(0, 'rgba(255,255,255,1)');
      sgr.addColorStop(0.4, 'rgba(230,236,255,0.6)');
      sgr.addColorStop(1, 'rgba(230,236,255,0)');
      sg2.fillStyle = sgr;
      sg2.fillRect(0, 0, 32, 32);
      const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
        map: mkTex(starC), color: 0xcdd8ff, size: 1, sizeAttenuation: false,
        fog: false, transparent: true, opacity: 0.62, alphaTest: 0.20, depthWrite: false,
      }));
      stars.name = 'stars';
      skyRig.add(stars);
      this._celestialObjects.push(stars);
      const mc = document.createElement('canvas');
      mc.width = mc.height = 128;
      const mg = mc.getContext('2d');
      const mgrad = mg.createRadialGradient(64, 64, 10, 64, 64, 64);
      mgrad.addColorStop(0, 'rgba(235,240,255,1)');
      mgrad.addColorStop(0.35, 'rgba(220,228,250,0.9)');
      mgrad.addColorStop(1, 'rgba(220,228,250,0)');
      mg.fillStyle = mgrad;
      mg.fillRect(0, 0, 128, 128);
      const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: mkTex(mc), transparent: true, depthWrite: false, fog: false }));
      moon.name = 'moon';
      moon.scale.setScalar(190);
      moon.position.set(-1200, 1300, -900);
      skyRig.add(moon);
      this._celestialObjects.push(moon);
    }

    this.effects = new Effects(this.scene, effectsRandom);
    // The controller selects its initial tier before a session owns an Effects
    // instance, so apply it once here as well as in the live tier callback.
    this.effects.setQualityTier(this.quality.tier);
    this.effects.bindEnvironment?.(this.circuit?.trackState);

    // Lighting: photographic HDRI sky + true IBL when loaded; PMREM-from-dome
    // fallback renders immediately while only this session's theme downloads.
    const sceneForEnvironment = this.scene;
    const applyHDRI = (hdr) => {
      if (this.scene !== sceneForEnvironment || !hdr) return;
      sceneForEnvironment.environment = hdr;
      sceneForEnvironment.environmentIntensity = this._look.env = renderLook.environmentIntensity;
      if (th.night && !th.proceduralSky) {
        sceneForEnvironment.background = hdr;
        sceneForEnvironment.backgroundIntensity = 0.7;
        sky.visible = false;
      } else {
        sceneForEnvironment.background = null;
        sky.visible = true;
        const photo = !th.night && SKY[environmentKey];
        if (!photo && !th.night && SKY_PHOTO[environmentKey]) {
          // late or previously failed photo: fetch (again) and apply when it lands
          loadSkyPhoto(environmentKey).then((tex) => {
            if (tex && this.scene === sceneForEnvironment) applyHDRI(hdr);
          });
        }
        if (photo && sky.material.map !== photo) {
          const procedural = sky.material.map;
          sky.material.map = photo;
          // the photograph carries its own sun: the painted disc and glow would be a second one
          for (const sprite of sunSprites) sprite.visible = false;
          sky.material.color.setScalar(SKY_PHOTO_GAIN);
          // Distant scenery now fades into the photographed horizon, not the
          // painted dome's: move the fog (and the weather grade's fog base) to it.
          const hz = SKY_PHOTO_HORIZON[environmentKey];
          if (hz && sceneForEnvironment.fog) {
            sceneForEnvironment.fog.color.set(th.fog).lerp(_lookC.setRGB(hz[0], hz[1], hz[2]), 0.8);
            if (this._look) this._look.fog.copy(sceneForEnvironment.fog.color);
          }
          sky.material.needsUpdate = true;
          if (procedural) procedural.dispose();
        }
      }
      if (this._envRT) { this._envRT.dispose(); this._envRT = null; }
      this._envIsHDRI = true;
    };
    const hdr = HDRI[environmentKey];
    if (hdr) {
      applyHDRI(hdr);
    } else {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const envScene = new THREE.Scene();
      const envSky = sky.clone();
      envScene.add(envSky);
      const groundDisc = new THREE.Mesh(
        new THREE.CircleGeometry(2000, 24).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: th.ground })
      );
      groundDisc.position.y = -2;
      envScene.add(groundDisc);
      this._envRT = pmrem.fromScene(envScene, 0.04);
      this.scene.environment = this._envRT.texture;
      this.scene.environmentIntensity = this._look.env = renderLook.fallbackEnvironmentIntensity;
      this._envIsHDRI = false;
      pmrem.dispose();
      groundDisc.geometry.dispose();
      groundDisc.material.dispose();
      loadHDRI(environmentKey).then(applyHDRI).catch(() => {
        // The procedural PMREM environment remains a complete offline fallback.
      });
    }

    // post-processing: AO grounds everything, bloom lifts lights, then output
    this.composer = new EffectComposer(this.renderer);
    // One shadow-map update per composed frame. GTAO re-renders the whole scene
    // for its normal/depth buffer, and with autoUpdate on that second render
    // rasterised every shadow caster again for a map nothing would read.
    const scenePass = new RenderPass(this.scene, this.camera);
    const renderScenePass = scenePass.render;
    scenePass.render = (...args) => {
      this.renderer.shadowMap.needsUpdate = true;
      renderScenePass.apply(scenePass, args);
    };
    this.renderer.shadowMap.autoUpdate = false;
    this.composer.addPass(scenePass);
    this.gtao = new ScaledGTAOPass(this.scene, this.camera, innerWidth, innerHeight, 0.5, {
      noiseRandom: createRendererNoiseRandom(),
    });
    this.gtao.output = ScaledGTAOPass.OUTPUT.Default;
    this.gtao.blendIntensity = 0.72; // 0.9 visibly darkened additive effects (sparks) in AO-heavy corners
    this.gtao.enabled = this.ui.settings.gtao !== false;
    this.composer.addPass(this.gtao);
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(innerWidth, innerHeight),
      // Night bloom stays tight and selective: fixture cores still read as hot,
      // but their halos no longer merge down a straight or bleach road detail.
      renderLook.bloomStrength,
      renderLook.bloomRadius,
      renderLook.bloomThreshold
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.fxaa = new FXAAPass();
    this.composer.addPass(this.fxaa);
    // Final film pass. `game._filmPass.uniforms.speed.value` (0..1) is the
    // radial speed blur; set `game._filmSpeed` to a number to drive it from the
    // camera instead of the built-in player-speed mapping in _lookUpdate().
    const film = this._filmPass = new ShaderPass(FILM_SHADER);
    const fl = FILM_LOOK[th.night ? 'night' : environmentKey] || FILM_LOOK.day;
    film.uniforms.g.value.set(fl[0], fl[1], fl[2], fl[3]);
    film.uniforms.grain.value = fl[4];
    film.uniforms.tint.value.set(fl[5], fl[6], fl[7]);
    this.composer.addPass(film);
    this.quality.bind({ composer: this.composer, gtao: this.gtao, bloom: this.bloom, sun: this.sun, film });
  }

  // Presentation-only per-frame look: sun shadow frustum, weather grade and the
  // film pass uniforms. Runs only when a frame is painted (never in ?simOnly=1)
  // and never writes simulation state. While paused every eased value snaps to
  // its target and the grain seed is fixed, so frozen frames are reproducible.
  _lookUpdate(dt) {
    const sun = this.sun, L = this._look;
    if (!sun || !L || !this.scene) return;
    const snap = this.paused || !(dt > 0);
    const ease = (rate) => (snap ? 1 : Math.min(1, dt * rate));
    // --- weather. Overcast (the weather model's own > 0.72 threshold) or rain
    // dims and cools the sun and greys the fog; the exposure nudge and the
    // desaturation live in the film pass. The pinned look numbers (sun/hemi
    // intensity, tone-mapping exposure) are never written: the sun is dimmed
    // through its colour. Fog distance and IBL level move only while it rains.
    const weather = this.circuit?.weather?.current;
    const cloud = Math.min(1, Math.max(0, ((weather?.cloudCover ?? 0) - 0.72) / 0.18));
    const rainT = Math.min(1, Math.max(0, ((weather?.rainfall || 0) - 0.08) / 6));
    L.wx += (Math.max(cloud * cloud * (3 - 2 * cloud), rainT) - L.wx) * ease(0.45);
    L.rain += (rainT - L.rain) * ease(0.45);
    const w = L.wx < 0.002 ? 0 : L.wx, r = L.rain < 0.002 ? 0 : L.rain;
    const fog = this.scene.fog, film = this._filmPass;
    sun.color.copy(L.sun).lerp(_lookC.set(0xc9d6e6), 0.7 * w).multiplyScalar(1 - 0.58 * w);
    sun.shadow.radius = 1 + L.shade * (1 - 0.8 * w);
    const grey = (L.fog.r + L.fog.g + L.fog.b) / 3 * (1 - 0.12 * w);
    fog.color.copy(L.fog).lerp(_lookC.setRGB(grey * 0.97, grey, grey * 1.04), 0.75 * w);
    fog.near = L.near * (1 - 0.5 * r);
    fog.far = L.far * (1 - 0.38 * r);
    if (L.env) this.scene.environmentIntensity = L.env * (1 - 0.26 * r);
    // --- sun shadow frustum: ahead of the camera, texel-snapped
    const shadowsOn = this.renderer.shadowMap.enabled && sun.castShadow;
    const size = sun.shadow.mapSize.x;
    const R = size >= 3072 ? 140 : 115;
    if (size !== this._shadowSize) {
      this._shadowSize = size;
      const sc = sun.shadow.camera;
      sc.left = sc.bottom = -R; sc.right = sc.top = R;
      sc.near = 250; sc.far = 760;
      sc.updateProjectionMatrix();
      sun.shadow.bias = -0.00012;
      sun.shadow.normalBias = (2 * R / size) * 1.3;
    }
    // Height comes from the followed car's own rendered pose, so the frustum
    // is right on the grid and under pause too, where updateCamera() is idle.
    const focus = this.session?.focusEntry || this.session?.player;
    const ty = focus?.mesh?.position.y ?? sun.target.position.y, texel = 2 * R / size;
    this.camera.getWorldDirection(_lookV);
    let cx = this.camera.position.x + _lookV.x * R * 0.62, cz = this.camera.position.z + _lookV.z * R * 0.62;
    // light-space right/up for this look's sun offset (see _sunBasis)
    const B = this._sunBasis, off = this._sunOffset;
    const lr = cx * B.rx + cz * B.rz, lu = cx * B.ux + ty * B.uy + cz * B.uz;
    const px = Math.round(lr / texel) * texel - lr;
    const py = Math.round(lu / texel) * texel - lu;
    // (the light-up correction is applied horizontally so target height is
    // never fed back into the next frame's snap)
    cx += (px * B.uz - B.rz * py) / B.det; cz += (B.rx * py - B.ux * px) / B.det;
    sun.position.set(cx + off[0], ty + off[1], cz + off[2]);
    sun.target.position.set(cx, ty, cz);
    sun.target.updateMatrixWorld();
    // baked structure/canopy shade steps back wherever real shadows now fall,
    // and returns as overcast takes the real ones away
    const fade = this.circuit?.group?.userData.shadeFade;
    if (fade) fade.value.set(cx, cz, shadowsOn && !this.circuit.theme.night ? R * 0.9 : 0.001, 0.4 + 0.6 * w);
    // --- film pass
    if (!film) return;
    const v = Number.isFinite(this._filmSpeed) ? this._filmSpeed
      // the camera's own speed-sensation value (already scaled by the Camera
      // Motion setting and reduced motion), so blur, FOV and shake move together
      : Number.isFinite(this._speedFx) ? this._speedFx * (this.camMode === 1 ? 0.35 : 1)
      // a screen-space blur cannot spare the cockpit interior, so it is mostly held back there
      : (this._reducedMotion ? 0 : Math.min(1, Math.max(0, ((focus?.phys?.v || 0) - 42) / 50)) * (this.camMode === 1 ? 0.35 : 1));
    L.speed += (v - L.speed) * ease(3);
    film.uniforms.speed.value = L.speed * L.speed;
    film.uniforms.wx.value = w;
    film.uniforms.seed.value = snap || this._reducedMotion ? 0 : (L.frame = (L.frame + 1) % 61);
  }

  applyVenueCarLighting() {
    if (this.circuit?.theme?.nightRig !== 'lasvegas' || !this.session) return;
    const patched = new Set();
    for (const entry of this.session.entries) entry.mesh?.traverse((object) => {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material || patched.has(material) || material.userData?.shared
          || (!material.isMeshStandardMaterial && !material.isMeshPhysicalMaterial)) continue;
        patched.add(material);
        const previousCompile = material.onBeforeCompile?.bind(material);
        const previousKey = material.customProgramCacheKey?.bind(material) || (() => '');
        material.onBeforeCompile = (shader, renderer) => {
          previousCompile?.(shader, renderer);
          const common = '#include <common>';
          const begin = '#include <begin_vertex>';
          // three r154 renamed output_fragment to opaque_fragment; the vendored r160
          // only has the new name, so the old literal made this guard throw on
          // every frame and Las Vegas rendered black.
          const output = shader.fragmentShader.includes('#include <opaque_fragment>')
            ? '#include <opaque_fragment>' : '#include <output_fragment>';
          if (!shader.vertexShader.includes(common) || !shader.vertexShader.includes(begin)
            || !shader.fragmentShader.includes(common) || !shader.fragmentShader.includes(output)) {
            throw new Error('Las Vegas rim-light shader chunks changed; refusing an unpinned patch');
          }
          shader.vertexShader = shader.vertexShader
            .replace(common, `${common}\nvarying vec3 vApexVegasWorld;`)
            .replace(begin, `${begin}\n  vApexVegasWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
          shader.fragmentShader = shader.fragmentShader
            .replace(common, `${common}\nvarying vec3 vApexVegasWorld;`)
            .replace(output, `
  float apexVegasBand = mod(floor((dot(vApexVegasWorld.xz, vec2(0.70710678)) / 100.0) + 4096.0), 4.0);
  vec3 apexVegasWash = apexVegasBand < 0.5 ? vec3(1.0, 0.0296, 0.2874)
    : apexVegasBand < 1.5 ? vec3(0.0176, 0.5776, 1.0)
    : apexVegasBand < 2.5 ? vec3(0.2582, 0.1022, 1.0)
    : vec3(1.0, 0.2582, 0.0176);
  float apexVegasRim = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 4.0);
  outgoingLight += apexVegasWash * apexVegasRim * 0.58;
  ${output}`);
        };
        material.customProgramCacheKey = () => `${previousKey()}|apex-lasvegas-rim-100m-v1`;
        material.userData.venueRimLight = {
          venue: 'lasvegas', cycleM: 100, colours: [0xff2f92, 0x24c8ff, 0x8b5cff, 0xff8b24],
          dryAir: true, bloomHaze: false,
        };
        material.needsUpdate = true;
      }
    });
  }

  // ---------- input ----------
  // Some environments (embedded browser panes, certain WebViews/IMEs) deliver
  // trusted key events with an EMPTY e.code and only e.key populated. Normalize
  // both channels to the e.code vocabulary so controls work everywhere.
  static normalizeKey(e) {
    if (e.code) return e.code;
    const k = e.key;
    if (!k) return '';
    if (k.startsWith('Arrow') || k === 'Escape' || k === 'Enter' || k === 'Tab') return k;
    if (k === ' ' || k === 'Spacebar') return 'Space';
    if (k.length === 1) {
      const c = k.toUpperCase();
      if (c >= 'A' && c <= 'Z') return 'Key' + c;
      if (c >= '0' && c <= '9') return 'Digit' + c;
    }
    return k;
  }

  onKey(e, down) {
    if (this.replay?.onKey(e, down)) return;
    const code = Game.normalizeKey(e);
    if (!code) return;
    const driving = this.state === 'race' || this.state === 'quali';
    // stop the page from scrolling / space-activating buttons while driving
    if (driving && (code.startsWith('Arrow') || code === 'Space' || code === 'Enter')) e.preventDefault();
    if (e.repeat) return;
    if (!down) { this.keys[code] = false; return; }
    if (driving && this.awaitingStart && code === 'Enter') {
      this.beginSessionFromGate();
      return;
    }
    if (code === 'Escape') {
      if (driving) this.togglePause();
      return;
    }
    if (!driving || this.paused || this.awaitingStart) return;
    // Held keys are read from this map where they are used: driving in
    // playerInput(), look (Z left, X right, G or Z+X behind) in updateCamera().
    this.keys[code] = true;
    if (code === 'KeyE') this.queueShift(1);
    if (code === 'KeyQ') this.queueShift(-1);
    if (code === 'KeyV') {
      this.ersMode = ((this.ersMode ?? 1) + 1) % 3;
      this.hud.message(['ERS: HARVEST', 'ERS: BALANCED', 'ERS: ATTACK'][this.ersMode], this.ersMode === 2 ? 'yellow' : '');
    }
    if (code === 'KeyC') {
      this.camMode = (this.camMode + 1) % 4;
      this.hud.setCockpitMode(this.camMode === 1);
      this.hud.message(['CAMERA: CHASE', 'CAMERA: COCKPIT', 'CAMERA: T-CAM', 'CAMERA: NOSE'][this.camMode]);
      this.snapCamera();
    }
    if (code === 'KeyB') this.hud.nextCockpitPage();
    // H, not G: G is the held look-behind key
    if (code === 'KeyH') this.hud.message(`RACING LINE: ${RacingLine.cycle(this.ui)}`);
    if (code === 'KeyJ') this.exportGhostReplay();
    if (code === 'KeyP') this.session && this.session.playerRequestBox();
    if (code === 'KeyL' && this.session?.player?.phys) {
      // Toggle the INPUT-side flag, not phys.pitLimiter: physics re-derives
      // its flag from input.pitLimiter every step, so a direct phys write
      // lasted exactly one frame — the player got a PIT LIMITER ON toast
      // while the limiter stayed off. Same source the wheel button uses.
      this.pitLimiter = !this.pitLimiter;
      this.hud.message(this.pitLimiter ? 'PIT LIMITER ON' : 'PIT LIMITER OFF',
        this.pitLimiter ? 'yellow' : '');
    }
    if (code === 'KeyN') {
      this.ui.settings.nametags = !this.ui.settings.nametags;
      this.ui.saveSettings();
      this.session && this.session.setNametags(this.ui.settings.nametags);
    }
    if (code === 'KeyM') {
      this.ui.settings.volume = this.ui.settings.volume > 0 ? 0 : 0.8;
      this.ui.saveSettings();
      this.audio.setVolume(this.ui.settings.volume);
    }
  }

  togglePause(force) {
    const want = force !== undefined ? force : !this.paused;
    if (this.onboardingActive && !want) return;
    this.paused = want;
    this.resetSimulationTiming();
    if (want) {
      this.ui.showPause();
      this.audio.stopEngine();
      if (this.session && this.session.phase === 'lights' && this.audio.stopCrescendo) this.audio.stopCrescendo();
    }
    else {
      this.ui.hidePause();
      if (this.awaitingStart) {
        this.audio.stopEngine();
        this.hud.showSessionReady(() => this.beginSessionFromGate());
      } else if (documentIsActive()) this.audio.startEngine();
      else this.audio.stopEngine();
    }
  }

  beginSessionFromGate() {
    if (!this.awaitingStart) return false;
    this.awaitingStart = false;
    this.paused = false;
    this.hud.hideSessionReady();
    this.resetSimulationTiming();
    if (documentIsActive()) this.audio.startEngine();
    else this.audio.stopEngine();
    return true;
  }

  resetSimulationTiming() {
    // Rebase Three's wall clock as well as the fixed-step remainder so loading,
    // tab suspension and pause time cannot arrive as one large frame later.
    if (this.clock) this.clock.getDelta();
    this.fixedStep.reset();
    this.pacing = { steps: 0, simulatedDt: 0, alpha: 0, droppedDt: 0 };
    this.releaseDrivingInputs();
    this.session?.resetRenderState?.();
  }

  releaseDrivingInputs() {
    this.keys = {};
    this.keySteer = 0;
    this._steerInputMode = null;
    this._shiftQueue.length = 0;
    this._gamepadShiftUp = false;
    this._gamepadShiftDown = false;
    this._gamepadNeedsNeutral = true;
    this._gamepadSteeringActive = false;
    this._wheelNeedsNeutral = true;
    this._wheelSteeringActive = false;
    this._wheelState = null;
    this.wheelInput.stopRumble();
    this.padRumble?.stop();
    this.hud?.clearTouchState?.();
  }

  queueShift(direction) {
    if (this._shiftQueue.length >= 8) return;
    this._shiftQueue.push(direction > 0 ? 1 : -1);
  }

  exportGhostReplay() {
    if (!this.timeTrial) {
      this.hud.message('GHOST EXPORT AVAILABLE IN TIME TRIAL', 'yellow');
      return false;
    }
    const ok = this.timeTrial.downloadReplay();
    this.hud.message(ok ? 'DETERMINISTIC GHOST JSON EXPORTED' : 'COMPLETE A LAP TO EXPORT', ok ? 'green' : 'yellow');
    return ok;
  }

  _nearbyOpponentAudio(session, player) {
    const entries = this._audioNearbyEntries;
    const distances = this._audioNearbyDistances;
    for (let i = 0; i < 4; i++) { entries[i] = null; distances[i] = Infinity; }
    for (const entry of session?.entries || []) {
      if (entry.isPlayer || entry.dnf || entry.phys?.disabled) continue;
      const dx = entry.phys.pos.x - player.pos.x, dz = entry.phys.pos.z - player.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 70 * 70 || d2 >= distances[3]) continue;
      let slot = 3;
      while (slot > 0 && d2 < distances[slot - 1]) {
        distances[slot] = distances[slot - 1]; entries[slot] = entries[slot - 1]; slot--;
      }
      distances[slot] = d2; entries[slot] = entry;
    }
    const cues = this._audioOpponentCues;
    cues.length = 0;
    for (let i = 0; i < 4 && entries[i]; i++) {
      const other = entries[i].phys;
      const dx = other.pos.x - player.pos.x, dz = other.pos.z - player.pos.z;
      const cue = this._audioOpponentCuePool[i];
      cue.id = entries[i].driver?.id || String(i);
      // Web Audio pan is positive to the right; driverLateral is positive left.
      cue.side = -Math.sign(driverLateral(dx, dz, player.heading)) || 1;
      cue.distance = Math.sqrt(distances[i]);
      cue.relativeSpeed = other.v - player.v;
      cue.rpmFrac = other.rpmFrac;
      cue.intensity = Math.max(0, 1 - cue.distance / 70);
      cues.push(cue);
    }
    return cues;
  }

  _wheelLockup(physics) {
    let lockup = 0;
    for (const wheel of physics?.wheels || []) lockup = Math.max(lockup, -Number(wheel.slipRatio || 0));
    return Math.min(1, lockup);
  }

  _wheelspin(physics) {
    const rear = physics?.wheels?.slice(2) || [];
    let spin = 0;
    for (const wheel of rear) spin = Math.max(spin, Number(wheel.slipRatio || 0));
    return Math.max(0, Math.min(1, (spin - 0.06) / 0.5));
  }

  pollWheelControls() {
    const status = this.wheelInput.poll();
    this._wheelState = status.input;
    if (status.connectedNow) {
      this._wheelNeedsNeutral = true;
      this._wheelSteeringActive = false;
      this.keySteer = 0;
      this._steerInputMode = null;
      if (this.session) this.hud.message(`${status.device.label.toUpperCase()} CONNECTED`, 'green');
    } else if (status.disconnected) {
      this._wheelNeedsNeutral = false;
      this._wheelSteeringActive = false;
      this._wheelState = null;
      this.keySteer = 0;
      this._steerInputMode = null;
      if (this.session) this.hud.message('WHEEL DISCONNECTED · KEYBOARD ACTIVE', 'yellow');
    }
    if (!status.input) return;
    if (this._wheelNeedsNeutral) {
      if (wheelInputIsNeutral(status.input)) this._wheelNeedsNeutral = false;
      return;
    }
    const driving = this.state === 'race' || this.state === 'quali';
    if (!driving) return;
    if (status.pressedActions.includes('pause')) {
      this.togglePause();
      return;
    }
    if (this.paused || this.awaitingStart) return;
    for (const action of status.pressedActions) {
      if (action === 'shiftUp') this.queueShift(1);
      else if (action === 'shiftDown') this.queueShift(-1);
      else if (action === 'ersMode') {
        this.ersMode = ((this.ersMode ?? 1) + 1) % 3;
        this.hud.message(['ERS: HARVEST', 'ERS: BALANCED', 'ERS: ATTACK'][this.ersMode], this.ersMode === 2 ? 'yellow' : '');
      } else if (action === 'pitLimiter') {
        this.pitLimiter = !this.pitLimiter;
        this.hud.message(`PIT LIMITER: ${this.pitLimiter ? 'ON' : 'OFF'}`, this.pitLimiter ? 'yellow' : '');
      } else if (action === 'camera') {
        this.camMode = (this.camMode + 1) % 4;
        this.hud.setCockpitMode(this.camMode === 1);
        this.hud.message(['CAMERA: CHASE', 'CAMERA: COCKPIT', 'CAMERA: T-CAM', 'CAMERA: NOSE'][this.camMode]);
        this.snapCamera();
      } else if (action === 'boxRequest') {
        this.session?.playerRequestBox();
      }
    }
  }

  playerInput(dt) {
    const k = this.keys;
    let digitalDir = 0;
    let digitalSteerActive = false;
    if (k.KeyA || k.ArrowLeft) { digitalDir += 1; digitalSteerActive = true; }
    if (k.KeyD || k.ArrowRight) { digitalDir -= 1; digitalSteerActive = true; }
    let throttle = (k.KeyW || k.ArrowUp) ? 1 : 0;
    let brake = (k.KeyS || k.ArrowDown) ? 1 : 0;
    let boost = !!k.Space;
    let clutch = 0;
    let directGear = null;
    const touch = this.hud.touchState;
    if (touch) {
      if (touch.left) { digitalDir += 1; digitalSteerActive = true; }
      if (touch.right) { digitalDir -= 1; digitalSteerActive = true; }
      if (touch.throttle) throttle = 1;
      if (touch.brake) brake = 1;
      if (touch.boost) boost = true;
    }
    let dir = digitalDir;
    let steerInputMode = digitalSteerActive ? 'digital' : null;
    let shiftUp = false, shiftDown = false;
    const wheel = this._wheelNeedsNeutral ? null : this._wheelState;
    if (wheel) {
      const wheelSteerMagnitude = Math.abs(wheel.steer);
      if (!this._wheelSteeringActive && wheelSteerMagnitude >= 0.10) {
        this._wheelSteeringActive = true;
      } else if (this._wheelSteeringActive && wheelSteerMagnitude <= 0.04) {
        this._wheelSteeringActive = false;
      }
      if (this._wheelSteeringActive && !digitalSteerActive) {
        dir = wheel.steer;
        steerInputMode = 'wheel';
      }
      if (wheel.throttle > 0.01) throttle = Math.max(throttle, wheel.throttle);
      if (wheel.brake > 0.01) brake = Math.max(brake, wheel.brake);
      clutch = wheel.clutch;
      directGear = wheel.gear;
      if (wheel.actions.boost) boost = true;
    } else this._wheelSteeringActive = false;
    // gamepad
    const gamepads = navigator.getGamepads ? [...navigator.getGamepads()] : [];
    const gp = gamepads.find(candidate => candidate && candidate.index !== this.wheelInput.gamepad?.index);
    // Latest snapshot for the camera's right-stick look and for pad rumble.
    this._pad = gp || null;
    if (gp) {
      const ax = gp.axes[0] || 0;
      const axisMagnitude = Math.abs(ax);
      const rt = gp.buttons[7]?.value || 0, lt = gp.buttons[6]?.value || 0;
      const gamepadBoost = !!gp.buttons[0]?.pressed;
      const gamepadUp = !!gp.buttons[5]?.pressed;
      const gamepadDown = !!gp.buttons[4]?.pressed;
      const neutral = axisMagnitude <= 0.12 && rt <= 0.03 && lt <= 0.03 &&
        !gamepadBoost && !gamepadUp && !gamepadDown;
      if (this._gamepadNeedsNeutral) {
        // After pause/focus loss, require every relevant control to be released
        // once. This prevents a held trigger, stick or bumper from reasserting
        // input on the first resumed simulation tick.
        this._gamepadShiftUp = gamepadUp;
        this._gamepadShiftDown = gamepadDown;
        if (neutral) {
          this._gamepadNeedsNeutral = false;
          this._gamepadSteeringActive = false;
          this._gamepadShiftUp = false;
          this._gamepadShiftDown = false;
        }
      } else {
        // An actively held key/touch control always wins over a connected
        // controller's idle-axis drift. Analog steering remains unchanged when
        // no digital direction is being requested.
        if (!this._gamepadSteeringActive && axisMagnitude >= 0.22) {
          this._gamepadSteeringActive = true;
        } else if (this._gamepadSteeringActive && axisMagnitude <= 0.10) {
          this._gamepadSteeringActive = false;
        }
        if (this._gamepadSteeringActive && !digitalSteerActive) {
          const scaledAxis = Math.sign(ax) * Math.max(0, (axisMagnitude - 0.12) / 0.88);
          dir = -scaledAxis;
          steerInputMode = 'analog';
        }
        if (rt > 0.03) throttle = rt;
        if (lt > 0.03) brake = lt;
        if (gamepadBoost) boost = true;
        if (gamepadUp && !this._gamepadShiftUp) this.queueShift(1);
        if (gamepadDown && !this._gamepadShiftDown) this.queueShift(-1);
        this._gamepadShiftUp = gamepadUp;
        this._gamepadShiftDown = gamepadDown;
      }
    } else {
      this._gamepadShiftUp = false;
      this._gamepadShiftDown = false;
      this._gamepadNeedsNeutral = false;
      this._gamepadSteeringActive = false;
    }
    const phys = this.session?.player?.phys;
    if (this.ui.settings.autoGear) {
      this._shiftQueue.length = 0;
    } else if (phys && phys._shiftCooldown <= 0) {
      // Preserve press order and keep requests queued through the gearbox's
      // 150 ms cooldown. Impossible boundary shifts are discarded explicitly.
      while (this._shiftQueue.length) {
        const direction = this._shiftQueue[0];
        if ((direction > 0 && phys.gear >= 8) || (direction < 0 && phys.gear <= 1)) {
          this._shiftQueue.shift();
          continue;
        }
        this._shiftQueue.shift();
        shiftUp = direction > 0;
        shiftDown = direction < 0;
        break;
      }
    }
    const v = this.session?.player?.phys.v || 0;
    if (steerInputMode) this._steerInputMode = steerInputMode;
    if (steerInputMode === 'wheel') {
      this.keySteer = analogSteeringInput(dir);
    } else {
      const digitalResponse = steerInputMode === 'digital' ||
        (dir === 0 && this._steerInputMode === 'digital');
      const steeringTarget = steerInputMode === 'digital'
        ? dir * digitalSteeringLimit(v)
        : dir;
      this.keySteer = advanceSteeringInput(
        this.keySteer, steeringTarget, v, dt, digitalResponse, this.ui.settings.steeringResponse,
      );
    }
    if (dir === 0 && this.keySteer === 0) this._steerInputMode = null;
    return {
      steer: this.keySteer, throttle, brake, clutch, boost, shiftUp, shiftDown,
      gear: directGear, pitLimiter: this.pitLimiter, ersMode: this.ersMode ?? 1,
    };
  }

  // ---------- camera ----------
  // road height at (and ahead of) the player, for render-only elevation
  _roadY(p, aheadM = 0) {
    const c = this.circuit;
    if (!c || !c.heightAt) return 0;
    const sm = c.samples[p.sampleIdx];
    const along = (p.pos.x - sm.p.x) * sm.t.x + (p.pos.z - sm.p.z) * sm.t.z;
    return c.heightAt(p.sampleIdx + (along + aheadM) / c.ds);
  }

  // Render-only road height change `aheadM` metres along the car's own path
  // (pit-corridor aware): the camera follows a gradient instead of trailing it.
  _roadRise(p, aheadM) {
    const path = p.corridor || this.circuit;
    const sm = path?.samples?.[p.sampleIdx];
    if (!sm || !path.heightAt) return 0;
    const at = p.sampleIdx + ((p.pos.x - sm.p.x) * sm.t.x + (p.pos.z - sm.p.z) * sm.t.z) / path.ds;
    return path.heightAt(at + aheadM / path.ds) - path.heightAt(at);
  }

  snapCamera() {
    const e = this.session?.focusEntry || this.session?.player;
    if (!e?.phys) return;
    // A snap is a hard cut: updateCamera(0) places the rig with every smoothed
    // quantity collapsed onto the car (no lean, no shake), so the cut and the
    // frame after it can never disagree about the framing.
    (this._camRig || (this._camRig = {})).snap = true;
    this.updateCamera(0);
  }

  updateCamera(dt) {
    // The replay director owns the camera while it is active -- except for a
    // snap: snapCamera() asks for the game's own pose through updateCamera(0),
    // and the director itself calls snapCamera() to blend back from the start
    // showcase. Handing that call back to the director recursed without end and
    // froze the view the moment a player pressed Enter on the start gate.
    if (this.replay?.cameraActive && !this._camRig?.snap) return this.replay.updateCamera(dt);
    const e = this.session?.focusEntry || this.session?.player;
    if (!e) return;
    const p = e.phys;
    const pose = e.renderPose;
    const pos = pose ? this._camPlayerPos.set(pose.x, 0, pose.z) : p.pos;
    const heading = pose?.heading ?? p.heading;
    const speed = pose?.v ?? p.v;
    const ry = pose?.y ?? this._roadY(p);
    const mode = this.camMode;
    const settings = this.ui.settings;
    const clamp = THREE.MathUtils.clamp;
    const rig = this._camRig || (this._camRig = {});
    const snap = rig.snap !== false;
    rig.snap = false;
    this.hud.setCockpitMode(mode === 1);

    // ---- Camera Motion setting and held look (Z / X / G, right stick) ----
    rig.age = snap ? 1 : rig.age + dt;
    if (rig.age >= 0.5) {
      // matchMedia allocates, so the OS preference is polled, not read per frame.
      rig.age = 0;
      resolveCameraMotion(settings.cameraMotion, this.ui._reducedMotion(), rig);
    }
    const motion = rig.motion;
    const keys = this.keys;
    const pad = this._pad;
    let look = (keys.KeyZ ? 1 : 0) - (keys.KeyX ? 1 : 0);
    let back = !!(keys.KeyG || (keys.KeyZ && keys.KeyX));
    if (pad?.mapping === 'standard') {
      const stick = pad.axes[2] || 0;
      if (Math.abs(stick) > 0.2) look -= Math.sign(stick) * (Math.abs(stick) - 0.2) / 0.8;
      back ||= (pad.axes[3] || 0) > 0.7 || !!pad.buttons[11]?.pressed;
    }
    look = back ? 0 : clamp(look, -1, 1) * CAMERA_FEEL.lookSideRad[mode];
    rig.look = snap ? look : rig.look + (look - rig.look) * damp(13, dt);

    // ---- smoothed driving signals, read from the car and never written back ----
    const feel = speedSensation(speed, p.boosting);
    if (snap) {
      rig.speed = feel;
      rig.yaw = heading;
      rig.gLong = rig.gLat = rig.head = rig.shake = rig.impact = rig.aimX = rig.aimZ = 0;
      rig.clock = rig.clock || 0;
    } else {
      // A parked car sits level, whatever its residual numerical accelerations.
      const moving = Math.abs(speed) > 0.5;
      const g = damp(5, dt);
      rig.speed += (feel - rig.speed) * damp(feel > rig.speed ? 2.4 : 3.6, dt);
      rig.gLong += ((moving ? clamp(finiteCameraValue(p.longitudinalAcceleration), -55, 22) : 0) - rig.gLong) * g;
      rig.gLat += ((moving ? clamp(finiteCameraValue(p.lateralAcceleration), -45, 45) : 0) - rig.gLat) * g;
      rig.impact = Math.max(rig.impact * Math.exp(-5.5 * dt), finiteCameraValue(p.impactKick));
    }
    // 0..1 sense of speed for post-processing and the HUD overlays. It already
    // carries the Camera Motion / reduced-motion scale, so consumers need none.
    this._speedFx = rig.speed * motion;
    this.hud.fx = motion;

    const targetPos = this._camTargetPos;
    const targetLook = this._camTargetLook;
    const fx = Math.sin(heading), fz = Math.cos(heading);
    const cosLook = back ? -1 : Math.cos(rig.look);
    let fov;
    let roll = 0;
    let shakeScale = 1;
    if (mode === 0) {
      const framing = resolveChaseCamera(settings.cameraProfile, speed, p.boosting, this._camFraming);
      // The rig swings in behind the heading with a lag, so the car visibly
      // rotates into a corner, and it leans toward the direction of travel in
      // a slide so the slip angle stays readable instead of the world spinning.
      const slip = clamp(finiteCameraValue(p.sideslip), -0.5, 0.5) * CAMERA_FEEL.slipFollow *
        clamp((speed - 8) / 16, 0, 1);
      const swing = Math.atan2(Math.sin(heading + slip - rig.yaw), Math.cos(heading + slip - rig.yaw));
      // A respawn or pit teleport is a cut, not a half-turn pan.
      rig.yaw = Math.abs(swing) > 2.2 ? heading + slip : rig.yaw + swing * damp(CAMERA_FEEL.yawRate, dt);
      const view = rig.yaw + (back ? Math.PI : rig.look);
      const vx = Math.sin(view), vz = Math.cos(view);
      const orbit = back ? 0 : Math.abs(Math.sin(rig.look));
      // g-force: the rig lags under power, closes up under braking or impact,
      // and is thrown to the outside of a corner while it banks into the turn.
      const surge = clamp(rig.gLong * (rig.gLong > 0 ? CAMERA_FEEL.accelPullM : CAMERA_FEEL.brakePushM), -1, 0.9) -
        rig.impact * 0.45;
      const dist = (framing.back + (rig.speed * CAMERA_FEEL.speedPullM + surge) * motion) * (1 - 0.25 * orbit);
      const shift = -clamp(rig.gLat * CAMERA_FEEL.lateralShiftM, -0.5, 0.5) * motion * Math.max(0, cosLook);
      targetPos.set(pos.x - vx * dist + vz * shift,
        ry + this._roadRise(p, -dist * cosLook) + framing.height, pos.z - vz * dist - vx * shift);
      if (orbit > 0.05) {
        // A sideways look orbits the car; keep it on the driver's side of the barriers.
        const path = p.corridor || this.circuit;
        const sm = path.samples[p.sampleIdx];
        const lat = sm ? (targetPos.x - sm.p.x) * sm.n.x + (targetPos.z - sm.p.z) * sm.n.z : 0;
        const over = Math.abs(lat) - (path.wallOffAt?.(lat, p.sampleIdx) ?? path.wallOff) + 0.8;
        if (over > 0) {
          targetPos.x -= sm.n.x * Math.sign(lat) * over;
          targetPos.z -= sm.n.z * Math.sign(lat) * over;
        }
      }
      // Blend the view with the circuit tangent ahead: the camera sees into a
      // hairpin before the chassis finishes rotating. The tangent is
      // interpolated between samples and filtered, so the aim pans instead of
      // stepping from one 2.5 m sample to the next.
      const c = this.circuit;
      const sm = p.corridor ? null : c.samples[p.sampleIdx];
      const at = (p.trackIdx ?? p.sampleIdx) + framing.look / c.ds +
        (sm ? ((p.pos.x - sm.p.x) * sm.t.x + (p.pos.z - sm.p.z) * sm.t.z) / c.ds : 0);
      const i0 = Math.floor(at);
      const t0 = c.samples[((i0 % c.N) + c.N) % c.N].t;
      const t1 = c.samples[(((i0 + 1) % c.N) + c.N) % c.N].t;
      const pan = snap ? 1 : damp(12, dt);
      rig.aimX += (t0.x + (t1.x - t0.x) * (at - i0) - rig.aimX) * pan;
      rig.aimZ += (t0.z + (t1.z - t0.z) * (at - i0) - rig.aimZ) * pan;
      const lead = CAMERA_FRAMING.aheadAimWeight * Math.max(0, cosLook) *
        Math.max(0, rig.aimX * vx + rig.aimZ * vz);
      targetLook.set(pos.x + (vx * (1 - lead) + rig.aimX * lead) * framing.look + vz * shift,
        ry + this._roadRise(p, framing.look * cosLook) + CAMERA_FRAMING.lookHeightM,
        pos.z + (vz * (1 - lead) + rig.aimZ * lead) * framing.look - vx * shift);
      roll = clamp(rig.gLat * CAMERA_FEEL.rollRad, -CAMERA_FEEL.maxRollRad, CAMERA_FEEL.maxRollRad) *
        motion * Math.max(0, cosLook);
      fov = framing.fov;
    } else {
      // Onboard cameras are bolted to the car: the chassis must never swim
      // against its own camera, so nothing here is smoothed in world space.
      // The driver's eye gets centimetres of filtered load and a glance toward
      // the apex, never a swinging horizon; broadcast mounts pitch and bank.
      const mount = ONBOARD_MOUNTS[mode];
      const cockpit = mode === 1;
      const head = cockpit && settings.headMotion !== false ? motion : 0;
      rig.head += (clamp(finiteCameraValue(p.yawRate) * 0.07 + finiteCameraValue(p.steer) * 0.03, -0.06, 0.06) *
        head - rig.head) * damp(5, dt);
      const view = heading + (back ? Math.PI : rig.look + rig.head);
      const vx = Math.sin(view), vz = Math.cos(view);
      if (back) {
        // Rear-facing camera on the crash structure, clear of the rear wing.
        targetPos.set(pos.x - fx * 2.95, ry + 0.72, pos.z - fz * 2.95);
        targetLook.set(targetPos.x + vx * 30, ry + this._roadRise(p, -33) + 0.5, targetPos.z + vz * 30);
      } else {
        const surge = mount.ahead + clamp(-rig.gLong * 0.0008, -0.02, 0.045) * head;
        const sway = clamp(-rig.gLat * 0.0007, -0.03, 0.03) * head;
        const reach = mount.look - mount.ahead;
        targetPos.set(pos.x + fx * surge + fz * sway,
          ry + (cockpit ? cockpitSeat(settings.cockpitSeat)
            : mount.height + finiteCameraValue(pose?.rideBump) * rig.shakeGain),
          pos.z + fz * surge - fx * sway);
        targetLook.set(targetPos.x + vx * reach,
          ry + this._roadRise(p, mount.look * cosLook) + mount.lookHeight +
            (cockpit ? 0 : clamp(rig.gLong * 0.011, -0.5, 0.25) * motion),
          targetPos.z + vz * reach);
        roll = cockpit ? 0 : clamp(rig.gLat * 0.0011, -0.035, 0.035) * motion;
      }
      fov = (cockpit ? cockpitFov(settings.cockpitFov) : mount.fov + speed * mount.fovSpeed) +
        (p.boosting ? mount.boostFov : 0);
      shakeScale = cockpit ? (settings.headMotion === false ? 0 : 0.2) : 1;
    }
    this.hud.setLook(mode === 1 ? rig.look + rig.head : 0, mode === 1 && back);

    // Driven stops keep the car live from arming through exit. Only freeze the
    // camera while the car is actually stopped for service — not for the whole
    // armed in-lap / corridor drive.
    if (snap || e.pitState?.phase !== 'stopped') {
      this._camPos.copy(targetPos);
      this._camLook.copy(targetLook);
    }
    const camera = this.camera;
    camera.position.copy(this._camPos);

    // Shake: smooth noise on the camera's own clock, driven by speed, kerbs,
    // off-track surfaces and the decaying impact envelope.
    const pace = Math.abs(speed);
    const kerb = p.onKerb && pace > 6 ? (0.4 + 0.6 * finiteCameraValue(p.kerbScrub)) * Math.min(1, pace / 45) : 0;
    const off = p.offTrack ? Math.min(1, pace / 35) : 0;
    const want = shakeAmplitude(rig.speed, kerb, off, rig.impact) * rig.shakeGain * shakeScale;
    rig.shake = snap ? 0 : rig.shake + (want - rig.shake) * damp(want > rig.shake ? 20 : 7, dt);
    rig.clock += dt * (10 + 14 * rig.speed + 9 * kerb + 5 * off + 16 * rig.impact);
    if (rig.shake > 4e-4) {
      const dx = this._camLook.x - this._camPos.x, dz = this._camLook.z - this._camPos.z;
      const sideways = shakeNoise(rig.clock, 0) * rig.shake / (Math.hypot(dx, dz) || 1);
      camera.position.x += dz * sideways;
      camera.position.z -= dx * sideways;
      camera.position.y += shakeNoise(rig.clock, 1) * rig.shake * 0.6;
      roll += shakeNoise(rig.clock, 2) * rig.shake * 0.12;
    }
    camera.lookAt(this._camLook);
    if (roll) camera.rotateZ(roll);

    // Speed and boost widen the lens; a snap lands on the target immediately.
    fov += CAMERA_FEEL.speedFovDegrees[mode] * rig.speed * motion;
    this._cameraFovTarget = fov;
    camera.fov = snap ? fov : camera.fov + (fov - camera.fov) * damp(4, dt);
    camera.updateProjectionMatrix();
    // sun shadow follows player (elevation-aware, or the frustum drifts off on climbs)
    if (this.sun) {
      this.sun.position.set(pos.x + 260, ry + 380, pos.z + 160);
      this.sun.target.position.set(pos.x, ry, pos.z);
    }
  }

  // Rumble for ordinary gamepads, the HUD contact flash, and the spotter and
  // warning cues. All of it reads car state; none of it writes any back.
  _driveFeedback(p, dt) {
    // A network race keeps simulating in a hidden tab; nobody is there to feel it.
    if (document.hidden) return;
    const fb = this._feedback || (this._feedback = {
      kick: 0, spot: 0, spotAge: 0, spotWait: 0, out: false, outWait: 0, low: false,
    });
    const rumble = this.padRumble || (this.padRumble = new GamepadRumble());
    const audio = this.audio;
    // Physics raises impactKick on every wall strike and car-to-car impulse.
    const kick = p.impactKick || 0;
    if (kick > fb.kick + 0.05) {
      if (this._pad) rumble.pulseContact(kick);
      // -1 flashes the left edge, +1 the right. A car within reach names the
      // side; otherwise the barrier does (positive lat is left of centre, and
      // the rebound has already carried the car a little way off the wall).
      const near = this._audioOpponentCues[0];
      this.hud.impact(kick, !p.wallContact && near && near.distance < 5.5 ? near.side
        : Math.abs(p.lat) > p.wallLimit - 2.4 ? (p.lat > 0 ? -1 : 1) : 0);
    }
    fb.kick = kick;
    const pace = Math.abs(p.v);
    if (this._pad) {
      const signal = tyreLimitState(p.wheels, p.brake, p.throttle, fb.signal || (fb.signal = {}));
      // Grass and gravel shake the chassis the way a kerb does.
      signal.kerb = Math.max(p.onKerb ? Math.max(0.2, p.kerbScrub || 0) : 0,
        p.offTrack ? 0.5 * Math.min(1, pace / 30) : 0);
      signal.lockup = signal.lock;
      // Sustained wheelspin eases off with speed, so it never becomes a drone.
      signal.wheelspin = signal.spin * (0.35 + 0.65 * Math.max(0, 1 - pace / 60));
      rumble.update(this._pad, signal, this.ui.settings.padRumble ?? 0.65);
    }

    // Spotter: the HUD reuses the cockpit radar. Bit 0 is a car on the left,
    // bit 1 a car on the right; the call is panned to the side it names.
    const spot = this.hud.spot;
    fb.spotAge += dt;
    fb.spotWait -= dt;
    if (spot !== fb.spot) {
      const gained = spot & ~fb.spot;
      if (gained && fb.spotWait <= 0) {
        audio.spotter?.(gained === 3 ? 0 : gained === 1 ? -1 : 1);
        fb.spotWait = 1;
      } else if (!spot && fb.spotAge > 0.7) audio.spotter?.(0, true);
      fb.spot = spot;
      fb.spotAge = 0;
    }
    // Track limits: the moment the car leaves the road at racing speed.
    const out = p.offTrack && pace > 30 && !p.corridor && !p.wallContact;
    fb.outWait -= dt;
    if (out && !fb.out && fb.outWait <= 0) {
      audio.warn?.('limits');
      fb.outWait = 2.5;
    }
    fb.out = out;
    // Battery: one call as the store runs low, re-armed once it has recovered.
    if (p.battery < 0.12 && !fb.low) {
      fb.low = true;
      audio.warn?.('battery');
    } else if (p.battery > 0.3) fb.low = false;
  }

  // ---------- main loop ----------
  loop() {
    requestAnimationFrame(() => this.loop());
    // ?simOnly=1 runs the whole game without ever touching the GPU — the test
    // hook for environments where software rendering is so slow that painting
    // starves the simulation itself (a CI runner's llvmpipe frame costs ~4s
    // and two pages share two cores). Everything else — physics, netcode,
    // HUD, menus — behaves identically.
    this._tick(!this._simOnly);
  }

  /**
   * Keep a network race simulating when the page stops getting frames.
   *
   * The loop is rAF-driven, and a browser gives no frames to a hidden or
   * occluded page — so a player who minimised mid-race would park on the
   * racing line while every other machine's world kept moving, exactly the
   * outcome the auto-pause exemption exists to prevent. A quarter-second
   * timer steps the same tick whenever frames have stalled and a network
   * session is live. Engine audio exempts the page from the browser's
   * intensive timer throttling, and the tick measures real elapsed time, so
   * driving it from two sources never double-steps the simulation.
   */
  startNetHeartbeat() {
    if (this._netHeartbeat) return;
    const beat = () => {
      if (!this.net) return;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      // Simulation only: painting a frame nobody can see cost ~8s under
      // software GL and starved the very simulation this heartbeat exists to
      // keep alive.
      if (now - (this._lastTickAt || 0) > 400) this._tick(false);
    };
    // The drum lives in a Worker because page timers are throttled by
    // visibility no matter which flags ask otherwise — measured at ~3.7s
    // between 250ms beats in an occluded page. Worker timers are exempt: they
    // were never frame-bound to begin with.
    try {
      const src = 'setInterval(() => postMessage(0), 250);';
      const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = beat;
      this._netHeartbeat = worker;
    } catch {
      // No Worker or no blob: URLs (an exotic embedder): the page timer still
      // beats, just subject to that embedder's throttling.
      this._netHeartbeat = setInterval(beat, 250);
    }
  }

  _tick(paint = true) {
    this._lastTickAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this._tickCount = (this._tickCount || 0) + 1;
    const rawDt = this.clock.getDelta();
    const renderDt = Math.min(rawDt, 0.05);
    this.pollWheelControls();
    // The network timeline runs on the wall clock in every game state, so
    // packets that arrive in a menu or while paused are stamped correctly.
    const netNow = this.net ? this.netNow() : 0;
    if (this.net) this.net.tick(netNow);
    if (!this.session || !this.scene) return;
    // Renderless ticks must not feed the adaptive quality: their frame times
    // measure the heartbeat cadence, not the GPU.
    if (paint && !this.paused) this.quality.update(rawDt);
    const s = this.session;

    if (!this.paused && !this.awaitingStart && (this.state === 'race' || this.state === 'quali')) {
      this.pacing = this.fixedStep.advance(rawDt, (dt) => {
        const weather = this.circuit?.advanceEnvironment?.(dt, s.entries);
        const trackState = this.circuit?.trackState;
        const visual = trackState?.visualState;
        const conditionsChanged = trackState &&
          (trackState !== this._trackConditionsSource || trackState.time !== this._trackConditionsTime);
        if (s.setTrackConditions && visual && conditionsChanged) {
          const player = s.player?.phys;
          // This value goes to EVERY AI car as the track's grip, so it is read on
          // the racing line at the player's place on the lap. It used to be read
          // under the player's own wheels: one excursion onto the grass or the
          // marbles slowed the whole field.
          const gripIdx = player ? (player.trackIdx ?? player.sampleIdx) : 0;
          const lineLat = trackState.lineOffset?.[Math.floor(gripIdx) % (trackState.lineOffset.length || 1)] ?? 0;
          const grip = player && this.circuit.gripAt
            ? this.circuit.gripAt(
              gripIdx,
              lineLat,
              this._trackGripOptions,
              this._trackGripResult,
            ).multiplier : 1;
          s.setTrackConditions({
            wetness: visual.wetness,
            trackGrip: grip,
            rainfall: weather?.rainfall || 0,
          });
          this._trackConditionsSource = trackState;
          this._trackConditionsTime = trackState.time;
        }
        // Poses land before the step so the session's previous/current render
        // snapshots bracket the new one and interpolation stays smooth.
        if (this.net) this._netPumps.applyRemotePoses(this.net, s, netNow);
        s.update(dt, this.playerInput(dt));
        if (this.effects) this.effects.update(dt, s.entries, this.circuit?.trackState);
        if (this.timeTrial) this._timeTrialStatus = this.timeTrial.update(dt);
      });
      s.render?.(this.pacing.alpha);
      if (this.net) this._netPumps.publishRaceState(this.net, s, netNow);

      // start lights choreography
      if (s.phase === 'lights' && s.lightsOn !== this._lightsShown) {
        if (this._lightsShown === 0 && this.audio.startCrescendo) this.audio.startCrescendo();
        this._lightsShown = s.lightsOn;
        this.hud.setLights(s.lightsOn);
        if (this.circuit.setStartLights) this.circuit.setStartLights(s.lightsOn);
        this.audio.countdownBeep(false);
      }
      if (s.lightsOut) {
        s.lightsOut = false;
        this.hud.lightsOutFlash();
        if (this.circuit.setStartLights) this.circuit.setStartLights(6);
        this.audio.countdownBeep(true);
        if (this.audio.crowdAmbience) this.audio.crowdAmbience(0.45);
      }
      // race-direction audio hooks (fields appear as feature agents land)
      if (s.vsc) {
        if (s.vsc.active && !this._vscAudio) { this._vscAudio = true; this.audio.vscBeep && this.audio.vscBeep(); }
        if (!s.vsc.active && this._vscAudio) { this._vscAudio = false; this.audio.vscBeep && this.audio.vscBeep(); }
      }
      if (s.radioQueue) {
        const n = s.radioQueue.length;
        if (n > (this._radioLen || 0) && this.audio.radioTone) this.audio.radioTone();
        this._radioLen = n;
      }
      const pps = s.player && s.player.pitState;
      if (s._pitStopEvent) {
        s._pitStopEvent = false;
        this._pitAudio = true;
        this.audio.pitStop && this.audio.pitStop();
      } else if (pps && !pps.driven && !this._pitAudio && pps.timer < 2.3) {
        this._pitAudio = true;
        this.audio.pitStop && this.audio.pitStop();
      }
      if (!pps) this._pitAudio = false;
      // audio events
      if (s._wallEvent) {
        this.wheelInput.pulseContact(s._wallEvent.intensity ?? s._wallEvent);
        this.audio.wallImpact(s._wallEvent); s._wallEvent = 0;
      }
      if (s._touchEvent) {
        this.wheelInput.pulseContact(s._touchEvent.intensity ?? s._touchEvent);
        this.audio.carImpact(s._touchEvent); s._touchEvent = 0;
      }
      if (s._shiftEvent) { this.audio.shift(s._shiftEvent > 0 ? 1 : -1); s._shiftEvent = false; }

      const p = s.player?.phys;
      if (p) {
        if (!this.paused) {
          this.wheelInput.updateRumble({
            kerb: p.onKerb ? Math.max(0.2, p.kerbScrub || 0) : 0,
            // An unbraked front wheel keeps a stale slip ratio, which would
            // otherwise read as a permanent lock-up under power.
            lockup: p.brake > 0.05 ? this._wheelLockup(p) : 0,
            wheelspin: this._wheelspin(p),
          });
          this._driveFeedback(p, renderDt);
        }
        // Only service freezes the driven car. Entry and exit retain live engine,
        // throttle and wheel speed because physics never leaves the player.
        this.audio.update(renderDt, pps?.phase === 'stopped' ? PIT_IDLE_AUDIO : {
          rpmFrac: Math.max(0, Math.min(1, (p.rpmFrac - 0.18) / 0.86)),
          throttle: p.throttle,
          brake: p.brake,
          speed: p.v,
          gear: p.gear,
          slip: p.slip,
          kerb: p.onKerb && p.v > 8,
          boost: p.boosting,
          offtrack: p.offTrack,
          wallScrape: p.wallScrape,
          carScrape: p.carScrape,
          contactSide: p.wallScrape >= p.carScrape
            // positive lat is LEFT of centre (n = up x tangent), and the audio pans
            // -1 left / +1 right: the wall being scraped is on the car's own side
            ? (p.lat > 0 ? -1 : 1)
            : p.carScrapeSide,
          // an unbraked front wheel keeps a stale negative slip ratio, which read
          // as a lock-up squeal under full throttle; only a braked wheel can lock
          lockup: p.brake > 0.05 ? this._wheelLockup(p) : 0,
          surface: p.surface?.material,
          surfaceRoughness: Math.min(1, Math.abs(p.surface?.bump || 0) / 0.02),
          bottoming: Math.min(1, Math.abs(p.surface?.bump || 0) / 0.025 + (p.onKerb ? p.kerbScrub * 0.3 : 0)),
          damage: s.player?.damage ? Math.max(0, 1 - (s.player.damage.frontWing ?? 1)) : (s.player?.wingDamage || 0),
          wetness: p.surface?.wetness || this.circuit?.trackState?.visualState?.wetness || 0,
          rain: this.circuit?.weather?.current?.intensity || 0,
          spray: Math.min(1, (p.surface?.wetness || 0) * Math.max(0, p.v) / 55),
          cockpit: this.camMode === 1,
          // listener preset (chase / cockpit / on-car) and the pit limiter's
          // ignition cut, which only bites within 1.5 m/s of the 80 km/h cap
          cameraMode: ['chase', 'cockpit', 't-cam', 'nose'][this.camMode],
          pitLimiter: p.pitLimiter ? Math.min(1, Math.max(0, 1 - (80 / 3.6 - p.v) / 1.5)) * p.throttle : 0,
          load: Math.min(1, Math.hypot(p.longitudinalAcceleration || 0, p.lateralAcceleration || 0) / 35),
          ersDeploy: p.boosting || p.ersMode === 2,
          regen: p.ersMode === 0,
          opponents: this._nearbyOpponentAudio(s, p),
        });
        // close high-speed passes: panned doppler whoosh (audio has its own cooldown)
        if (this.audio.passBy && s.entries) {
          for (const e2 of s.entries) {
            if (e2.isPlayer || e2.dnf || e2.phys.disabled) continue;
            const dx = e2.phys.pos.x - p.pos.x, dz = e2.phys.pos.z - p.pos.z;
            const d2 = dx * dx + dz * dz;
            if (d2 > 13 * 13) continue;
            const rel = Math.abs(e2.phys.v - p.v);
            if (rel < 12) continue;
            const side = -Math.sign(driverLateral(dx, dz, p.heading)) || 1;
            this.audio.passBy(side, Math.min(1, rel / 40));
            break;
          }
        }
      }
      this.hud.update(renderDt);
      this._simStatusTimer -= renderDt;
      if (this._simStatusTimer <= 0) {
        this._simStatusTimer = 0.25;
        this.hud.updateSimulationState?.(this.snapshot());
      }
      if (this._timeTrialStatus) {
        this.hud.updateTimeTrial(this._timeTrialStatus.personalBest, this._timeTrialStatus.delta);
      }

      // quali flow (timer guarded against session swaps / pause-quit races)
      if (this.state === 'quali' && !this.raceConfig.trial && s.qualiState === 'done' && !this._qualiDoneShown) {
        this._qualiDoneShown = true;
        this._qualiTimer = setTimeout(() => {
          this._qualiTimer = null;
          if (this.session !== s || this.state !== 'quali') return;
          this.audio.finishFanfare();
          this.hud.hide();
          this.audio.stopEngine();
          this.state = 'qualiResults';
          if (this.raceConfig.fullWeekend) {
            const practice = s.mode === 'practice';
            const stage = practice ? 'FP1' : (s.qualifying?.stage || 'Q1');
            const rows = practice
              ? s.practiceClassification()
              : s.currentQualifyingClassification();
            const nextLabel = practice ? 'START Q1 →'
              : stage === 'Q1' ? 'START Q2 →'
                : stage === 'Q2' ? 'START Q3 →' : 'START FORMATION LAP →';
            this.ui.showQualiResults(rows, this.raceConfig.driverId, this.raceConfig.race, {
              title: practice
                ? 'PRACTICE <small>FP1 CLASSIFICATION</small>'
                : `QUALIFYING <small>${stage} CLASSIFICATION</small>`,
              leaderLabel: practice ? 'P1' : 'POLE',
              primaryLabel: nextLabel,
              primaryAction: practice ? 'startPilotQualifying' : 'advancePilotQualifying',
              allowRestart: false,
              footer: `${this.raceConfig.race.gp} · ${stage} · every time earned on track`,
            });
          } else {
            this.ui.showQualiResults(s.qualiClassification(), this.raceConfig.driverId, this.raceConfig.race);
          }
        }, 1400);
      }
      // race results — the host's sheet is the one every player sees
      if (s.results && this.net?.isHost && !this._netResultsPublished) {
        this._netResultsPublished = true;
        this.net.publishResults(s.results, s.fastestLap?.driverId || null);
      }
      if (s.results && !this._resultsShown) {
        this._resultsShown = true;
        this.audio.finishFanfare();
        const results = s.results;
        // idempotent per attempt: the same config object survives restarts,
        // so a championship round can only ever be banked once
        if (this.raceConfig.champRound && !this.raceConfig._champRecorded) {
          this.raceConfig._champRecorded = true;
          this.champ.recordResult(
            results.map(r => ({ id: r.driver.id, dnf: !!r.dnf })),
            s.fastestLap?.driverId || null
          );
        }
        this._resultsTimer = setTimeout(() => {
          this._resultsTimer = null;
          if (this.session !== s || this.state !== 'race') return;
          this.hud.hide();
          this.audio.stopEngine();
          this.state = 'results';
          this.ui.showResults(results, s.fastestLap, this.raceConfig.race, 'race', !!this.raceConfig.champRound);
        }, 900);
      }
      this.updateCamera(renderDt);
      if (paint) this.racingLine?.update(s, this.ui.settings.racingLine, renderDt);
      // AI detail selection uses the final smoothed/shaken camera for every
      // camera mode. RaceSession internally limits this presentation-only pass
      // to 10 Hz; callers that never invoke it retain full-fidelity cars.
      if (s.updateCarLod) s.updateCarLod(this.camera);
      // nametags are laid out in screen space (cap/clamp/overlap), which
      // needs this frame's final camera — so this runs after updateCamera
      if (s.updateNametags) s.updateNametags(this.camera, innerWidth, innerHeight);
    }
    if (!paint) return;
    this.replay?.frame(renderDt);
    const rendererInfo = this.renderer.info;
    rendererInfo.reset();
    this._lookUpdate(renderDt);
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    const frameMs = rawDt * 1000;
    const telemetry = this._frameTelemetry;
    telemetry.count++;
    telemetry.lastMs = frameMs;
    telemetry.smoothedMs += (frameMs - telemetry.smoothedMs) * (telemetry.count === 1 ? 1 : 0.05);
    telemetry.maxMs = Math.max(telemetry.maxMs, frameMs);
    const render = rendererInfo.render;
    const renderTelemetry = this._renderTelemetry;
    renderTelemetry.calls = render.calls;
    renderTelemetry.triangles = render.triangles;
    renderTelemetry.points = render.points;
    renderTelemetry.lines = render.lines;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// idle-in-the-box audio snapshot (allocation-free: one shared object)
const PIT_IDLE_AUDIO = {
  rpmFrac: 0.06, throttle: 0.04, brake: 0, speed: 0, gear: 1,
  slip: false, kerb: false, boost: false, offtrack: false,
};

const game = new Game();
window.__game = game; // dev/test hook
