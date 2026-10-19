// Engine sound profiles. All synthesis is data-driven: the EngineSynth in
// engine.ts interprets these parameters, so adding a new engine is just a
// new preset object here — no DSP code changes.

export type EngineKind = 'combustion' | 'ev';

export interface ExhaustSpec {
  /** overall exhaust noise level 0..1 */
  noiseLevel: number;
  /** lowpass base cutoff at idle (Hz) */
  lowpassBase: number;
  /** extra cutoff (Hz) added at redline */
  lowpassSweep: number;
  /** resonant bandpass center (Hz) — the "bark" */
  resonanceFreq: number;
  /** resonance Q */
  resonanceQ: number;
  /** depth of amplitude modulation at the firing frequency 0..1 (the "chug") */
  pulseDepth: number;
}

export interface LopeSpec {
  /** lope LFO rate at idle (Hz) */
  rate: number;
  /** gain wobble depth 0..1 */
  depth: number;
  /** pitch wobble in cents */
  pitchWobbleCents: number;
}

export interface EngineProfile {
  id: string;
  name: string;
  tagline: string;
  kind: EngineKind;
  cylinders: number; // used for firing-frequency math on combustion engines
  idleRpm: number;
  redlineRpm: number;
  maxRpm: number; // hard ceiling (rev limiter)
  crankRpm: number;
  /** base oscillator type for the cylinder stack */
  oscType: OscillatorType;
  /** number of stacked oscillators (harmonic partials) */
  partials: number[];
  /** gain per partial, same length as `partials` */
  partialGains: number[];
  /** cents of detune spread across the stack (the "multi-cylinder" chorus) */
  detuneSpreadCents: number;
  /** sub-oscillator (one octave below firing freq) level 0..1 */
  subLevel: number;
  /** sub oscillator type */
  subType: OscillatorType;
  exhaust: ExhaustSpec;
  /** idle lope; null for smooth engines */
  lope: LopeSpec | null;
  /** exhaust crackle on throttle lift 0..1 */
  crackle: number;
  /** how fast the engine revs up (rpm per second) */
  revRateUp: number;
  /** how fast rpm falls (rev hang — slower = lazier) */
  revRateDown: number;
  /** overall output trim 0..1 */
  outputTrim: number;
  /** UI accent color */
  accent: string;
}

export const PROFILES: EngineProfile[] = [
  {
    id: 'v8',
    name: 'V8 Muscle',
    tagline: 'Big-block American thunder',
    kind: 'combustion',
    cylinders: 8,
    idleRpm: 750,
    redlineRpm: 6200,
    maxRpm: 6800,
    crankRpm: 220,
    oscType: 'sawtooth',
    partials: [1, 1, 2, 2, 3, 4, 5, 6],
    partialGains: [0.5, 0.35, 0.4, 0.28, 0.3, 0.22, 0.16, 0.12],
    detuneSpreadCents: 26,
    subLevel: 0.85,
    subType: 'sine',
    exhaust: {
      noiseLevel: 0.9,
      lowpassBase: 420,
      lowpassSweep: 5200,
      resonanceFreq: 140,
      resonanceQ: 2.2,
      pulseDepth: 0.75,
    },
    lope: { rate: 3.1, depth: 0.32, pitchWobbleCents: 22 },
    crackle: 0.9,
    revRateUp: 5200,
    revRateDown: 2600,
    outputTrim: 1.0,
    accent: '#ff453a',
  },
  {
    id: 'i6',
    name: 'Inline-6 Sport',
    tagline: 'Silky European straight-six',
    kind: 'combustion',
    cylinders: 6,
    idleRpm: 900,
    redlineRpm: 7200,
    maxRpm: 7800,
    crankRpm: 240,
    oscType: 'sawtooth',
    partials: [1, 1, 2, 3, 4, 6],
    partialGains: [0.5, 0.32, 0.42, 0.3, 0.24, 0.14],
    detuneSpreadCents: 14,
    subLevel: 0.5,
    subType: 'triangle',
    exhaust: {
      noiseLevel: 0.65,
      lowpassBase: 700,
      lowpassSweep: 6800,
      resonanceFreq: 220,
      resonanceQ: 3.0,
      pulseDepth: 0.45,
    },
    lope: { rate: 4.4, depth: 0.14, pitchWobbleCents: 10 },
    crackle: 0.55,
    revRateUp: 6800,
    revRateDown: 3400,
    outputTrim: 0.95,
    accent: '#ffd60a',
  },
  {
    id: 'ev',
    name: 'EV Spaceship',
    tagline: 'Turbine whir from the future',
    kind: 'ev',
    cylinders: 0,
    idleRpm: 60,
    redlineRpm: 7000,
    maxRpm: 7000,
    crankRpm: 60,
    oscType: 'sine',
    partials: [1, 1.004, 2.003, 2.996, 4.01],
    partialGains: [0.55, 0.4, 0.3, 0.22, 0.14],
    detuneSpreadCents: 8,
    subLevel: 0.4,
    subType: 'sine',
    exhaust: {
      noiseLevel: 0.35,
      lowpassBase: 900,
      lowpassSweep: 9000,
      resonanceFreq: 1200,
      resonanceQ: 1.2,
      pulseDepth: 0.0,
    },
    lope: null,
    crackle: 0,
    revRateUp: 9000,
    revRateDown: 5000,
    outputTrim: 0.9,
    accent: '#64d2ff',
  },
];

export function getProfile(id: string): EngineProfile {
  return PROFILES.find((p) => p.id === id) ?? PROFILES[0];
}
