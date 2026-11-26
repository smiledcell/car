// audio.js — Synthesized WebAudio broadcast package for the F1 2026 simulator.
// No samples, no external deps: wavetable oscillators, shaped noise, filters,
// waveshapers and one generated impulse response.
// The AudioContext is created lazily in init() (browser autoplay policy:
// must be called from a user gesture).
//
// Signal flow
//   V6 wavetables ─► drive ─► clipper ─► pipe formants ─► engineLP ─► engineGain ─┐
//   intake roar + exhaust rasp (noise gated by the firing pulse) ────────────────┼─► engCut ─► engLim ─┐
//   turbo / MGU-K / override / gear whine / wind / tyres / kerb / weather / contact ─────────────────┤
//   pooled opponent voices (wavetable ─► distance lowpass ─► pan) ───────────────────────────────────┼─► engineOut
//   engineOut ─► perspectiveLP ─► perspectiveBody ─┬──────────────► viewTrim ─► engineDuck ─┐
//                                                  └─ cockpit taps / space ─┘               │
//   one-shots (impacts, pit gun, radio, ui, crowd, crescendo) ──────────────────────────────┼─► master
//   master ─► 22 Hz highpass ─► limiter ─► clip ─► outGain ─► out
//
// engCut = shift ignition cut, engLim = rev-limiter stutter, engineOut = start/stop
// fade, engineDuck = one-shot ducking (-2 dB), outGain = volume / mute.
//
// Real-time contract: update() touches only pre-built nodes and never allocates.
// Every audible parameter move goes through setTargetAtTime / linearRamp so there
// are no zipper noises or clicks.

import {
  OPPONENT_VOICE_BUDGET,
  createAudioTargets,
  deriveAudioTargets,
  normalizeOpponentCue,
  smoothTelemetry,
} from './audioTelemetry.js';

const EMPTY = {};

// Gear top speeds in m/s — mirrors GEAR_TOP in physics.js. Used only to estimate
// the current gear when the caller does not pass one (keeps this file dep-free).
const GEAR_TOP = [27.5, 37, 46.5, 56, 65.5, 75, 85.5, 96.5];

const DUCK_GAIN = 0.794; // -2 dB

// Engine speed: audio rpm 0..1 spans 3,600..13,000 rpm. The wavetables are one
// full 720° cycle long, so their fundamental is half engine order and every
// partial is a real engine order (partial 6 = the V6 firing frequency).
const cycleHz = (rpm) => 30 + rpm * 78.3;
// Input-shaft tooth count per gear: the selected pair's mesh order.
const MESH = [13, 13, 14, 16, 17, 19, 20, 22, 23];
const KERB_PITCH = 1.25; // metres per painted kerb block (trackBuilder stripeM)

// Listener presets indexed by AudioTargets.view:
// [chase, cockpit, trackside, on-car camera (T-cam / nose)].
const VIEW = {
  lp: [13000, 4200, 6000, 9000], // air/tub lowpass (Hz)
  body: [0, 3.4, -2, 1.5], // low-mid resonance (dB)
  rasp: [1.2, 0.5, 1, 0.8], // exhaust rasp: loudest behind the car
  intake: [0.7, 1.5, 0.35, 1.3], // airbox roar: loudest right beside it
  whine: [0.3, 1, 0.12, 0.55], // structure-borne gear / MGU-K whine
  wind: [0.55, 1, 0, 0.9],
  tyre: [0.8, 1, 0.5, 1.1],
  space: [0.2, 0.04, 0.5, 0.08], // reflection send
  trim: [1, 0.97, 1.05, 0.93], // loudness match
};

// Output ceiling: transparent below 0.66, then a tanh knee that tops out at 0.85
// (-1.4 dBFS, which leaves room for inter-sample peaks).
const softClip = (x) => {
  const a = Math.abs(x);
  return a <= 0.66 ? x : Math.sign(x) * (0.66 + 0.2 * Math.tanh((a - 0.66) / 0.2));
};
// Combustion clip: steep and slightly biased, so the positive pressure pulses
// flatten first and both even and odd orders grow with drive.
const engineClip = (x) => Math.tanh(3.2 * (x + 0.1)) - Math.tanh(0.32);

function clamp01(v) {
  v = +v;
  if (!(v > 0)) return 0; // also maps NaN -> 0
  return v > 1 ? 1 : v;
}

