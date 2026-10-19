// EngineSynth — a fully synthesized engine-voice engine (zero audio files).
//
// Signal chain (per profile):
//
//   osc stack (saw stack, detuned = "cylinders") ─┐
//   sub oscillator (octave below firing freq)    ──┤
//                                                ├─► osc lowpass ─► engineBus ─┐
//   pulse osc @ firing freq ─► pulseDepth ──────►┘ (AM = exhaust "chug")      │
//   lope LFO ─► lopeGain ───────────────────────►┘ (idle lope)                 │
//                                                                              ├─► compressor ─► master ─► out
//   pink-noise loop ─► lowpass ─► exhaust gain ────────────────────────────────┤
//                  └─► resonant bandpass ─► reso gain ────────────────────────┘
//   (EV profile adds: shimmer osc + wind-style bandpassed noise, no pulse/lope)
//
// Every continuous parameter moves through setTargetAtTime — no clicks or pops.

import { createPinkNoiseBuffer } from './noise';
import type { EngineProfile } from './profiles';

export type EngineState = 'off' | 'cranking' | 'running' | 'stopping';

interface LiveNodes {
  oscs: OscillatorNode[];
  sub: OscillatorNode;
  subGain: GainNode;
  oscFilter: BiquadFilterNode;
  engineBus: GainNode;
  pulseOsc: OscillatorNode | null;
  pulseDepth: GainNode | null;
  lopeOsc: OscillatorNode | null;
  lopeGain: GainNode | null;
  lopePitch: GainNode | null;
  noise: AudioBufferSourceNode;
  noiseFilter: BiquadFilterNode;
  noiseGain: GainNode;
  noiseReso: BiquadFilterNode;
  resoGain: GainNode;
  shimmer: OscillatorNode | null;
  shimmerGain: GainNode | null;
  comp: DynamicsCompressorNode;
  master: GainNode;
}

