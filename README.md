# EV Engine Sound

A TeslaSound-style **engine-sound web app for EV owners** — a fully offline,
installable PWA that synthesizes engine audio live in the browser with the
**Web Audio API. Zero audio files.** Every rumble, whir, crackle, and gear
shift is computed in real time from oscillators, filtered noise, and
modulation.

Built for the car's browser: big touch targets, a live tachometer, and an
"RPM follows speed" mode that turns your silent EV into a V8, an inline-6, or
a spaceship — no hardware, no OBD dongle, no external speaker kit.

## ✨ Features

- **Real synthesis engine** (`src/audio/engine.ts`) — layered oscillator
  stacks, exhaust noise, firing-frequency amplitude modulation, idle lope,
  throttle-lift crackle, gear-shift blips, and a crank-then-catch start
  sequence. All parameters move through `setTargetAtTime` — no clicks or pops.
- **3 engine profiles** (`src/audio/profiles.ts`) — V8 Muscle, Inline-6 Sport,
  EV Spaceship Hum. Profiles are pure data, so adding a new engine is a new
  preset, not DSP surgery.
- **Two drive modes** — manual throttle slider, or *Follow speed* using the
  Geolocation API with a simulated 6-speed gearbox (auto up/downshifts with
  throttle-cut blips). Graceful fallback to manual if GPS is denied.
- **PWA** — installs to the home screen, works fully offline after first load
  (Workbox precaching), Screen Wake Lock while the engine runs.
- **Car-browser-first UI** — mobile-first dark automotive theme, 56px+ tap
  targets, live SVG tachometer with redline zone.
- **Dependency-light** — `vite`, `typescript`, `vite-plugin-pwa`. That's it.

## 🔊 How the synthesis works

RPM (60–7000) drives everything. For combustion profiles the fundamental is
the engine's **firing frequency** — `rpm / 60 × cylinders / 2` (a V8 at
750 rpm idle = 50 Hz; at 6200 rpm ≈ 413 Hz). That frequency is the single
"source of truth" for pitch, exhaust pulsing, and filter tracking.

Signal chain (built fresh per profile in `EngineSynth.buildGraph()`):

```
 ┌─ osc stack ──────────────────────────────┐
 │  N detuned saw oscillators at            │
 │  firingFreq × partial[0..n]              │   ← "cylinders"
 │  (detune spread = multi-cylinder chorus) │
 └──────────────┬───────────────────────────┘
                ▼
 ┌─ sub osc ────┴──── (sine, firingFreq / 2)┐  ← chest-thump body
 └──────────────┬───────────────────────────┘
                ▼
           lowpass filter                    ← cutoff tracks RPM + throttle
                │
                ▼
 ┌─────────────────────────────────┐
 │           engineBus (gain)      │◄── pulse osc @ firingFreq ──► AM depth
 │                                 │   ("chug": the exhaust pulse train)
 │                                 │◄── lope LFO (idle only)
 │                                 │   gain wobble + pitch wobble (detune)
 └──────────────┬──────────────────┘
                ▼
 ┌─ exhaust noise ─────────────────┐
 │  looping pink-noise buffer      │
 │   ├─► lowpass ──► exhaust gain  │  ← roar, tracks RPM
 │   └─► resonant bandpass ─► gain │  ← "bark"
 └──────────────┬──────────────────┘
                ▼
 ┌─ throttle-lift crackle ─────────┐
 │  scheduled noise bursts         │  ← random pops on lift-off
 │  (bandpass ~1.4–3 kHz)          │
 └──────────────┬──────────────────┘
                ▼
        compressor ──► master gain ──► destination

 EV profile instead: sine stack (90–650 Hz) + shimmer osc (×6.02, tremolo)
 + wind-like bandpassed noise. No pulse, no lope, no crackle.
```

Key techniques:

- **Exhaust "chug"** — a sine oscillator at the firing frequency modulates
  `engineBus.gain` (audio-rate AM). Depth scales with throttle. This is what
  makes it sound like an engine instead of a synth pad.
- **Idle lope** — a slow LFO (~3 Hz on the V8) wobbles gain *and* oscillator
  detune, fading out as RPM climbs. The lumpy-cam feel.