function clampNum(v, lo, hi) {
  v = +v;
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

export class AudioEngine {
  constructor() {
    // Nothing is created here (autoplay policy). init() builds the graph.
    this.ctx = null;
    this._ready = false;
    this._volume = 0.8;
    this._muted = false;

    // live state
    this._rpm = 0;
    this._thr = 0;
    this._speed = 0;
    this._prevSpeed = 0;
    this._accel = 0; // smoothed m/s^2, used to infer shift direction
    this._spool = 0; // turbo spool-up, lags throttle
    this._load = 0;
    this._slip = 0;
    this._lockup = 0;
    this._wetness = 0;
    this._damage = 0;
    this._bottoming = 0;
    this._gear = 1;
    this._gearCand = 1;
    this._gearCandT = 0;

    // frame-decayed envelopes (flywheel snap on shifts, downshift throttle blip)
    this._shiftEnv = 0;
    this._shiftDir = 1;
    this._blipEnv = 0;
    this._lim = 0; // rev-limiter engagement
    this._overT = 0; // seconds on the overrun
    this._popT = 0; // time to the next overrun pop
    this._thrHold = 0; // recent throttle peak (lift detection)
    this._boostT = 0; // override hold time
    this._engOsc = []; // crank-locked oscillators (fallback pitch path)

    // event cooldowns
    this._slipCooldown = 0;
    this._wgCooldown = 0;
    this._wallImpactCooldown = 0;
    this._carImpactCooldown = 0;
    this._bottomCooldown = 0;

    // Reused telemetry/cue records keep the real-time update path allocation-free.
    this._audioTargets = createAudioTargets();
    this._opponentCue = {};
    this._opponentVoices = [];
    this._opponentCooldowns = new Map();

    // beds
    this._crowdLevel = 0;
    this._crowdStarted = false;
    this._cresc = null;
  }

  get ready() {
    return this._ready;
  }

  // Idempotent. Call on first user gesture.
  init() {
    if (this._ready) {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC =
      (typeof window !== 'undefined' &&
        (window.AudioContext || window.webkitAudioContext)) ||
      (typeof AudioContext !== 'undefined' ? AudioContext : null);
    if (!AC) return;

    const ctx = new AC();
    this.ctx = ctx;
    queueMicrotask(() => this._decodePending());

    // ---- output stage: bus -> rumble/DC guard -> glue compressor -> soft-clip
    // ceiling -> volume. Volume sits after the dynamics so the balance is the
    // same at every setting, and the clip curve tops out at -1.4 dBFS, so the
    // output cannot reach full scale whatever is thrown at the bus.
    this.outGain = this._gainNode(this._muted ? 0 : this._volume, ctx.destination);
    this.clip = this._shaper(softClip, 'none', this.outGain);
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -12;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 3;
    this.limiter.attack.value = 0.005;
    this.limiter.release.value = 0.16;
    this.limiter.connect(this._gainNode(0.8, this.clip)); // makeup trim
    this.master = this._gainNode(1, this._filter('highpass', 22, 0.7, this.limiter));

    // Shared looping noise: mono for engine-borne layers and one-shots, a
    // decorrelated stereo bed for air/tyres/weather, and a sparse-grain bed for
    // stones and droplets. Every noise layer taps one of these three sources.
    this._noiseBuffer = this._makeNoiseBuffer(1.7);
    this._crowdBuffer = this._makeCrowdBuffer(3.1);
    this._noiseSrc = this._loop(this._noiseBuffer);
    this._wideSrc = this._loop(this._makeNoiseBuffer(2.3, 2), true);
    this._grainSrc = this._loop(this._makeNoiseBuffer(1.9, 2, 0.004), true);

    // ---- engine bus ----
    this.engineDuck = this._gainNode(1, this.master); // one-shot ducking
    // Listener perspective: cockpit closes the tub/helmet filter and adds a
    // low-mid resonance; exterior views open it back up. Sitting after
    // engineOut, every continuous car/surface layer shares the same viewpoint
    // without touching UI/radio/crowd cues. viewTrim loudness-matches the views.
    this.viewTrim = this._gainNode(1, this.engineDuck);
    this.perspectiveBody = this._filter('peaking', 310, 0.8, this.viewTrim);
    this.perspectiveBody.gain.value = 0;
    this.perspectiveLP = this._filter('lowpass', 12000, 0.65, this.perspectiveBody);
    this.engineOut = this._gainNode(0, this.perspectiveLP); // start/stop fade

    // Space: a generated stereo impulse (ground/barrier reflections into a short
    // diffuse tail, one late slap) opens up the exterior views; two millisecond
    // taps give the cockpit its tub boxiness.
    this.spaceSend = this._gainNode(0, null);
    this.perspectiveBody.connect(this.spaceSend);
    this.erGain = this._gainNode(0, this.viewTrim);
    if (ctx.createConvolver) {
      const space = ctx.createConvolver();
      space.normalize = false; // the impulse is built at its working level
      space.buffer = this._makeSpaceIR();
      space.connect(this.viewTrim);
      this.spaceSend.connect(space);
    }
    if (ctx.createDelay) {
      for (let i = 0; i < 2; i++) {
        const tap = ctx.createDelay(0.05);
        tap.delayTime.value = i ? 0.0074 : 0.0031;
        this.perspectiveBody.connect(tap);
        tap.connect(this._gainNode(i ? -0.5 : 0.8, this.erGain));
      }
    }

    // ---- combustion ----
    // Three phase-locked wavetable oscillators (low-rev growl, high-rev scream,
    // overrun burble with most cylinders cut) share one pitch signal, so
    // crossfading them morphs the waveform instead of chorusing. The mix is
    // driven into an asymmetric clipper — more throttle, harder clip, more upper
    // orders — and then through fixed pipe resonances, so the formants stay put
    // while the engine orders sweep through them.
    this.engLim = this._gainNode(1, this.engineOut); // rev-limiter stutter
    this.engCut = this._gainNode(1, this.engLim); // shift ignition cut / blip
    this.engineGain = this._gainNode(0.03, this.engCut);
    this.engineLP = this._filter('lowpass', 1200, 0.7, this.engineGain);
    this.raspEQ = this._filter('peaking', 2600, 1.2, this.engineLP);
    this.raspEQ.gain.value = 0;
    this.formant = this._filter('peaking', 1000, 1.4, this.raspEQ);
    this.formant.gain.value = 5;
    const body = this._filter('peaking', 340, 1, this.formant);
    body.gain.value = 4;
    this.engDrive = this._gainNode(0.2,
      this._shaper(engineClip, '4x', this._filter('highpass', 45, 0.7, body)));

    // One pitch source feeds every crank-locked oscillator's frequency input,
    // so they cannot drift apart; pitchMod adds combustion scatter and the
    // limiter wobble as a ratio.
    if (ctx.createConstantSource) {
      this.pitch = ctx.createConstantSource();
      this.pitch.offset.value = 32;
      this.pitchMod = this._gainNode(1, null);
      this.pitch.connect(this.pitchMod);
      this.pitch.start();
    }
    this._t0 = ctx.currentTime + 0.06;
    this.gLow = this._gainNode(0, this.engDrive);
    this.gHigh = this._gainNode(0, this.engDrive);
    this.gOver = this._gainNode(1, this.engDrive);
    this._osc(this._engineWave([1, 0.84, 0.96, 0.8, 1.04, 0.87], 3, 10, 93), 32, this.gLow, 1);
    const scream = this._engineWave([1, 0.93, 0.99, 0.9, 1.02, 0.94], 5, 22, 96);
    const firing = this._osc(scream, 32, this.gHigh, 1);
    this._osc(this._engineWave([1, 0.3, 0.8, 0.25, 0.62, 0.4], 4, 14, 90), 32, this.gOver, 1);
    // Cycle-to-cycle scatter: slow noise as FM (it smears the high orders first)
    // and as random level on the overrun voice, so the burble never repeats.
    const pm = this.pitchMod ? this.pitchMod.gain : null;
    this.jitGain = this._gainNode(0.1, pm);
    const scatter = this._filter('lowpass', 50, 0.5, this.jitGain);
    this._noiseSrc.connect(scatter);
    this.burble = this._gainNode(0, this.gOver.gain);
    scatter.connect(this.burble);
    // Combustion grit: noise fed in ahead of the clipper, which lets it through
    // between the pressure peaks — broadband, and in time with the firing.
    this.gritGain = this._gainNode(0, this.engDrive);
    this._noiseSrc.connect(this._filter('lowpass', 3000, 0.5, this.gritGain));
    // Rev limiter: a rounded square LFO gates engLim and rocks the pitch.
    const limLP = this._filter('lowpass', 130, 0.6, null);
    this._osc('square', 21, limLP);
    this.limDepth = this._gainNode(0, this.engLim.gain);
    this.limPitch = this._gainNode(0, pm);
    limLP.connect(this.limDepth);
    limLP.connect(this.limPitch);

    // Induction roar and exhaust rasp: noise bands gated by the firing pulse
    // train, so the air breathes in time with the engine instead of hissing
    // over it. Both sit before the cut/limiter gains.
    this.intakeGain = this._gainNode(0, this.engCut);
    const intakeAM = this._gainNode(0.35, this.intakeGain);
    this.intakeBP = this._filter('bandpass', 500, 0.8, intakeAM);
    this._noiseSrc.connect(this.intakeBP);
    firing.connect(this._gainNode(0.65, intakeAM.gain));
    this.raspGain = this._gainNode(0, this.engCut);
    const raspAM = this._gainNode(0.1, this.raspGain);
    this._noiseSrc.connect(this._filter('bandpass', 3300, 0.55, raspAM));
    firing.connect(this._gainNode(0.9, raspAM.gain));
    // First engine order: felt through the tub more than heard.
    this.subGain = this._gainNode(0, this.engCut);
    this._osc(this._partials(2, 1), 32, this.subGain, 1);

    // Turbo: a narrow noise band that whistles up with the (lagging) spool.
    this.turboNoiseGain = this._gainNode(0, this.engineOut);
    this.turboBP = this._filter('bandpass', 3000, 11, this.turboNoiseGain);
    this._noiseSrc.connect(this.turboBP);

    // Wastegate / blow-off: gated noise band that sweeps down on throttle lift,
    // amplitude-fluttered by a permanent LFO whose depth is gated with it.
    this.wgBP = this._filter('bandpass', 1800, 2.2, null);
    this.wgGain = this._gainNode(0, this.engineOut);
    this._noiseSrc.connect(this.wgBP);
    this.wgBP.connect(this.wgGain);
    this.wgFlutter = this._lfo('sine', 26, 0, this.wgGain.gain);

    // Overrun: a bright spit (crackle) over a resonant pipe thump (pop), both
    // driven by scheduled pulse trains — nothing is allocated per event.
    this.crackleHP = this._filter('highpass', 1700, 0.8, null);
    this.crackleGain = this._gainNode(0, this.engineOut);
    this._noiseSrc.connect(this.crackleHP);
    this.crackleHP.connect(this.crackleGain);
    this.popGain = this._gainNode(0, this.engineOut);
    const popBP = this._filter('bandpass', 430, 2.2, this.popGain);
    this._noiseSrc.connect(popBP);
    // On the limiter the same thump fires in each cut: gain = depth * (1 - LFO).
    this.limPop = this._gainNode(0, this.engineOut);
    popBP.connect(this.limPop);
    this.limPopDepth = this._gainNode(0, this.limPop.gain);
    limLP.connect(this.limPopDepth);

    // MGU-K: the 2026 signature. Geared to the crank (17th + 34th order — between
    // the firing-grid lines, so it reads as its own voice), the whine sweeps
    // with the revs and steps on every shift; a tremolo marks harvesting.
    // Manual Override stacks a brighter voice a fifth above.
    this.mgukBP = this._filter('bandpass', 2600, 2.4, this.engineOut);
    this.mgukGain = this._gainNode(0, this.mgukBP);
    this._osc(this._partials(34, 1, 68, 0.4), 32, this.mgukGain, 1);
    this.mgukTrem = this._lfo('sine', 34, 0, this.mgukGain.gain);
    this.ovrGain = this._gainNode(0, this.engineOut);
    this.ovrOsc = this._osc(this._partials(50, 1, 100, 0.5, 150, 0.25), 32,
      this._filter('highpass', 2200, 0.7, this.ovrGain), 1);
    this.boostBP = this._filter('bandpass', 4200, 9, null);
    this.boostGain = this._gainNode(0, this.engineOut);
    this._noiseSrc.connect(this.boostBP);
    this.boostBP.connect(this.boostGain);

    // Transmission: final-drive whine tracks road speed straight through the
    // shifts; the selected gear pair adds its own mesh order on top.
    this.transGain = this._gainNode(0, this.engineOut);
    this.transBP = this._filter('bandpass', 1600, 5, this.transGain);
    this.transOsc = this._osc('sawtooth', 600, this.transBP);
    this.meshGain = this._gainNode(0, this.engineOut);
    this.meshBP = this._filter('bandpass', 3000, 6, this.meshGain);
    this.meshOsc = this._osc('triangle', 3000, this.meshBP);

    // Wind: a low roar plus a higher hiss band, stereo-decorrelated and gusted
    // by two slow LFOs so the airflow buffets instead of droning.
    this.windGain = this._gainNode(0, this.engineOut);
    this.windLP = this._filter('lowpass', 300, 0.5, this.windGain);
    this._wideSrc.connect(this.windLP);
    this.windHiGain = this._gainNode(0, this.engineOut);
    this.windBP = this._filter('bandpass', 1500, 0.7, this.windHiGain);
    this._wideSrc.connect(this.windBP);
    this.windGust = this._gainNode(0, this.windGain.gain);
    this._osc('sine', 0.83, this.windGust);
    this._osc('triangle', 2.9, this.windGust);

    // Off-track beds: a dark wash for grass, opened up for gravel, plus a
    // granular stones-on-the-floor layer whose density follows road speed.
    this.gravelLP = this._filter('lowpass', 550, 0.9, null);
    this.gravelGain = this._gainNode(0, this.engineOut);
    this._wideSrc.connect(this.gravelLP);
    this.gravelLP.connect(this.gravelGain);
    this.grainGain = this._gainNode(0, this.engineOut);
    this._grainSrc.connect(this._filter('bandpass', 1900, 0.6, this.grainGain));
    // The same grains, high-passed, are raindrops on the visor and bodywork.
    this.dropGain = this._gainNode(0, this.engineOut);
    this._grainSrc.connect(this._filter('highpass', 4500, 0.7, this.dropGain));

    // Persistent bodywork/barrier scrape bed. The graph is built once; live
    // contact only moves AudioParams, so sustained rubbing allocates no nodes.
    this.contactScrapeBP = this._filter('bandpass', 920, 0.85, null);
    this.contactScrapePan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (this.contactScrapePan) this.contactScrapePan.connect(this.engineOut);
    this.contactScrapeGain = this._gainNode(0, this.contactScrapePan || this.engineOut);
    this._noiseSrc.connect(this.contactScrapeBP);
    this.contactScrapeBP.connect(this.contactScrapeGain);

    // Tyre scrub: pooled burst chain (no allocation from update()).
    this.scrubBP = this._filter('bandpass', 900, 1.6, null);
    this.scrubGain = this._gainNode(0, this.engineOut);
    this._wideSrc.connect(this.scrubBP);
    this.scrubBP.connect(this.scrubGain);

    // Lockup uses its own tonal/noise pair so braking stays distinct from
    // lateral scrub. Both are permanent, gain-gated voices.
    this.lockBP = this._filter('bandpass', 1380, 7.5, this.engineOut);
    this.lockGain = this._gainNode(0, this.lockBP);
    this.lockOsc = this._osc('triangle', 1260, this.lockGain);
    this.lockNoiseBP = this._filter('bandpass', 1750, 2.2, null);
    this.lockNoiseGain = this._gainNode(0, this.engineOut);
    this._noiseSrc.connect(this.lockNoiseBP);
    this.lockNoiseBP.connect(this.lockNoiseGain);

    // Tyre roar, rain/spray and damaged bodywork are continuous beds. The
    // weather/damage hooks are optional; dry undamaged callers keep them silent.
    this.roadBP = this._filter('bandpass', 420, 0.75, null);
    this.roadGain = this._gainNode(0, this.engineOut);
    this._wideSrc.connect(this.roadBP);
    this.roadBP.connect(this.roadGain);

    this.rainHP = this._filter('highpass', 3100, 0.55, null);
    this.rainGain = this._gainNode(0, this.engineOut);
    this._wideSrc.connect(this.rainHP);
    this.rainHP.connect(this.rainGain);
    this.sprayBP = this._filter('bandpass', 1450, 0.7, null);
    this.sprayGain = this._gainNode(0, this.engineOut);
    this._wideSrc.connect(this.sprayBP);
    this.sprayBP.connect(this.sprayGain);

    this.damageBP = this._filter('bandpass', 760, 3.5, null);
    this.damageGain = this._gainNode(0, this.engineOut);
    this._noiseSrc.connect(this.damageBP);
    this.damageBP.connect(this.damageGain);
    this.damageFlutter = this._lfo('square', 23, 0, this.damageGain.gain);

    // Floor strikes are pooled: update() triggers these prebuilt nodes on the
    // rising edge instead of allocating a one-shot under heavy kerb load.
    this.bottomGain = this._gainNode(0, this.engineOut);
    this.bottomOsc = this._osc('square', 68, this.bottomGain);
    this.bottomBP = this._filter('bandpass', 510, 1.1, null);
    this.bottomNoiseGain = this._gainNode(0, this.engineOut);
    this._noiseSrc.connect(this.bottomBP);
    this.bottomBP.connect(this.bottomNoiseGain);

    // Kerb: one strike per painted block (rate = speed / block length) thumping
    // through the floor, with chassis rattle gated by the same pulse.
    this.kerbGain = this._gainNode(0, this.engineOut);
    this.kerbOsc = this._osc(this._partials(1, 1, 2, 0.7, 3, 0.4, 4, 0.8, 8, 0.3), 28,
      this._filter('lowpass', 320, 0.7, this.kerbGain));
    this.kerbNoiseGain = this._gainNode(0, this.engineOut);
    const kerbAM = this._gainNode(0.3, this.kerbNoiseGain);
    this.kerbBP = this._filter('bandpass', 240, 1.2, kerbAM);
    this._noiseSrc.connect(this.kerbBP);
    this.kerbOsc.connect(this._gainNode(0.7, kerbAM.gain));

    // Pit wheel-gun: pooled metallic band driven by scheduled rattle trains.
    this.gunBP = this._filter('bandpass', 1600, 3.2, null);
    this.gunGain = this._gainNode(0, this.master);
    this._noiseSrc.connect(this.gunBP);
    this.gunBP.connect(this.gunGain);

    // Four preallocated opponent voices is enough to communicate the cars that
    // matter around the player while placing a hard ceiling on WebAudio load.
    // Each is the same V6 wavetable behind a distance lowpass, plus wake air.
    // They join the car bus, so they share the listener's perspective and
    // space and fall silent with stopEngine().
    for (let i = 0; i < OPPONENT_VOICE_BUDGET; i++) {
      const out = this._gainNode(1, this.engineOut);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) pan.connect(out);
      const dest = pan || out;
      const airBP = this._filter('bandpass', 1800, 0.78, null);
      const airGain = this._gainNode(0, dest);
      this._noiseSrc.connect(airBP);
      airBP.connect(airGain);
      const engineGain = this._gainNode(0, dest);
      const engineLP = this._filter('lowpass', 2400, 0.9, engineGain);
      const engine = this._osc(scream, 60, engineLP);
      this._opponentVoices.push({
        id: null, activeUntil: 0, out, pan, airBP, airGain,
        engine, engineLP, engineGain, dist: 0, seen: 0, vr: 0,
      });
    }

    this._noiseSrc.start();

    // Race-engineer radio bus: band-limited comms EQ for radioTone().
    this.radioLP = this._filter('lowpass', 2700, 0.8, this.master);
    this.radioHP = this._filter('highpass', 520, 0.9, this.radioLP);

    // ---- crowd bed (source started lazily on first crowdAmbience call) ----
    this.crowdSrc = ctx.createBufferSource();
    this.crowdSrc.buffer = this._crowdBuffer;
    this.crowdSrc.loop = true;
    this.crowdPan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (this.crowdPan) this.crowdPan.connect(this.master);
    this.crowdGain = this._gainNode(0, this.crowdPan || this.master);
    this.crowdLP = this._filter('lowpass', 950, 0.7, this.crowdGain);
    this.crowdHP = this._filter('highpass', 170, 0.7, this.crowdLP);
    this.crowdSrc.connect(this.crowdHP);
    // Two incommensurate slow LFOs sum into the bed gain = non-periodic cheering
    // swells with zero timers and zero allocation.
    this.crowdSwell = this._lfo('sine', 0.091, 0, this.crowdGain.gain);
    this.crowdSwell2 = this._lfo('triangle', 0.037, 0, this.crowdGain.gain);
    if (this.crowdPan) this._lfo('sine', 0.053, 0.45, this.crowdPan.pan);

    this._ready = true;
  }

  setVolume(v) {
    this._volume = clamp01(v);
    if (!this.ready) return;
    if (!this._muted) {
      this.outGain.gain.setTargetAtTime(this._volume, this.ctx.currentTime, 0.03);
    }
  }

  setMuted(m) {
    this._muted = !!m;
    if (!this.ready) return;
    const target = this._muted ? 0 : this._volume;
    this.outGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
  }

  // Per-frame update. s = { rpmFrac, throttle, speed, slip, kerb, boost, offtrack }
  // Optional extra: s.gear (1..8) for exact per-gear timbre; estimated if absent.
  // Allocates nothing.
  update(dt, s) {
    // ---- sampled engine crossfade ----
    if (this._eng && s) {
      const rpm = Math.max(0, Math.min(1, s.rpmFrac || 0));
      const thr = Math.max(0, Math.min(1, s.throttle || 0));
      const t0 = this.ctx.currentTime;
      const moving = (s.speed || 0) > 4;
      const coast = thr < 0.12 && moving;
      // equal-power band weights
      for (const l of this._eng.layers) {
        const x = Math.max(0, 1 - Math.abs(rpm - l.center) / l.width);
        const w = Math.sin(x * Math.PI / 2);
        const drive = 0.32 + 0.68 * thr;
        const gain = (coast ? 0.25 : 1) * w * drive * 0.5;
        l.g.gain.setTargetAtTime(gain, t0, 0.045);
        // pitch-track: each layer bends toward the live rpm around its center
        const rate = Math.max(0.62, Math.min(1.6, 0.92 + (rpm - l.center) * 0.75));
        l.src.playbackRate.setTargetAtTime(rate, t0, 0.05);
      }
      if (this._eng.overrun) {
        const og = coast && rpm > 0.25 ? 0.4 * Math.min(1, rpm * 1.4) : 0;
        this._eng.overrun.g.gain.setTargetAtTime(og, t0, 0.06);
        this._eng.overrun.src.playbackRate.setTargetAtTime(0.9 + rpm * 0.3, t0, 0.08);
      }
    }
    // ---- sample-pack surface layers (gain-gated loops; synth continues under) ----
    if (this._samples) {
      const t0 = this.ctx.currentTime;
      const kg = this._sampleLoop('kerb-rumble');
      if (kg) kg.gain.setTargetAtTime(s && s.kerb ? 0.32 : 0, t0, s && s.kerb ? 0.05 : 0.12);
      const gg = this._sampleLoop('gravel');
      if (gg) gg.gain.setTargetAtTime(s && s.offtrack ? 0.4 : 0, t0, s && s.offtrack ? 0.08 : 0.15);
      // ---- trackside atmosphere (race only: follows the crowd level) ----
      const amb = this._crowdLevel || 0;
      this._ambT = (this._ambT || 0) + dt;
      const pa = this._sampleLoop('pa-announcer');
      if (pa) {
        // announcer swells every ~20s, silent when there is no crowd
        const swell = amb > 0 ? (Math.sin(this._ambT * 0.31) > 0.55 ? 0.16 : 0.05) : 0;
        pa.gain.setTargetAtTime(swell, t0, 1.2);
      }
      const heli = this._sampleLoop('helicopter');
      if (heli) {
        const drift = amb > 0 ? Math.max(0, Math.sin(this._ambT * 0.045 + 1.3)) * 0.14 : 0;
        heli.gain.setTargetAtTime(drift, t0, 2.0);
      }
      this._hornCool = Math.max(0, (this._hornCool ?? 20) - dt);
      if (amb > 0.2 && this._hornCool <= 0) {
        this._hornCool = 24 + (this._ambT % 37);
        this._playSample('air-horn', { gain: 0.14, jitter: 0.12 });
      }
      // heavy-braking moan (rare, deep)
      this._brakeCool = Math.max(0, (this._brakeCool || 0) - dt);
      if (s && s.brake > 0.85 && s.speed > 46 && this._brakeCool <= 0) {
        this._brakeCool = 9;
        this._playSample('brake-screech', { gain: 0.24, rate: 0.9, jitter: 0.08 });
      }
      this._screechCool = Math.max(0, (this._screechCool || 0) - dt);
      // screech only on sustained hard slip, rarely, pitched down for weight
      this._slipT = s && s.slip ? (this._slipT || 0) + dt : 0;
      if (this._slipT > 0.55 && s.speed > 26 && this._screechCool <= 0) {
        this._screechCool = 6;
        this._playSample('tyre-screech', { gain: 0.3, rate: 0.85, jitter: 0.06 });
      }
    }
    if (!this.ready) return;
    s = s || EMPTY;
    const t = this.ctx.currentTime;
    const step = Number.isFinite(dt) && dt > 0 ? (dt > 0.1 ? 0.1 : dt) : 1 / 60;
    const targets = deriveAudioTargets(s, this._audioTargets);

    // ---- decay the shift envelopes (flywheel snap + downshift throttle blip) ----
    this._shiftEnv *= Math.exp(-step / 0.075);
    if (this._shiftEnv < 1e-4) this._shiftEnv = 0;
    this._blipEnv *= Math.exp(-step / 0.055);
    if (this._blipEnv < 1e-3) this._blipEnv = 0;

    // Flywheel: revs follow the driveline through a short inertia. A seamless
    // upshift snaps to the new ratio in a few tens of ms; a rev-match blip is
    // a little slower on the way up.
    const fly = this._shiftEnv > 0.05 ? (this._shiftDir > 0 ? 55 : 24) : 15;
    this._rpm = smoothTelemetry(this._rpm, targets.rpm, step, fly, fly);
    this._thr = smoothTelemetry(this._thr, targets.throttle, step, 24, 13);
    this._load = smoothTelemetry(this._load, targets.load, step, 9, 4.5);
    this._slip = smoothTelemetry(this._slip, targets.slip, step, 16, 6);
    this._lockup = smoothTelemetry(this._lockup, targets.lockup, step, 18, 7);
    this._wetness = smoothTelemetry(this._wetness, targets.wetness, step, 2.5, 1.4);
    this._damage = smoothTelemetry(this._damage, targets.damage, step, 4, 1.5);
    const rpm = this._rpm;
    const thr = this._thr;
    const speed = targets.speed;
    const view = targets.view;
    const cockpit = targets.cockpit;
    const boost = targets.boost;
    this._speed = speed;

    // Smoothed longitudinal acceleration — lets shift() infer up vs down when the
    // caller does not pass a direction (accelerating = upshift, braking = down).
    const rawAccel = (speed - this._prevSpeed) / step;
    this._accel += (rawAccel - this._accel) * Math.min(1, step * 8);
    this._prevSpeed = speed;

    const gear = this._resolveGear(s.gear, speed, rpm, step);

    // ---- combustion --------------------------------------------------------
    // power = torque demand (throttle, or the blip on a downshift). It morphs
    // the wavetable mix, the clip drive, the brightness and the level together,
    // so on/off throttle is a change of character, not just of volume.
    const power = Math.max(thr, this._blipEnv);
    const fc = cycleHz(rpm);
    if (this.pitch) this.pitch.offset.setTargetAtTime(fc, t, 0.014);
    else {
      for (let i = 0; i < this._engOsc.length; i++) {
        this._engOsc[i].frequency.setTargetAtTime(fc, t, 0.014);
      }
    }
    const scream = clamp01((rpm - 0.22) * 1.8);
    this.gLow.gain.setTargetAtTime(power * (1 - scream), t, 0.03);
    this.gHigh.gain.setTargetAtTime(power * scream, t, 0.03);
    this.gOver.gain.setTargetAtTime(1 - power, t, 0.03);
    this.burble.gain.setTargetAtTime((1 - power) * 11, t, 0.03);
    this.engDrive.gain.setTargetAtTime(0.34 + power * (0.56 + 0.5 * rpm) + boost * 0.15, t, 0.03);
    this.gritGain.gain.setTargetAtTime(0.04 + power * 0.2, t, 0.04);
    this.jitGain.gain.setTargetAtTime(0.16 - 0.1 * rpm + 0.06 * (1 - power), t, 0.1);
    // Each ratio nudges the mid resonance, so gears keep their own vowel.
    this.formant.frequency.setTargetAtTime(880 + gear * 50, t, 0.09);
    this.raspEQ.gain.setTargetAtTime(power * 9 - 3, t, 0.05);
    this.engineLP.frequency.setTargetAtTime(
      1100 + rpm * 2000 + power * (1600 + rpm * 6000), t, 0.035);
    // When the sampled engine is active it carries the voice — the synth drops
    // to a bed that masks loop seams and keeps continuous pitch precision.
    const bed = this._eng ? (this._synthBedScale || 0.42) : 1;
    this.engineGain.gain.setTargetAtTime(
      (0.8 + 0.2 * power) * (0.78 + 0.22 * rpm) * 0.12 * bed, t, 0.035);
    this.intakeBP.frequency.setTargetAtTime(360 + rpm * 640, t, 0.05);
    this.intakeGain.gain.setTargetAtTime(
      Math.pow(power, 1.5) * (0.3 + 0.7 * rpm) * 0.3 * VIEW.intake[view] * bed, t, 0.045);
    this.raspGain.gain.setTargetAtTime(
      power * power * (0.2 + 0.8 * rpm) * (0.22 + boost * 0.07) * VIEW.rasp[view] * bed, t, 0.04);
    this.subGain.gain.setTargetAtTime((0.02 + 0.09 * power) * (0.5 + 0.5 * cockpit), t, 0.06);

    // Rev limiter (or pit limiter, when the caller passes it): soft-cut stutter.
    this._lim = smoothTelemetry(this._lim,
      Math.max(targets.limiter * 0.8, targets.rpm > 0.955 && thr > 0.5 ? 1 : 0), step, 40, 16);
    const cutDepth = this._lim * 0.44;
    this.engLim.gain.setTargetAtTime(1 - cutDepth, t, 0.012);
    this.limDepth.gain.setTargetAtTime(cutDepth, t, 0.012);
    this.limPitch.gain.setTargetAtTime(this._lim * 0.012, t, 0.012);
    this.limPop.gain.setTargetAtTime(this._lim * 0.3, t, 0.012);
    this.limPopDepth.gain.setTargetAtTime(this._lim * -0.3, t, 0.012);

    // ---- turbo -------------------------------------------------------------
    // No MGU-H in 2026: the spool lags the throttle (~0.3 s up, slower down).
    const spoolTarget = thr * (0.3 + 0.7 * rpm);
    this._spool += (spoolTarget - this._spool) *
      Math.min(1, step * (spoolTarget > this._spool ? 3.4 : 2.2));
    const spool = this._spool;
    this.turboBP.frequency.setTargetAtTime(2400 + spool * 4600 + rpm * 700, t, 0.05);
    this.turboNoiseGain.gain.setTargetAtTime(spool * spool * 0.16, t, 0.07);

    // Lift-off: blow-off flutter if the turbo was loaded, then overrun pops
    // that thin out as the fuel cut takes hold (re-armed by every downshift).
    const rawThr = targets.throttle;
    this._wgCooldown = Math.max(0, this._wgCooldown - step);
    this._thrHold = Math.max(rawThr, this._thrHold - step * 3);
    if (rawThr < 0.2 && this._thrHold > 0.55 && this._wgCooldown === 0) {
      this._thrHold = 0;
      this._wgCooldown = 0.35;
      if (spool > 0.3) this._wastegate(t, spool);
    }
    const overrun = rawThr < 0.12 && rpm > 0.28 && speed > 8;
    this._overT = overrun ? this._overT + step : 0;
    this._popT -= step;
    if (overrun && this._popT <= 0 && this._overT > 0.06 && this._overT < 2.4) {
      this._popT = 0.07 + Math.random() * 0.3;
      this._crackle(t + 0.012 + Math.random() * step, (1 - this._overT / 2.4) * (0.3 + 0.7 * rpm),
        1 + Math.floor(Math.random() * 3));
    }

    // ---- MGU-K + Manual Override ------------------------------------------
    // Whine level and colour follow the power flow: deploy on throttle, a
    // louder tremolo'd whine while harvesting on the brakes or the coast.
    const moving = clamp01(speed / 20);
    const whine = VIEW.whine[view];
    const deploy = thr * (0.35 + 0.65 * targets.deploy);
    const regen = targets.regen * moving * clamp01(rpm * 2.5) *
      (thr > 0.1 ? 0.45 : 0.45 + 0.55 * targets.brake);
    this.mgukBP.frequency.setTargetAtTime(fc * 38, t, 0.06);
    this.mgukGain.gain.setTargetAtTime(
      (0.008 + deploy * 0.045 + regen * 0.058) * (0.5 + 0.5 * whine), t, 0.07);
    this.mgukTrem.gain.setTargetAtTime(regen * 0.016, t, 0.08);
    // Override: the longer it is held, the further the surge creeps upward.
    this._boostT = boost > 0.5 ? Math.min(1, this._boostT + step * 0.6) : 0;
    this.ovrOsc.detune.setTargetAtTime(this._boostT * 110, t, 0.12);
    this.ovrGain.gain.setTargetAtTime(boost * 0.06, t, boost ? 0.05 : 0.14);
    this.boostBP.frequency.setTargetAtTime(3600 + rpm * 1800, t, 0.05);
    this.boostGain.gain.setTargetAtTime(boost * 0.05, t, 0.05);

    // ---- transmission -----------------------------------------------------
    const transF = 70 + speed * 27;
    this.transOsc.frequency.setTargetAtTime(transF, t, 0.04);
    this.transBP.frequency.setTargetAtTime(transF, t, 0.05);
    this.transGain.gain.setTargetAtTime(
      (0.005 + 0.022 * power + 0.007 * (1 - thr)) * moving * whine, t, 0.06);
    const meshF = fc * 2 * MESH[gear];
    this.meshOsc.frequency.setTargetAtTime(meshF, t, 0.03);
    this.meshBP.frequency.setTargetAtTime(meshF, t, 0.05);
    this.meshGain.gain.setTargetAtTime((0.004 + 0.014 * power) * whine, t, 0.07);

    // ---- wind (~speed^2.5) ------------------------------------------------
    const sp = Math.min(1.1, speed / 90);
    const wind = sp * sp * Math.sqrt(sp) * VIEW.wind[view];
    this.windLP.frequency.setTargetAtTime(140 + speed * (cockpit ? 6 : 9), t, 0.1);
    this.windGain.gain.setTargetAtTime(wind * 0.34, t, 0.12);
    this.windGust.gain.setTargetAtTime(wind * 0.07, t, 0.2);
    this.windBP.frequency.setTargetAtTime(900 + speed * 38, t, 0.1);
    this.windHiGain.gain.setTargetAtTime(wind * 0.05, t, 0.12);

    // ---- surfaces ---------------------------------------------------------
    // Kerb strike rate is speed / block length, so it thumps at walking pace
    // and buzzes flat out.
    this.kerbOsc.frequency.setTargetAtTime(clampNum(speed / KERB_PITCH, 4, 120), t, 0.04);
    this.kerbGain.gain.setTargetAtTime(targets.kerb * 0.2, t, targets.kerb ? 0.02 : 0.07);
    this.kerbNoiseGain.gain.setTargetAtTime(targets.kerb * 0.11, t, targets.kerb ? 0.02 : 0.08);

    const rolling = clamp01(speed / 58);
    const loose = Math.min(1, speed / 40);
    this.gravelLP.frequency.setTargetAtTime(360 + speed * 7 + targets.gravel * 1100, t, 0.08);
    this.gravelGain.gain.setTargetAtTime(
      Math.max(targets.grass * 0.6, targets.gravel * 0.4) * loose, t, 0.06);
    this._grainSrc.playbackRate.setTargetAtTime(0.5 + speed / 45, t, 0.1);
    this.grainGain.gain.setTargetAtTime(
      (targets.gravel * 0.55 + targets.grass * 0.22) * loose, t, 0.06);

    this.roadBP.frequency.setTargetAtTime(300 + speed * 8 + targets.roughness * 420, t, 0.07);
    this.roadGain.gain.setTargetAtTime(
      rolling * (0.14 + targets.roughness * 0.3 + this._load * 0.1) * VIEW.tyre[view], t, 0.075);

    // Continuous scrub is more useful for held arrow-key steering than repeated
    // bursts: intensity and pitch tell the player how close the tyre is to giving up.
    this.scrubBP.frequency.setTargetAtTime(680 + speed * 11 + this._slip * 520, t, 0.045);
    this.scrubGain.gain.setTargetAtTime(this._slip * rolling * (0.045 + targets.roughness * 0.04), t, 0.055);
    this.lockOsc.frequency.setTargetAtTime(1120 + speed * 8, t, 0.045);
    this.lockBP.frequency.setTargetAtTime(1250 + speed * 10, t, 0.05);
    this.lockGain.gain.setTargetAtTime(this._lockup * rolling * 0.055, t, 0.04);
    this.lockNoiseBP.frequency.setTargetAtTime(1500 + speed * 13, t, 0.05);
    this.lockNoiseGain.gain.setTargetAtTime(this._lockup * rolling * 0.09, t, 0.045);

    this.rainHP.frequency.setTargetAtTime(2700 + targets.rain * 1700, t, 0.12);
    this.rainGain.gain.setTargetAtTime(targets.rain * (cockpit ? 0.024 : 0.045), t, 0.15);
    this.dropGain.gain.setTargetAtTime(targets.rain * (0.1 + 0.25 * rolling), t, 0.25);
    this.sprayBP.frequency.setTargetAtTime(900 + speed * 15, t, 0.1);
    this.sprayGain.gain.setTargetAtTime(Math.max(targets.spray, this._wetness * rolling) *
      rolling * (cockpit ? 0.05 : 0.08), t, 0.12);

    this.damageBP.frequency.setTargetAtTime(560 + gear * 48 + speed * 2, t, 0.08);
    this.damageGain.gain.setTargetAtTime(this._damage * rolling * 0.035, t, 0.12);
    this.damageFlutter.gain.setTargetAtTime(this._damage * rolling * 0.018, t, 0.12);

    this._bottomCooldown = Math.max(0, this._bottomCooldown - step);
    if (targets.bottoming > 0.15 && this._bottoming <= 0.15 && this._bottomCooldown === 0) {
      this._bottomCooldown = 0.14;
      this._bottomStrike(t, targets.bottoming * (0.35 + rolling * 0.65));
    }
    this._bottoming = targets.bottoming;

    const wallScrape = clamp01(s.wallScrape);
    const carScrape = clamp01(s.carScrape);
    const scrapeLevel = Math.max(wallScrape * 0.2, carScrape * 0.12);
    const scrapeOn = scrapeLevel > 0.001;
    this.contactScrapeBP.frequency.setTargetAtTime(
      wallScrape >= carScrape ? 720 + speed * 5 : 1180 + speed * 4,
      t,
      0.035,
    );
    this.contactScrapeBP.Q.setTargetAtTime(wallScrape >= carScrape ? 0.72 : 1.1, t, 0.04);
    this.contactScrapeGain.gain.setTargetAtTime(scrapeLevel, t, scrapeOn ? 0.035 : 0.1);
    if (this.contactScrapePan) {
      this.contactScrapePan.pan.setTargetAtTime(clampNum(s.contactSide, -1, 1) * 0.7, t, 0.04);
    }

    // ---- listener perspective ---------------------------------------------
    this.perspectiveLP.frequency.setTargetAtTime(
      VIEW.lp[view] + (cockpit ? speed * 18 : rpm * 3000), t, 0.05);
    this.perspectiveBody.frequency.setTargetAtTime(230 + speed, t, 0.12);
    this.perspectiveBody.gain.setTargetAtTime(VIEW.body[view], t, 0.16);
    this.erGain.gain.setTargetAtTime(cockpit * 0.5, t, 0.16);
    this.spaceSend.gain.setTargetAtTime(VIEW.space[view] + targets.enclosure * 0.3, t, 0.2);
    // (the tub booms at low revs, so the cockpit trim leans on rpm a little)
    this.viewTrim.gain.setTargetAtTime(
      VIEW.trim[view] * (1 - cockpit * 0.3 * (1 - rpm)), t, 0.16);

    if (s.opponents) this.updateOpponents(s.opponents);
    else this._releaseOpponentVoices(t);
    this._wallImpactCooldown = Math.max(0, this._wallImpactCooldown - step);
    this._carImpactCooldown = Math.max(0, this._carImpactCooldown - step);
  }

  // Gear-shift. dir > 0 (default) = upshift, dir < 0 = downshift.
  // shift() with no argument still works: the direction is inferred from load.
  shift(dir) {
    if (dir < 0) this._playSample('downshift-crackle', { gain: 0.42, rate: 0.95, jitter: 0.08 });
    else this._playSample('gear-shift', { gain: 0.22, rate: 0.88, jitter: 0.04 });

    if (!this.ready) return;
    const t = this.ctx.currentTime;
    let d;
    if (Number.isFinite(+dir) && +dir !== 0) {
      d = +dir > 0 ? 1 : -1;
    } else if (this._accel > 0.35) {
      d = 1; // pulling away -> upshift
    } else if (this._accel < -0.35) {
      d = -1; // braking -> downshift
    } else {
      d = this._rpm > 0.62 ? 1 : -1; // coasting: fall back to where the revs are
    }

    this._shiftDir = d;
    this._shiftEnv = 1; // update() snaps the flywheel to the new ratio while this decays
    this._gear = clampNum(this._gear + d, 1, 8);
    this._gearCand = this._gear;
    this._gearCandT = 0;

    const cut = this.engCut.gain;
    cut.cancelScheduledValues(t);
    if (d > 0) {
      // Seamless upshift: ~30 ms ignition cut, a crack as the cylinders relight,
      // then the torque comes back in with a small overshoot.
      cut.setTargetAtTime(0.08, t, 0.004);
      cut.setTargetAtTime(1.2, t + 0.03, 0.008);
      cut.setTargetAtTime(1, t + 0.075, 0.045);
      this._crackle(t + 0.026, 0.5 + 0.5 * this._thr, 1);
    } else {
      // Downshift: throttle blip to rev-match (a bark, brighter for ~90 ms via
      // _blipEnv), then the overrun pops it leaves in the exhaust.
      this._blipEnv = 0.8;
      this._overT = Math.min(this._overT, 0.5);
      cut.setTargetAtTime(1.3, t, 0.012);
      cut.setTargetAtTime(1, t + 0.07, 0.04);
      this._crackle(t + 0.11, 0.8, 4);
    }
  }

  wallImpact(event) {
    const payload = typeof event === 'number' ? { intensity: event } : (event || EMPTY);
    const i = clamp01(payload.intensity == null ? 1 : payload.intensity);
    const normal = clamp01((Number(payload.normalSpeed) || 0) / 55);
    const severity = Math.max(i, normal);
    const side = clampNum(payload.side, -1, 1);
    if (i <= 0 || this._wallImpactCooldown > 0) return;
    this._wallImpactCooldown = 0.09;
    if (this._playSample('collision', {
      gain: Math.min(0.66, 0.22 + severity * 0.44), rate: 0.88 - normal * 0.12, jitter: 0.05, duck: 0.3, pan: side * 0.72,
    })) return;
    if (!this.ready) return;
    this._duck(this.ctx.currentTime, 0.22, 0.62);
    this._toneShot({ type: 'sine', freq: 120 - normal * 38, endFreq: 34, peak: 0.25 * severity + 0.05, dur: 0.25 + normal * 0.1, decay: 0.08 + normal * 0.03, pan: side * 0.55 });
    this._noiseShot({ dur: 0.17 + normal * 0.07, type: 'bandpass', freq: 1300 + severity * 900, q: 0.7, peak: 0.17 * severity + 0.04, decay: 0.045, pan: side * 0.82 });
    this._noiseShot({ dur: 0.2 + normal * 0.08, type: 'highpass', freq: 2600, q: 0.55, peak: 0.075 * severity + 0.015, decay: 0.07, delay: 0.012, pan: side * 0.65 });
  }

  carImpact(event) {
    const payload = typeof event === 'number' ? { intensity: event } : (event || EMPTY);
    const i = clamp01(payload.intensity == null ? 0.4 : payload.intensity);
    const closing = clamp01((Number(payload.closingSpeed) || 0) / 32);
    const severity = Math.max(i, closing);
    const side = clampNum(payload.side, -1, 1);
    if (i <= 0 || this._carImpactCooldown > 0) return;
    this._carImpactCooldown = 0.08;
    if (this._playSample('collision', {
      gain: Math.min(0.48, 0.15 + severity * 0.33), rate: 1.1 - closing * 0.12, jitter: 0.055, duck: 0.16, pan: side * 0.68,
    })) return;
    if (!this.ready) return;
    this._duck(this.ctx.currentTime, 0.15, 0.4);
    this._toneShot({ type: 'triangle', freq: 225 - closing * 55, endFreq: 78, peak: 0.16 * severity + 0.035, dur: 0.16 + closing * 0.07, decay: 0.055, pan: side * 0.55 });
    this._noiseShot({ dur: 0.14 + closing * 0.07, type: 'bandpass', freq: 1850 + severity * 700, q: 0.9, peak: 0.13 * severity + 0.025, decay: 0.045, pan: side * 0.78 });
  }

  // Backwards-compatible hook used by older tooling/sample auditions.
  collision(intensity) {
    this.wallImpact(intensity);
  }

  countdownBeep(final) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._duck(t, final ? 0.5 : 0.2, 1);
    if (final) {
      this._stopCrescendo(0.3); // lights out: release the tension pad
      this._toneShot({ type: 'sine', freq: 880, peak: 0.25, dur: 0.65, decay: 0.22, sustain: 0.3 });
      this._toneShot({ type: 'sine', freq: 146.8, peak: 0.16, dur: 0.5, decay: 0.16 });
    } else {
      this._toneShot({ type: 'sine', freq: 440, peak: 0.22, dur: 0.18, decay: 0.05, sustain: 0.06 });
    }
  }

  uiClick() {
    if (!this.ready) return;
    this._toneShot({ type: 'sine', freq: 1350, peak: 0.1, dur: 0.05, decay: 0.014 });
  }

  uiConfirm() {
    if (!this.ready) return;
    this._toneShot({ type: 'sine', freq: 660, peak: 0.12, dur: 0.12, decay: 0.04 });
    this._toneShot({ type: 'sine', freq: 990, peak: 0.12, dur: 0.16, decay: 0.05, delay: 0.09 });
  }

  // Spotter: a double blip for a car alongside, panned to its side (-1 left,
  // +1 right, 0 both) and pitched lower on the left so the side survives mono
  // playback. `clear` is the single soft blip once nobody is alongside.
  spotter(side = 0, clear = false) {
    if (!this.ready) return;
    if (clear) {
      this._toneShot({ type: 'sine', freq: 620, peak: 0.07, dur: 0.1, decay: 0.035 });
      return;
    }
    const freq = side < 0 ? 880 : side > 0 ? 1320 : 1100;
    const pan = clampNum(side, -1, 1) * 0.85;
    for (let k = 0; k < 2; k++) {
      this._toneShot({ type: 'triangle', freq, peak: 0.11, dur: 0.06, decay: 0.018, delay: k * 0.085, pan });
    }
  }

  // Driver warnings: 'limits' as the car leaves the road at speed, 'battery'
  // as the electrical store runs low.
  warn(kind) {
    if (!this.ready) return;
    if (kind === 'battery') {
      this._toneShot({ type: 'triangle', freq: 520, endFreq: 260, peak: 0.12, dur: 0.3, decay: 0.09, sustain: 0.1 });
      return;
    }
    this._toneShot({ type: 'square', freq: 1480, peak: 0.07, dur: 0.07, decay: 0.02 });
    this._toneShot({ type: 'square', freq: 1110, peak: 0.07, dur: 0.1, decay: 0.03, delay: 0.09 });
  }

  finishFanfare() {
    this._playSample('finish-cheer', { gain: 0.85 });

    if (!this.ready) return;
    this._duck(this.ctx.currentTime, 1.2, 1);
    const notes0 = 523.25, notes1 = 659.25, notes2 = 783.99, notes3 = 1046.5; // C major stack
    for (let k = 0; k < 4; k++) {
      const n = k === 0 ? notes0 : k === 1 ? notes1 : k === 2 ? notes2 : notes3;
      this._toneShot({
        type: 'triangle',
        freq: n,
        peak: 0.13,
        dur: 1.1,
        decay: 0.3,
        sustain: 0.15,
        delay: k * 0.07,
      });
      this._toneShot({
        type: 'sawtooth',
        freq: n * 0.5,
        peak: 0.04,
        dur: 1.1,
        decay: 0.3,
        sustain: 0.15,
        delay: k * 0.07,
      });
    }
  }

  stopEngine() {
    if (!this.ready) return;
    this.engineOut.gain.setTargetAtTime(0, this.ctx.currentTime, 0.14);
  }

  startEngine() {
    if (!this.ready) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const t = this.ctx.currentTime;
    this.engineDuck.gain.setTargetAtTime(1, t, 0.05);
    this.engineOut.gain.setTargetAtTime(1, t, 0.2);
  }

  // ---- added one-shots / beds -------------------------------------------

  // Pit stop: four wheel-gun rattle bursts (off, off, on, on) then the car drop.
  // Total span ~2.2 s. Uses the pooled gun chain -> no node churn.
  // ==== ElevenLabs sample pack (optional layer; synthesis is the fallback) ====
  // Loads MP3 samples; each play falls back to the synthesized version when a
  // buffer is missing or still loading. Loops (crowd/kerb/gravel) are started
  // once and gain-gated.
  async loadSamplePack(base = 'sounds/') {
    this._samples = this._samples || {};
    const names = ['crowd-ambience', 'wheel-gun', 'gear-shift', 'collision',
      'kerb-rumble', 'gravel', 'radio-squelch', 'tyre-screech', 'finish-cheer',
      'engine-low', 'engine-mid', 'engine-high', 'engine-overrun',
      'downshift-crackle', 'pa-announcer', 'helicopter', 'air-horn', 'brake-screech', 'passby-whoosh'];
    await Promise.allSettled(names.map(async (n) => {
      try {
        const url = base + n + '.mp3';
        if (globalThis.APEX_LOCAL_ASSETS && !globalThis.APEX_LOCAL_ASSETS[url]) return;
        const res = await fetch(globalThis.APEX_LOCAL_ASSETS?.[url] || url);
        if (!res.ok) return;
        const buf = await res.arrayBuffer();
        // decode needs a context; defer decode until init() ran
        this._samplesRaw = this._samplesRaw || {};
        this._samplesRaw[n] = buf;
        if (this.ready) {
          this._samples[n] = await this.ctx.decodeAudioData(buf.slice(0));
          this._buildEngineSampler();
        }
      } catch { /* fallback synthesis covers it */ }
    }));
  }

  _decodePending() {
    if (!this.ready || !this._samplesRaw) return;
    const raw = this._samplesRaw;
    this._samplesRaw = null;
    for (const [n, buf] of Object.entries(raw)) {
      this.ctx.decodeAudioData(buf.slice(0)).then(b => { this._samples[n] = b; this._buildEngineSampler(); }).catch(() => {});
    }
  }

  // ==== sampled engine: RPM-banded loop crossfade over the synth bed ========
  // Three steady-state loops (low/mid/high) crossfaded by rpm with equal-power
  // weights and per-layer pitch tracking, plus an overrun loop that takes over
  // on closed throttle at speed. Routed into engineOut so ducking and the
  // off-track muffle chain apply. The synth engine stays underneath at reduced
  // gain to mask loop seams and carry precise continuous pitch.
  _buildEngineSampler() {
    if (this._eng || !this.ready || !this._samples) return;
    const have = ['engine-low', 'engine-mid', 'engine-high'].every(n => this._samples[n]);
    if (!have) return;
    const mk = (name) => {
      const srcN = this.ctx.createBufferSource();
      srcN.buffer = this._samples[name];
      srcN.loop = true;
      // trim loop points inward to dodge generation fade-in/outs
      const d = srcN.buffer.duration;
      srcN.loopStart = Math.min(0.4, d * 0.08);
      srcN.loopEnd = Math.max(d - 0.4, d * 0.92);
      const g = this.ctx.createGain();
      g.gain.value = 0;
      srcN.connect(g);
      return { src: srcN, g };
    };
    const warm = this.ctx.createBiquadFilter();
    warm.type = 'lowshelf'; warm.frequency.value = 160; warm.gain.value = 4;
    warm.connect(this.engineOut);
    this._engWarm = warm;
    this._eng = {
      layers: [
        { ...mk('engine-low'), center: 0.12, width: 0.34 },
        { ...mk('engine-mid'), center: 0.52, width: 0.36 },
        { ...mk('engine-high'), center: 0.9, width: 0.4 },
      ],
      overrun: this._samples['engine-overrun'] ? mk('engine-overrun') : null,
    };
    for (const l of this._eng.layers) { l.g.connect(warm); l.src.start(); }
    if (this._eng.overrun) { this._eng.overrun.g.connect(warm); this._eng.overrun.src.start(); }
    // samples carry the voice: pull the synth engine down to a bed
    this._synthBedScale = 0.42;
  }

  _sampleBus() {
    if (this._sampleBusNode || !this.ready) return this._sampleBusNode;
    const low = this.ctx.createBiquadFilter();
    low.type = 'lowshelf'; low.frequency.value = 140; low.gain.value = 5;
    const high = this.ctx.createBiquadFilter();
    high.type = 'highshelf'; high.frequency.value = 5200; high.gain.value = -5;
    low.connect(high).connect(this.master);
    this._sampleBusNode = low;
    return low;
  }

  _sample(name) { return (this._samples && this._samples[name]) || null; }

  /** Play a one-shot sample. Returns true if a sample was played. */
  _playSample(name, { gain = 1, rate = 1, jitter = 0, duck = 0, pan = 0 } = {}) {
    const buf = this._sample(name);
    if (!buf || !this.ready) return false;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate * (1 + (Math.random() - 0.5) * 2 * jitter);
    const g = this.ctx.createGain();
    g.gain.value = gain;
    const panner = this.ctx.createStereoPanner && Math.abs(pan) > 1e-4
      ? this.ctx.createStereoPanner() : null;
    if (panner) {
      panner.pan.value = clampNum(pan, -1, 1);
      src.connect(g).connect(panner).connect(this._sampleBus() || this.master);
    } else src.connect(g).connect(this._sampleBus() || this.master);
    if (duck) this._duck(t, duck, 1);
    src.start(t);
    src.onended = () => { try { src.disconnect(); g.disconnect(); panner?.disconnect(); } catch {} };
    return true;
  }

  /** Persistent looping sample gated by a gain node. Returns the gain or null. */
  _sampleLoop(name, target) {
    this._loops = this._loops || {};
    if (this._loops[name]) return this._loops[name];
    const buf = this._sample(name);
    if (!buf || !this.ready) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = name === 'kerb-rumble' ? 0.78 : name === 'gravel' ? 0.88 : 1;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(target || this._sampleBus() || this.master);
    src.start();
    this._loops[name] = g;
    return g;
  }

  /**
   * Close pass cue. Legacy passBy(side, intensity) and richer object payloads
   * both work: { id, side, intensity, distance, relativeSpeed, rpmFrac }.
   */
  passBy(side = 0, intensity = 1) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    const cue = normalizeOpponentCue(side, intensity, this._opponentCue);
    const prior = this._opponentCooldowns.get(cue.id);
    if (prior != null && now - prior < (cue.id === 'anonymous' ? 1.15 : 0.75)) return;
    if (this._opponentCooldowns.size >= 24 && !this._opponentCooldowns.has(cue.id)) {
      this._opponentCooldowns.delete(this._opponentCooldowns.keys().next().value);
    }
    this._opponentCooldowns.set(cue.id, now);
    this._lastPass = now || Number.EPSILON;
    const voice = this._acquireOpponentVoice(cue.id, now);
    if (!voice) return; // hard voice budget: never allocate around a busy player
    this._schedulePassVoice(voice, cue, now);

    // The generated pack remains an optional sweetener. It shares the same
    // budget/cooldown decision and synthesis still provides the no-network cue.
    this._playSample('passby-whoosh', {
      gain: cue.intensity * 0.2,
      rate: 0.92 + Math.min(0.16, Math.abs(cue.relativeSpeed) / 250),
      jitter: 0.035,
      pan: cue.side * 0.76,
    });
  }

  /**
   * Optional continuous proximity API. Call with at most the nearby cars; the
   * closest/first four receive stable spatial engine voices.
   */
  updateOpponents(opponents) {
    if (!this.ready || !opponents || typeof opponents.length !== 'number') return;
    const now = this.ctx.currentTime;
    const limit = Math.min(opponents.length, OPPONENT_VOICE_BUDGET);
    for (let i = 0; i < limit; i++) {
      const cue = normalizeOpponentCue(opponents[i], 1, this._opponentCue);
      let voice = null;
      for (let v = 0; v < this._opponentVoices.length; v++) {
        if (this._opponentVoices[v].id === cue.id) {
          voice = this._opponentVoices[v];
          break;
        }
      }
      if (!voice) voice = this._acquireOpponentVoice(cue.id, now);
      if (!voice) continue;
      // Doppler from the measured range rate: the note rides high while the gap
      // closes, falls through unison alongside and drops away as it opens
      // (the shift is leaned on x1.5 so car-to-car closing speeds still read).
      const dtv = now - voice.seen;
      if (voice.activeUntil <= now || dtv > 0.3) voice.vr = 0;
      else if (dtv > 1e-3) {
        voice.vr += (clampNum((voice.dist - cue.distance) / dtv, -70, 70) - voice.vr) *
          Math.min(1, dtv * 10);
      }
      voice.dist = cue.distance;
      voice.seen = now;
      voice.activeUntil = now + 0.16;
      const proximity = cue.intensity / (1 + cue.distance * 0.07);
      // Callers pass the raw physics rpmFrac (0.18..1.04) for other cars.
      const f = cycleHz(clamp01((cue.rpm - 0.18) / 0.86)) * 343 / (343 - voice.vr * 1.5);
      voice.engine.frequency.setTargetAtTime(f, now, 0.045);
      // Distance takes the top off; far cars also sit near the centre.
      voice.engineLP.frequency.setTargetAtTime(700 + 9500 / (1 + cue.distance / 5), now, 0.06);
      voice.engineGain.gain.setTargetAtTime(proximity * 0.2, now, 0.07);
      voice.airBP.frequency.setTargetAtTime(900 + Math.abs(cue.relativeSpeed) * 28, now, 0.08);
      voice.airGain.gain.setTargetAtTime(proximity * (0.015 + Math.min(0.05,
        Math.abs(cue.relativeSpeed) / 700)), now, 0.07);
      voice.pan?.pan.setTargetAtTime(
        cue.side * clampNum(3.4 / (cue.distance + 0.1), 0.12, 0.85), now, 0.08);
    }
    this._releaseOpponentVoices(now);
  }

  pitStop() {
    if (this._playSample('wheel-gun', { gain: 0.8, rate: 0.94, jitter: 0.03, duck: 2.2 })) return;

    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._duck(t, 2.2, 0.8);
    const g = this.gunGain.gain;
    g.cancelScheduledValues(t);
    for (let b = 0; b < 4; b++) {
      const t0 = t + 0.1 + b * 0.5;
      this.gunBP.frequency.setTargetAtTime(1450 + b * 230, t0, 0.02);
      const n = b % 2 === 0 ? 11 : 8; // undo bursts are longer than the do-ups
      for (let i = 0; i < n; i++) {
        const tp = t0 + i * 0.027;
        g.setTargetAtTime(0.2, tp, 0.003);
        g.setTargetAtTime(0.0001, tp + 0.009, 0.008);
      }
    }
    // Jack drop: dull clunk + suspension rattle at ~2.0 s.
    this._toneShot({ type: 'sine', freq: 96, endFreq: 42, peak: 0.5, dur: 0.34, decay: 0.1, delay: 2.0 });
    this._noiseShot({ dur: 0.28, type: 'lowpass', freq: 380, q: 0.8, peak: 0.3, decay: 0.07, delay: 2.0 });
    this._noiseShot({ dur: 0.2, type: 'bandpass', freq: 2500, q: 1.4, peak: 0.11, decay: 0.045, delay: 2.02 });
  }

  // Distant crowd bed with slow cheering swells. level 0..1, 0 fades it out.
  crowdAmbience(level) {
    if (!this.ready) return;
    const l = clamp01(level == null ? 0.6 : level);
    this._crowdLevel = l;
    const t = this.ctx.currentTime;
    // photographic-quality stadium bed when the sample pack is loaded
    const sg = this._sampleLoop('crowd-ambience');
    if (sg) {
      sg.gain.setTargetAtTime(l * 0.5, t, l > 0 ? 0.9 : 0.45);
      // keep the synth bed silent when the sample drives
      if (this._crowdStarted) {
        this.crowdGain.gain.setTargetAtTime(0, t, 0.4);
        this.crowdSwell.gain.setTargetAtTime(0, t, 0.4);
        this.crowdSwell2.gain.setTargetAtTime(0, t, 0.4);
      }
      return;
    }
    if (l > 0 && !this._crowdStarted) {
      this._crowdStarted = true;
      this.crowdSrc.start();
    }
    if (!this._crowdStarted) return;
    this.crowdGain.gain.setTargetAtTime(l * 0.085, t, l > 0 ? 0.7 : 0.45);
    this.crowdSwell.gain.setTargetAtTime(l * 0.05, t, 0.8);
    this.crowdSwell2.gain.setTargetAtTime(l * 0.028, t, 0.8);
    this.crowdLP.frequency.setTargetAtTime(900 + l * 800, t, 0.9);
  }

  // Race-engineer radio: open click, short beep, close click — all band-limited.
  radioTone() {
    if (this._playSample('radio-squelch', { gain: 0.7, jitter: 0.03 })) return;

    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._duck(t, 0.45, 1);
    const dest = this.radioHP;
    this._noiseShot({ dur: 0.05, type: 'highpass', freq: 1800, q: 0.7, peak: 0.16, decay: 0.012, dest });
    this._toneShot({ type: 'square', freq: 1180, peak: 0.11, dur: 0.12, decay: 0.03, sustain: 0.05, delay: 0.04, dest });
    this._noiseShot({ dur: 0.05, type: 'highpass', freq: 2200, q: 0.7, peak: 0.12, decay: 0.01, delay: 0.22, dest });
  }

  // Virtual Safety Car: double warning tone.
  vscBeep() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._duck(t, 0.6, 1);
    for (let k = 0; k < 2; k++) {
      this._toneShot({
        type: 'square',
        freq: 1046.5,
        peak: 0.13,
        dur: 0.2,
        decay: 0.04,
        sustain: 0.09,
        delay: k * 0.24,
      });
      this._toneShot({
        type: 'sine',
        freq: 523.25,
        peak: 0.09,
        dur: 0.2,
        decay: 0.04,
        sustain: 0.09,
        delay: k * 0.24,
      });
    }
  }

  // Rising tension pad for the start-lights sequence (~5 s). Auto-released when
  // countdownBeep(true) fires at lights-out, and self-terminating otherwise.
  startCrescendo() {
    if (!this.ready) return;
    this._stopCrescendo(0.1);
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const DUR = 5.0;

    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.09, t + DUR * 0.68);
    out.gain.linearRampToValueAtTime(0.16, t + DUR - 0.1);
    out.gain.setTargetAtTime(0.0001, t + DUR, 0.1);
    out.connect(this.master);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 3.2;
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.linearRampToValueAtTime(2600, t + DUR);
    lp.connect(out);

    // Root + fifth + shimmer, all creeping upward.
    const oA = ctx.createOscillator();
    oA.type = 'sawtooth';
    oA.frequency.setValueAtTime(82.4, t);
    oA.frequency.linearRampToValueAtTime(146.83, t + DUR);
    oA.connect(lp);

    const oB = ctx.createOscillator();
    oB.type = 'triangle';
    oB.frequency.setValueAtTime(123.47, t);
    oB.frequency.linearRampToValueAtTime(220, t + DUR);
    oB.connect(lp);

    const shimGain = ctx.createGain();
    shimGain.gain.setValueAtTime(0.0001, t);
    shimGain.gain.exponentialRampToValueAtTime(0.35, t + DUR);
    shimGain.connect(lp);
    const oC = ctx.createOscillator();
    oC.type = 'sine';
    oC.frequency.setValueAtTime(329.63, t);
    oC.frequency.linearRampToValueAtTime(587.33, t + DUR);
    oC.connect(shimGain);

    // Noise swell underneath (grandstand tension).
    const swell = ctx.createBufferSource();
    swell.buffer = this._crowdBuffer;
    swell.loop = true;
    const swBP = ctx.createBiquadFilter();
    swBP.type = 'bandpass';
    swBP.Q.value = 0.8;
    swBP.frequency.setValueAtTime(280, t);
    swBP.frequency.linearRampToValueAtTime(1200, t + DUR);
    const swGain = ctx.createGain();
    swGain.gain.setValueAtTime(0.0001, t);
    swGain.gain.exponentialRampToValueAtTime(0.5, t + DUR);
    swell.connect(swBP);
    swBP.connect(swGain);
    swGain.connect(out);

    const stopAt = t + DUR + 0.4;
    oA.start(t); oB.start(t); oC.start(t); swell.start(t);
    oA.stop(stopAt); oB.stop(stopAt); oC.stop(stopAt); swell.stop(stopAt);

    const self = this;
    const cresc = { out, lp, shimGain, swBP, swGain, oA, oB, oC, swell };
    this._cresc = cresc;
    oA.onended = function () {
      if (self._cresc === cresc) self._cresc = null;
      try {
        oA.disconnect(); oB.disconnect(); oC.disconnect(); swell.disconnect();
        shimGain.disconnect(); swBP.disconnect(); swGain.disconnect();
        lp.disconnect(); out.disconnect();
      } catch (e) { /* already torn down */ }
    };
  }

  // Public escape hatch for aborted starts (menu quit, restart during lights).
  stopCrescendo() {
    if (!this.ready) return;
    this._stopCrescendo(0.25);
  }

  // ---- internals ----

  _acquireOpponentVoice(id, now) {
    for (let i = 0; i < this._opponentVoices.length; i++) {
      const voice = this._opponentVoices[i];
      if (voice.id === id) return voice;
    }
    for (let i = 0; i < this._opponentVoices.length; i++) {
      const voice = this._opponentVoices[i];
      if (voice.activeUntil <= now) {
        voice.id = id;
        return voice;
      }
    }
    return null;
  }

  _schedulePassVoice(voice, cue, now) {
    const duration = cue.duration;
    const strength = cue.intensity * 0.32;
    const closeAt = now + duration * 0.38;
    const endAt = now + duration;
    voice.activeUntil = endAt + 0.08;

    const airF = 2100 + Math.min(1600, Math.abs(cue.relativeSpeed) * 24);
    const af = voice.airBP.frequency;
    af.cancelScheduledValues(now);
    af.setValueAtTime(airF, now);
    af.exponentialRampToValueAtTime(620 + cue.distance * 18, endAt);
    const ag = voice.airGain.gain;
    ag.cancelScheduledValues(now);
    ag.setValueAtTime(0.0001, now);
    ag.exponentialRampToValueAtTime(Math.max(0.001, strength), closeAt);
    ag.exponentialRampToValueAtTime(0.0001, endAt);

    // Doppler: hold the approach pitch, swing through unison at the closest
    // point, settle on the receding pitch. The tone stays low in the whoosh:
    // the car's continuous voice already carries its engine.
    const bend = clampNum(Math.abs(cue.relativeSpeed) / 229, 0.02, 0.2);
    const ef = cycleHz(clamp01((cue.rpm - 0.18) / 0.86));
    const ep = voice.engine.frequency;
    ep.cancelScheduledValues(now);
    ep.setValueAtTime(ef * (1 + bend), now);
    ep.linearRampToValueAtTime(ef * (1 + bend * 0.8), closeAt - duration * 0.12);
    ep.linearRampToValueAtTime(ef * (1 - bend * 0.8), closeAt + duration * 0.12);
    ep.linearRampToValueAtTime(ef * (1 - bend), endAt);
    voice.engineLP.frequency.setTargetAtTime(5200, now, 0.035);
    const eg = voice.engineGain.gain;
    eg.cancelScheduledValues(now);
    eg.setValueAtTime(0.0001, now);
    eg.exponentialRampToValueAtTime(Math.max(0.001, strength * 0.15), closeAt);
    eg.exponentialRampToValueAtTime(0.0001, endAt);

    if (voice.pan) {
      const pp = voice.pan.pan;
      pp.cancelScheduledValues(now);
      pp.setValueAtTime(cue.side * 0.92, now);
      pp.linearRampToValueAtTime(-cue.side * 0.48, endAt);
    }
  }

  _releaseOpponentVoices(now) {
    for (let i = 0; i < this._opponentVoices.length; i++) {
      const voice = this._opponentVoices[i];
      if (voice.activeUntil > now) continue;
      voice.engineGain.gain.setTargetAtTime(0, now, 0.07);
      voice.airGain.gain.setTargetAtTime(0, now, 0.07);
      voice.id = null;
    }
  }

  _bottomStrike(t0, intensity) {
    const i = clamp01(intensity);
    this.bottomOsc.frequency.setTargetAtTime(62 + i * 24, t0, 0.006);
    this.bottomBP.frequency.setTargetAtTime(390 + i * 260, t0, 0.01);
    const body = this.bottomGain.gain;
    const scrape = this.bottomNoiseGain.gain;
    body.cancelScheduledValues(t0);
    scrape.cancelScheduledValues(t0);
    this._pulse(body, t0, 0.11 * i, 0.004, 0.015, 0.045);
    this._pulse(scrape, t0, 0.075 * i, 0.003, 0.012, 0.035);
  }

  _gainNode(v, dest) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    if (dest) g.connect(dest);
    return g;
  }

  _filter(type, freq, q, dest) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    if (dest) f.connect(dest);
    return f;
  }

  // Permanent LFO -> depth gain -> target param. Depth is automated, so the
  // modulation can be gated on and off without allocating anything.
  _lfo(type, freq, depth, param) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.value = depth;
    osc.connect(g);
    g.connect(param);
    osc.start();
    return g;
  }

  // White noise loop. `grain` > 0 swaps the steady hiss for sparse decaying
  // clicks (that probability per sample): stones, droplets.
  _makeNoiseBuffer(seconds, channels = 1, grain = 0) {
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * seconds));
    const buf = this.ctx.createBuffer(channels, len, this.ctx.sampleRate);
    for (let c = 0; c < channels; c++) {
      const data = buf.getChannelData(c);
      let env = grain ? 0 : 1;
      for (let i = 0; i < len; i++) {
        if (grain) env = Math.random() < grain ? Math.random() : env * 0.97;
        data[i] = (Math.random() * 2 - 1) * env;
      }
    }
    return buf;
  }

  // Stereo impulse for the venue: discrete early reflections (ground, barrier,
  // far wall — different in each ear), one late slap off the pit wall, and a
  // short diffuse tail.
  _makeSpaceIR() {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * 0.5);
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = Math.floor(sr * 0.014); i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * 0.09)) * 0.045;
      }
      for (let k = 0; k < 7; k++) {
        d[Math.floor(sr * (0.007 + k * 0.013 + Math.random() * 0.009))] +=
          (k & 1 ? -0.8 : 0.8) / (1 + k * 0.6);
      }
      d[Math.floor(sr * (0.118 + c * 0.011))] += 0.4;
    }
    return buf;
  }

  _loop(buffer, start) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    if (start) src.start();
    return src;
  }

  // Oscillator from a type name or a PeriodicWave. `locked` slaves it to the
  // shared engine pitch (its fundamental is then one 720° engine cycle) and
  // starts it on the common tick so every locked voice stays in phase.
  _osc(wave, freq, dest, locked) {
    const o = this.ctx.createOscillator();
    if (typeof wave === 'string') o.type = wave;
    else if (wave) o.setPeriodicWave(wave);
    o.frequency.value = freq;
    if (locked && this.pitchMod) {
      o.frequency.value = 0;
      this.pitchMod.connect(o.frequency);
    } else if (locked) this._engOsc.push(o);
    o.connect(dest);
    o.start(locked ? this._t0 : 0);
    return o;
  }

  // Wavetable for one 720° engine cycle of a 90° V6 on three shared crank pins:
  // bank A fires every 240°, bank B `bank` degrees later (odd-fire — that is what
  // puts the 1.5-order growl under the firing note). 90° is the crank geometry;
  // a few degrees more stands in for the longer run from the far bank to the
  // turbine, and survives the clipper where a level imbalance would not.
  // `amps` is per-cylinder strength (imbalance creates the half orders);
  // `decay` / `attack` are the pulse's corner harmonics — higher means a
  // sharper pressure pulse and a brighter table.
  _engineWave(amps, decay, attack, bank) {
    if (!this.ctx.createPeriodicWave) return null;
    const n = 96;
    const re = new Float32Array(n + 1);
    const im = new Float32Array(n + 1);
    for (let k = 1; k <= n; k++) {
      let cr = 0, ci = 0;
      for (let c = 0; c < 6; c++) {
        const ph = k * (240 * (c >> 1) + (c & 1) * bank) * Math.PI / 360;
        cr += amps[c] * Math.cos(ph);
        ci -= amps[c] * Math.sin(ph);
      }
      // pulse spectrum 1 / ((1 + jk/decay)(1 + jk/attack))
      const dr = 1 - k * k / (decay * attack);
      const di = k / decay + k / attack;
      const m = 1 / (dr * dr + di * di);
      re[k] = (cr * dr + ci * di) * m;
      im[k] = (cr * di - ci * dr) * m;
    }
    return this.ctx.createPeriodicWave(re, im);
  }

  // Wavetable from (harmonic, amplitude) pairs, ascending.
  _partials(...pairs) {
    if (!this.ctx.createPeriodicWave) return null;
    const n = pairs[pairs.length - 2] + 1;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let i = 0; i < pairs.length; i += 2) im[pairs[i]] = pairs[i + 1];
    return this.ctx.createPeriodicWave(re, im);
  }

  // WaveShaper from a transfer function (plain gain where unsupported).
  _shaper(fn, oversample, dest) {
    const ctx = this.ctx;
    const node = ctx.createWaveShaper ? ctx.createWaveShaper() : ctx.createGain();
    if (ctx.createWaveShaper) {
      const curve = new Float32Array(1025);
      for (let i = 0; i < 1025; i++) curve[i] = fn(i / 512 - 1);
      node.curve = curve;
      node.oversample = oversample;
    }
    node.connect(dest);
    return node;
  }

  // Pink-ish noise with a slow rumble component: reads as a distant crowd once
  // it is band-limited, and is long enough that the loop point is inaudible.
  _makeCrowdBuffer(seconds) {
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * seconds));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + w * 0.055;
      b1 = 0.963 * b1 + w * 0.2;
      b2 = 0.78 * b2 + w * 0.45;
      let v = b0 * 1.6 + b1 + b2 * 0.5;
      if (v > 1) v = 1; else if (v < -1) v = -1;
      d[i] = v * 0.9;
    }
    return buf;
  }

  // Gentle -2 dB duck of the engine bus for one-shots. amount 0..1 scales it.
  _duck(t0, hold, amount) {
    const a = amount == null ? 1 : clamp01(amount);
    const target = 1 - (1 - DUCK_GAIN) * a;
    const p = this.engineDuck.gain;
    p.cancelScheduledValues(t0);
    p.setTargetAtTime(target, t0, 0.012);
    p.setTargetAtTime(1, t0 + Math.max(0.05, hold || 0.2), 0.09);
  }

  // Click-free pooled envelope: setTargetAtTime always starts from the param's
  // current value, so re-triggering mid-decay can never step or click.
  _pulse(param, t0, peak, atk, hold, dec) {
    param.setTargetAtTime(peak, t0, atk);
    param.setTargetAtTime(0.0001, t0 + hold, dec);
  }

  // Tyre-scrub burst on the pooled scrub chain (called from update()).
  _scrub(t0, freq, peak) {
    this.scrubBP.frequency.setTargetAtTime(freq, t0, 0.02);
    const p = this.scrubGain.gain;
    p.cancelScheduledValues(t0);
    this._pulse(p, t0, peak, 0.012, 0.05, 0.07);
  }

  // Wastegate whoosh: band sweeps down while the flutter LFO is gated open.
  _wastegate(t0, intensity) {
    const i = clamp01(intensity);
    const fp = this.wgBP.frequency;
    fp.cancelScheduledValues(t0);
    fp.setTargetAtTime(3000, t0, 0.01);
    fp.setTargetAtTime(700, t0 + 0.05, 0.14);
    // Flutter depth close to the level itself: the release chops into puffs.
    const p = this.wgGain.gain;
    p.cancelScheduledValues(t0);
    this._pulse(p, t0, 0.4 * i, 0.012, 0.09, 0.12);
    const d = this.wgFlutter.gain;
    d.cancelScheduledValues(t0);
    this._pulse(d, t0, 0.32 * i, 0.02, 0.1, 0.11);
  }

  // Overrun pops: unburnt fuel lighting in the exhaust. Each event is a bright
  // spit over a pipe thump, irregularly spaced.
  _crackle(t0, intensity, count) {
    const i = clamp01(intensity);
    if (i <= 0) return;
    const spit = this.crackleGain.gain;
    const thump = this.popGain.gain;
    this.crackleHP.frequency.setTargetAtTime(1500 + Math.random() * 900, t0, 0.02);
    this.crackleHP.Q.setTargetAtTime(0.8, t0, 0.02);
    let off = 0;
    for (let k = 0; k < (count || 6); k++) {
      const tp = t0 + off;
      const a = (0.35 + Math.random() * 0.65) * i;
      spit.setTargetAtTime(0.32 * a, tp, 0.002);
      spit.setTargetAtTime(0.0001, tp + 0.007, 0.011);
      thump.setTargetAtTime(0.9 * a, tp, 0.003);
      thump.setTargetAtTime(0.0001, tp + 0.012, 0.02);
      off += 0.024 + Math.random() * Math.random() * 0.12;
    }
  }

  // Single bright click on the pooled crackle chain (the shift "cut" transient).
  _blip(t0, freq, q, peak, dec) {
    this.crackleHP.frequency.setTargetAtTime(freq, t0, 0.01);
    this.crackleHP.Q.setTargetAtTime(q, t0, 0.01);
    const p = this.crackleGain.gain;
    p.cancelScheduledValues(t0);
    this._pulse(p, t0, peak, 0.004, 0.012, dec);
  }

  _stopCrescendo(fade) {
    const c = this._cresc;
    if (!c) return;
    this._cresc = null;
    const t = this.ctx.currentTime;
    const f = Math.max(0.02, fade || 0.2);
    c.out.gain.cancelScheduledValues(t);
    c.out.gain.setTargetAtTime(0.0001, t, f / 3);
    const stopAt = t + f + 0.1;
    try {
      c.oA.stop(stopAt); c.oB.stop(stopAt); c.oC.stop(stopAt); c.swell.stop(stopAt);
    } catch (e) { /* already stopped */ }
  }

  // Explicit gear when supplied, otherwise inferred from the speed/rpm ratio
  // (≈ the current gear's top speed) with hysteresis so the formant is stable.
  _resolveGear(gearIn, speed, rpm, step) {
    if (Number.isFinite(+gearIn) && +gearIn >= 1) {
      const g = Math.round(clampNum(gearIn, 1, 8));
      this._gear = g;
      this._gearCand = g;
      this._gearCandT = 0;
      return g;
    }
    const denom = clampNum(0.2 + 0.8 * rpm, 0.28, 1.05);
    const topGuess = speed / denom;
    let g = 1;
    for (let i = 0; i < 8; i++) {
      if (topGuess > GEAR_TOP[i] * 0.97) g = i + 2;
    }
    if (g > 8) g = 8;
    if (g === this._gear) {
      this._gearCand = g;
      this._gearCandT = 0;
      return g;
    }
    if (g !== this._gearCand) {
      this._gearCand = g;
      this._gearCandT = 0;
    }
    this._gearCandT += step;
    if (this._gearCandT > 0.12) {
      this._gear = g;
      this._gearCandT = 0;
    }
    return this._gear;
  }

  // One-shot filtered-noise burst with a click-free exponential envelope.
  _noiseShot(opt) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + (opt.delay || 0);
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer;

    const filt = ctx.createBiquadFilter();
    filt.type = opt.type || 'bandpass';
    filt.frequency.value = opt.freq || 1000;
    filt.Q.value = opt.q || 1;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, opt.peak), t0 + 0.006);
    g.gain.setTargetAtTime(0.0001, t0 + 0.006, opt.decay || 0.05);

    src.connect(filt);
    filt.connect(g);
    const pan = ctx.createStereoPanner && Number.isFinite(opt.pan) && Math.abs(opt.pan) > 1e-4
      ? ctx.createStereoPanner() : null;
    if (pan) {
      pan.pan.value = clampNum(opt.pan, -1, 1);
      g.connect(pan);
      pan.connect(opt.dest || this.master);
    } else g.connect(opt.dest || this.master);
    src.start(t0);
    src.stop(t0 + (opt.dur || 0.2) + 0.15);
    src.onended = function () {
      src.disconnect();
      filt.disconnect();
      g.disconnect();
      pan?.disconnect();
    };
  }

  // One-shot oscillator with optional pitch sweep and sustain, exp decay.
  _toneShot(opt) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + (opt.delay || 0);
    const dur = opt.dur || 0.15;
    const sustain = opt.sustain || 0;

    const osc = ctx.createOscillator();
    osc.type = opt.type || 'sine';
    osc.frequency.setValueAtTime(opt.freq || 440, t0);
    if (opt.endFreq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, opt.endFreq), t0 + dur);
    }

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, opt.peak), t0 + 0.008);
    if (sustain > 0) {
      g.gain.setValueAtTime(Math.max(0.001, opt.peak), t0 + 0.008 + sustain);
    }
    g.gain.setTargetAtTime(0.0001, t0 + 0.008 + sustain, opt.decay || 0.05);

    osc.connect(g);
    const pan = ctx.createStereoPanner && Number.isFinite(opt.pan) && Math.abs(opt.pan) > 1e-4
      ? ctx.createStereoPanner() : null;
    if (pan) {
      pan.pan.value = clampNum(opt.pan, -1, 1);
      g.connect(pan);
      pan.connect(opt.dest || this.master);
    } else g.connect(opt.dest || this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.25);
    osc.onended = function () {
      osc.disconnect();
      g.disconnect();
      pan?.disconnect();
    };
  }
}