const TICK_MS = 50;
const PARAM_TAU = 0.035; // smoothing for every setTargetAtTime — click-free

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export class EngineSynth {
  private profile: EngineProfile;
  private ctx: AudioContext | null = null;
  private nodes: LiveNodes | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private state: EngineState = 'off';
  private tickId = 0;

  private target = { rpm: 0, throttle: 0 };
  private cur = { rpm: 0, throttle: 0 };
  private prevThrottle = 0;
  private blipUntil = 0;
  private blipRpm = 0;
  private volume = 0.8;
  private crackleEnabled = true;

  onStateChange: ((s: EngineState) => void) | null = null;
  onRpm: ((rpm: number) => void) | null = null;

  constructor(profile: EngineProfile) {
    this.profile = profile;
  }

  getState(): EngineState {
    return this.state;
  }

  getProfile(): EngineProfile {
    return this.profile;
  }

  getRpm(): number {
    return this.cur.rpm;
  }

  private setState(s: EngineState): void {
    this.state = s;
    this.onStateChange?.(s);
  }

  // ---------------------------------------------------------- public control

  /** Start: builds the graph, plays the starter-motor crank, then catches idle. */
  async start(): Promise<void> {
    if (this.state !== 'off') return;
    this.setState('cranking');

    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) {
      this.setState('off');
      throw new Error('Web Audio is not supported in this browser.');
    }
    try {
      this.ctx = new AC({ latencyHint: 'interactive' });
      await this.ctx.resume();
    } catch (err) {
      this.ctx = null;
      this.setState('off');
      throw err;
    }

    this.noiseBuffer = createPinkNoiseBuffer(this.ctx);
    this.buildGraph();

    // Starter motor whir (temporary nodes, torn down on catch).
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const whir = ctx.createOscillator();
    whir.type = 'sawtooth';
    whir.frequency.setValueAtTime(140, t);
    whir.frequency.linearRampToValueAtTime(190, t + 1.2);
    const whirFilter = ctx.createBiquadFilter();
    whirFilter.type = 'lowpass';
    whirFilter.frequency.value = 850;
    const whirGain = ctx.createGain();
    whirGain.gain.setValueAtTime(0, t);
    whirGain.gain.linearRampToValueAtTime(0.1, t + 0.15);
    whir.connect(whirFilter);
    whirFilter.connect(whirGain);
    whirGain.connect(this.nodes!.master);
    whir.start(t);

    // The engine itself chugs at crank rpm while the starter spins.
    this.target.rpm = this.profile.crankRpm;
    this.target.throttle = 0.25;
    this.cur.rpm = 0;
    this.cur.throttle = 0;
    this.startTick();

    // Engine "catches" after a beat, flares, then settles to idle.
    const crankTime = 1100 + Math.random() * 500;
    window.setTimeout(() => {
      if (this.state !== 'cranking' || !this.ctx || !this.nodes) return;
      const now = this.ctx.currentTime;
      whirGain.gain.setTargetAtTime(0, now, 0.06);
      whir.stop(now + 0.5);
      this.target.rpm = this.profile.idleRpm * 1.9;
      this.target.throttle = 0.4;
      window.setTimeout(() => {
        if (this.state !== 'cranking') return;
        this.target.rpm = this.profile.idleRpm;
        this.target.throttle = 0.12;
        this.setState('running');
      }, 450);
    }, crankTime);
  }

  /** Stop: rpm falls as the engine dies, then the graph is torn down. */
  stop(): void {
    if (this.state !== 'running' && this.state !== 'cranking') return;
    this.setState('stopping');
    this.blipUntil = 0;
    this.target.rpm = 0;
    this.target.throttle = 0;
    window.setTimeout(() => {
      const ctx = this.ctx;
      const n = this.nodes;
      if (!ctx || !n) {
        this.fullTeardown();
        return;
      }
      n.master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.22);
      window.setTimeout(() => this.fullTeardown(), 900);
    }, 1300);
  }

  /** Swap sound profile with a quick crossfade (no clicks). */
  async switchProfile(p: EngineProfile): Promise<void> {
    this.profile = p;
    if ((this.state !== 'running' && this.state !== 'cranking') || !this.ctx || !this.nodes) return;
    const ctx = this.ctx;
    this.nodes.master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.06);
    await new Promise((r) => setTimeout(r, 240));
    if (!this.ctx) return; // stopped mid-switch
    this.teardownNodes();
    this.target.rpm = clamp(this.target.rpm, p.idleRpm, p.maxRpm);
    this.buildGraph();
  }

  setTarget(rpm: number, throttle: number): void {
    this.target.rpm = clamp(rpm, 0, this.profile.maxRpm);
    this.target.throttle = clamp(throttle, 0, 1);
  }

  /** Momentary rpm dip + throttle cut, used for gear shifts. */
  blip(rpm: number, ms = 200): void {
    if (this.state !== 'running') return;
    this.blipRpm = clamp(rpm, this.profile.idleRpm, this.profile.maxRpm);
    this.blipUntil = performance.now() + ms;
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    if (this.ctx && this.nodes) {
      this.nodes.master.gain.setTargetAtTime(
        this.volume * this.profile.outputTrim * 0.9,
        this.ctx.currentTime,
        0.05,
      );
    }
  }

  setCrackleEnabled(b: boolean): void {
    this.crackleEnabled = b;
  }

  // ------------------------------------------------------------------ graph

  private buildGraph(): void {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuffer) return;
    const p = this.profile;
    const t = ctx.currentTime;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 20;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;

    const master = ctx.createGain();
    master.gain.value = 0.0001;
    master.gain.setTargetAtTime(this.volume * p.outputTrim * 0.9, t, 0.18);
    comp.connect(master);
    master.connect(ctx.destination);

    // --- cylinder stack ---
    const engineBus = ctx.createGain();
    engineBus.gain.value = 0;
    const oscFilter = ctx.createBiquadFilter();
    oscFilter.type = 'lowpass';
    oscFilter.frequency.value = 800;
    oscFilter.Q.value = 0.8;
    oscFilter.connect(engineBus);
    engineBus.connect(comp);

    const oscs: OscillatorNode[] = [];
    const n = p.partials.length;
    p.partials.forEach((mult, i) => {
      const o = ctx.createOscillator();
      o.type = p.oscType;
      o.frequency.value = Math.max(20, 55 * mult);
      o.detune.value = n > 1 ? (i / (n - 1) - 0.5) * p.detuneSpreadCents : 0;
      const g = ctx.createGain();
      g.gain.value = p.partialGains[i] ?? 0.2;
      o.connect(g);
      g.connect(oscFilter);
      o.start(t);
      oscs.push(o);
    });

    const sub = ctx.createOscillator();
    sub.type = p.subType;
    sub.frequency.value = 27;
    const subGain = ctx.createGain();
    subGain.gain.value = p.subLevel * 0.5;
    sub.connect(subGain);
    subGain.connect(engineBus);
    sub.start(t);

    // --- exhaust "chug": amplitude modulation at the firing frequency ---
    let pulseOsc: OscillatorNode | null = null;
    let pulseDepth: GainNode | null = null;
    if (p.exhaust.pulseDepth > 0) {
      pulseOsc = ctx.createOscillator();
      pulseOsc.type = 'sine';
      pulseOsc.frequency.value = 55;
      pulseDepth = ctx.createGain();
      pulseDepth.gain.value = 0;
      pulseOsc.connect(pulseDepth);
      pulseDepth.connect(engineBus.gain);
      pulseOsc.start(t);
    }

    // --- idle lope: slow gain wobble + pitch wobble ---
    let lopeOsc: OscillatorNode | null = null;
    let lopeGain: GainNode | null = null;
    let lopePitch: GainNode | null = null;
    if (p.lope) {
      lopeOsc = ctx.createOscillator();
      lopeOsc.type = 'sine';
      lopeOsc.frequency.value = p.lope.rate;
      lopeGain = ctx.createGain();
      lopeGain.gain.value = 0;
      lopeOsc.connect(lopeGain);
      lopeGain.connect(engineBus.gain);
      lopePitch = ctx.createGain();
      lopePitch.gain.value = p.lope.pitchWobbleCents;
      lopeOsc.connect(lopePitch);
      for (const o of oscs) lopePitch.connect(o.detune);
      lopeOsc.start(t);
    }

    // --- exhaust: filtered pink noise + resonant "bark" ---
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.loop = true;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.value = 600;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(comp);

    const noiseReso = ctx.createBiquadFilter();
    noiseReso.type = 'bandpass';
    noiseReso.frequency.value = p.exhaust.resonanceFreq;
    noiseReso.Q.value = p.exhaust.resonanceQ;
    const resoGain = ctx.createGain();
    resoGain.gain.value = 0;
    noise.connect(noiseReso);
    noiseReso.connect(resoGain);
    resoGain.connect(comp);
    noise.start(t);

    // --- EV extras: high shimmer + wind-like noise ---
    let shimmer: OscillatorNode | null = null;
    let shimmerGain: GainNode | null = null;
    if (p.kind === 'ev') {
      shimmer = ctx.createOscillator();
      shimmer.type = 'sine';
      shimmer.frequency.value = 600;
      shimmerGain = ctx.createGain();
      shimmerGain.gain.value = 0;
      const trem = ctx.createOscillator();
      trem.type = 'sine';
      trem.frequency.value = 7;
      const tremDepth = ctx.createGain();
      tremDepth.gain.value = 0.04;
      trem.connect(tremDepth);
      tremDepth.connect(shimmerGain.gain);
      trem.start(t);
      shimmer.connect(shimmerGain);
      shimmerGain.connect(comp);
      shimmer.start(t);
    }

    this.nodes = {
      oscs, sub, subGain, oscFilter, engineBus,
      pulseOsc, pulseDepth, lopeOsc, lopeGain, lopePitch,
      noise, noiseFilter, noiseGain, noiseReso, resoGain,
      shimmer, shimmerGain, comp, master,
    };
  }

  private teardownNodes(): void {
    const n = this.nodes;
    if (!n || !this.ctx) {
      this.nodes = null;
      return;
    }
    const t = this.ctx.currentTime;
    const stopSoon = (node: OscillatorNode | AudioBufferSourceNode) => {
      try {
        node.stop(t + 0.3);
      } catch {
        /* already stopped */
      }
      window.setTimeout(() => node.disconnect(), 600);
    };
    for (const o of n.oscs) stopSoon(o);
    stopSoon(n.sub);
    stopSoon(n.noise);
    if (n.pulseOsc) stopSoon(n.pulseOsc);
    if (n.lopeOsc) stopSoon(n.lopeOsc);
    if (n.shimmer) stopSoon(n.shimmer);
    this.nodes = null;
  }

  private fullTeardown(): void {
    this.stopTick();
    this.teardownNodes();
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      void ctx.close().catch(() => undefined);
    }
    this.noiseBuffer = null;
    this.cur = { rpm: 0, throttle: 0 };
    this.setState('off');
  }

  // ------------------------------------------------------------------ tick

  private startTick(): void {
    this.stopTick();
    this.tickId = window.setInterval(() => this.tick(), TICK_MS);
  }

  private stopTick(): void {
    if (this.tickId) {
      window.clearInterval(this.tickId);
      this.tickId = 0;
    }
  }

  private firingFreq(rpm: number): number {
    const p = this.profile;
    if (p.kind === 'ev') return 90 + (rpm / 7000) * 560;
    return Math.max(20, (rpm / 60) * (p.cylinders / 2));
  }

  private tick(): void {
    const p = this.profile;
    const dt = TICK_MS / 1000;
    const blipping = performance.now() < this.blipUntil;
    const tRpm = Math.min(blipping ? this.blipRpm : this.target.rpm, p.maxRpm);
    const tThr = blipping ? 0.04 : this.target.throttle;

    // rpm eases toward target at the profile's rev rate (rev hang on the way down)
    const rate = tRpm > this.cur.rpm ? p.revRateUp : p.revRateDown;
    const dv = rate * dt;
    this.cur.rpm += clamp(tRpm - this.cur.rpm, -dv, dv);

    this.cur.throttle += (tThr - this.cur.throttle) * 0.35;

    // throttle-lift crackle
    const lift = this.prevThrottle - this.cur.throttle;
    if (
      lift > 0.3 &&
      this.cur.rpm > 2200 &&
      this.crackleEnabled &&
      p.crackle > 0 &&
      this.state === 'running'
    ) {
      this.crackleBurst(p.crackle * Math.min(1, lift * 1.5));
    }
    this.prevThrottle = this.cur.throttle;

    this.applyParams();
  }

  private applyParams(): void {
    const ctx = this.ctx;
    const n = this.nodes;
    if (!ctx || !n) return;
    const p = this.profile;
    const t = ctx.currentTime;
    const rpm = this.cur.rpm;
    const thr = this.cur.throttle;
    const rpmN = clamp(rpm / p.redlineRpm, 0, 1.15);
    const f = this.firingFreq(rpm);
    const alive = rpm > 40 ? 1 : 0;

    n.oscs.forEach((o, i) => {
      o.frequency.setTargetAtTime(Math.max(20, f * p.partials[i]), t, PARAM_TAU);
    });
    n.sub.frequency.setTargetAtTime(Math.max(15, f / 2), t, PARAM_TAU);

    const base = (0.16 + thr * 0.84) * alive;
    n.engineBus.gain.setTargetAtTime(base * 0.5, t, PARAM_TAU);

    if (n.pulseOsc && n.pulseDepth) {
      n.pulseOsc.frequency.setTargetAtTime(Math.max(20, f), t, PARAM_TAU);
      n.pulseDepth.gain.setTargetAtTime(base * 0.5 * p.exhaust.pulseDepth * 0.9, t, PARAM_TAU);
    }

    if (n.lopeOsc && n.lopeGain && p.lope) {
      const lopeAmt = Math.max(0, 1 - rpmN * 1.6);
      n.lopeGain.gain.setTargetAtTime(base * 0.5 * p.lope.depth * lopeAmt, t, 0.08);
    }

    n.oscFilter.frequency.setTargetAtTime(
      p.exhaust.lowpassBase + rpmN * p.exhaust.lowpassSweep * 0.6 + thr * 1200,
      t,
      PARAM_TAU,
    );
    n.noiseFilter.frequency.setTargetAtTime(
      p.exhaust.lowpassBase * 1.4 + rpmN * p.exhaust.lowpassSweep + thr * 900,
      t,
      PARAM_TAU,
    );

    const exh = p.exhaust.noiseLevel * (0.12 + thr * 0.88) * alive;
    n.noiseGain.gain.setTargetAtTime(exh * 0.5, t, PARAM_TAU);
    n.resoGain.gain.setTargetAtTime(exh * 0.35 * (0.4 + thr * 0.6), t, PARAM_TAU);
    n.noiseReso.frequency.setTargetAtTime(p.exhaust.resonanceFreq * (1 + rpmN * 2.2), t, PARAM_TAU);

    if (n.shimmer && n.shimmerGain && p.kind === 'ev') {
      n.shimmer.frequency.setTargetAtTime(f * 6.02, t, PARAM_TAU);
      n.shimmerGain.gain.setTargetAtTime((0.05 + thr * 0.1) * alive, t, PARAM_TAU);
    }

    this.onRpm?.(rpm);
  }

  // ------------------------------------------------------- throttle crackle

  private crackleBurst(intensity: number): void {
    const ctx = this.ctx;
    const n = this.nodes;
    if (!ctx || !n || !this.noiseBuffer) return;
    const t0 = ctx.currentTime;
    const count = 4 + Math.floor(Math.random() * 5);
    for (let i = 0; i < count; i++) {
      const t = t0 + Math.random() * 0.38;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.playbackRate.value = 1.2 + Math.random() * 1.5;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1400 + Math.random() * 1600;
      bp.Q.value = 3.5;
      const g = ctx.createGain();
      const peak = 0.28 * intensity * (0.5 + Math.random() * 0.5);
      const dur = 0.03 + Math.random() * 0.05;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(Math.max(0.0011, peak), t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(bp);
      bp.connect(g);
      g.connect(n.comp);
      src.start(t, Math.random() * 1.5, dur + 0.05);
      src.stop(t + dur + 0.1);
    }
  }
}