- **Crackle** — on a sharp throttle lift above 2200 rpm, 4–8 short bandpassed
  noise bursts are scheduled with exponential decay envelopes.
- **Crank → catch** — the start button plays a starter-motor whir (pitch-rising
  saw + the engine chugging at ~220 rpm), then the engine "catches" with an
  RPM flare that settles into idle.
- **Gear shifts** — in Follow-speed mode, `blip()` dips RPM and cuts throttle
  for ~200 ms at each shift, mimicking a real shift shock.
- **Click-free by construction** — a 50 ms control loop eases RPM/throttle
  toward targets at each profile's rev rate, and *every* AudioParam update
  goes through `setTargetAtTime`.

## 🚀 Run it

Requires Node 18+.

```bash
npm install
npm run dev      # local dev server
npm run build    # type-check + production build (regenerates PWA icons)
npm run preview  # serve the production build locally
```

The production build is a static `dist/` folder — host it anywhere
(GitHub Pages, Netlify, Vercel, a Raspberry Pi in the garage…).

## 🚗 Using it in a Tesla / EV browser

1. Open the hosted URL in the car's browser (Tesla's browser is
   Chromium-based, so Web Audio works).
2. Tap **Install** in the header (or use the browser's *Add to Home screen*)
   — after the first load the app works **fully offline**, so it survives
   parking garages and dead zones.
3. Tap **START ENGINE** — you'll hear the crank, then idle.
4. **Manual mode**: drag the throttle slider to rev.
5. **Follow speed**: grants the Geolocation permission and RPM follows the
   car's GPS speed through a simulated 6-speed gearbox, with shift blips.
   (The car must be moving — GPS speed is ~0 when parked, by design.)
6. Switch profiles anytime — the engine crossfades without clicks.

Tips: keep the tab in the foreground (background tabs may throttle audio);
the wake lock keeps the screen on while the engine runs.

## ⚠️ Safety note — read this

- **Cabin sound only.** This app plays through the car's own speakers for
  the people *inside* the car. It does not — and cannot — project engine
  sound outside the vehicle.
- **Parked, or passenger-operated.** Do not fiddle with the throttle slider,
  profiles, or any control while driving. Set it up before you roll, or hand
  it to a passenger.
- **Check local laws.** Some jurisdictions restrict modified vehicle sounds,
  in-cabin noise levels, or device interaction while driving. When in doubt,
  keep it parked.
- **Volume.** Synthesized low-frequency content can get loud fast — start at
  low volume and mind your ears (and your neighbors').

## 🗂 Project structure

```
ev-engine-sound/
├── index.html                  # app shell: tach SVG, controls, PWA meta
├── vite.config.ts              # Vite + vite-plugin-pwa (Workbox, manifest)
├── tsconfig.json               # strict TS
├── scripts/
│   └── generate-icons.mjs      # dependency-free PNG icon generator
│                               # (pure-JS rasterizer + PNG encoder)
├── public/icons/               # generated 192/512px PWA icons
└── src/
    ├── main.ts                 # UI wiring, tachometer, control loop,
    │                           # GPS gear simulation, install prompt
    ├── app.css                 # dark automotive theme, big touch targets
    ├── audio/
    │   ├── engine.ts           # EngineSynth: the synthesis engine
    │   ├── profiles.ts         # V8 / inline-6 / EV presets (data only)
    │   └── noise.ts            # loopable pink-noise buffer
    ├── sensors/
    │   └── speed.ts            # Geolocation speed tracker (EMA smoothed)
    └── pwa/
        └── wakelock.ts         # Screen Wake Lock helper
```

## 🔧 Adding a new engine profile

Everything audible is data in `src/audio/profiles.ts`. Copy an existing
preset and tune: `partials`/`partialGains` (harmonic recipe), `pulseDepth`
(exhaust chug), `lope` (idle character), `revRateUp`/`revRateDown` (how
eagerly it revs), and the exhaust filter specs. No DSP code changes needed.

## 📄 License

MIT — do whatever you want with it. If your EV now sounds like a big-block,
that's the point.
