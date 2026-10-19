// EV Engine Sound — UI wiring: tachometer, controls, GPS speed-follow mode,
// profile switching, PWA install prompt, and the per-frame control loop.
import './app.css';
import { EngineSynth, type EngineState } from './audio/engine';
import { PROFILES, getProfile, type EngineProfile } from './audio/profiles';
import { SpeedTracker } from './sensors/speed';
import { setWakeLockActive } from './pwa/wakelock';
import { registerSW } from 'virtual:pwa-register';

registerSW({ immediate: true });

// ------------------------------------------------------------------ helpers
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}

let toastTimer = 0;
function toast(msg: string): void {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2600);
}

/** Paint the filled portion of a range input (webkit track gradient). */
function paintRange(el: HTMLInputElement): void {
  const pct = ((Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min))) * 100;
  el.style.setProperty('--fill', `${pct}%`);
}

// ------------------------------------------------------------------ state
let profile: EngineProfile = getProfile('v8');
const engine = new EngineSynth(profile);
const speedTracker = new SpeedTracker();

type Mode = 'manual' | 'speed';
let mode: Mode = 'manual';
let sliderThrottle = 0.3;
let latestMph = 0;
let gear = 1;

const GEAR_RATIOS = [3.4, 2.2, 1.5, 1.08, 0.82, 0.64];
const MPH_RPM_K = 55; // rpm = mph * 55 * gearRatio (believable gearing)
let lastMph = 0;
let lastT = 0;

// ------------------------------------------------------------------ tachometer
const TACH_MAX = 7000;
const CX = 120;
const CY = 120;
const R = 96;

function angleFor(rpm: number): number {
  return 135 + (clamp(rpm, 0, TACH_MAX) / TACH_MAX) * 270;
}
function polar(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}
function arcPath(r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 1 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

function buildTach(): void {
  const svgNS = 'http://www.w3.org/2000/svg';
  $('tachBase').setAttribute('d', arcPath(R, 135, 405));
  const ticks = $('ticks');
  for (let rpm = 0; rpm <= TACH_MAX; rpm += 250) {
    const major = rpm % 1000 === 0;
    const a = angleFor(rpm);
    const [x0, y0] = polar(R - (major ? 16 : 9), a);
    const [x1, y1] = polar(R - 2, a);
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', x0.toFixed(1));
    line.setAttribute('y1', y0.toFixed(1));
    line.setAttribute('x2', x1.toFixed(1));
    line.setAttribute('y2', y1.toFixed(1));
    line.setAttribute('class', major ? 'tick major' : 'tick');
    ticks.appendChild(line);
    if (major) {
      const [tx, ty] = polar(R - 30, a);
      const text = document.createElementNS(svgNS, 'text');
      text.setAttribute('x', tx.toFixed(1));
      text.setAttribute('y', ty.toFixed(1));
      text.setAttribute('class', 'tick-label');
      text.textContent = String(rpm / 1000);
      ticks.appendChild(text);
    }
  }
  updateRedlineArc();
}

function updateRedlineArc(): void {
  $('redlineArc').setAttribute('d', arcPath(R, angleFor(profile.redlineRpm), 405));
}

function updateGauge(rpm: number): void {
  const deg = -135 + (clamp(rpm, 0, TACH_MAX) / TACH_MAX) * 270;
  $('needleG').setAttribute('transform', `rotate(${deg.toFixed(1)} ${CX} ${CY})`);
  $('rpmDigital').textContent = String(Math.round(rpm / 10) * 10);
  $('tachWrap').classList.toggle('redline', rpm > profile.redlineRpm);
}

// ------------------------------------------------------------------ controls
function speedTargets(mph: number): { rpm: number; throttle: number } {
  const now = performance.now();
  const dt = Math.max(0.05, (now - lastT) / 1000);
  const accelMphS = (mph - lastMph) / dt; // positive = accelerating
  lastMph = mph;
  lastT = now;
  const throttle = clamp(0.25 + accelMphS * 0.3, 0.12, 1);

  if (mph < 2.5) {
    gear = 1;
    return { rpm: profile.idleRpm + throttle * 250, throttle };
  }
  const rpmInGear = (g: number) => mph * MPH_RPM_K * GEAR_RATIOS[g - 1];
  if (rpmInGear(gear) > 5400 && gear < GEAR_RATIOS.length) {
    gear++;
    engine.blip(rpmInGear(gear), 200); // upshift: rpm drops, throttle cuts
  } else if (rpmInGear(gear) < 1500 && gear > 1) {
    gear--;
    engine.blip(rpmInGear(gear), 220); // downshift blip
  }
  const rpm = clamp(rpmInGear(gear), profile.idleRpm, profile.redlineRpm);
  return { rpm, throttle };
}

function frame(): void {
  requestAnimationFrame(frame);
  if (engine.getState() === 'running') {
    if (mode === 'manual') {
      const thr = sliderThrottle;
      const rpm =
        profile.idleRpm + Math.pow(thr, 1.15) * (profile.redlineRpm - profile.idleRpm);
      engine.setTarget(rpm, 0.12 + thr * 0.88);
    } else {
      const { rpm, throttle } = speedTargets(latestMph);
      engine.setTarget(rpm, throttle);
    }
  }
  const rpm = engine.getRpm();
  updateGauge(rpm);
  $('speedVal').textContent = mode === 'speed' ? latestMph.toFixed(0) : '—';
  $('gearVal').textContent = mode === 'speed' ? String(gear) : '—';
}

function setStartUi(state: EngineState): void {
  const btn = $('startBtn') as HTMLButtonElement;
  const led = $('statusDot');
  const label = $('statusText');
  btn.classList.remove('is-running', 'is-busy');
  if (state === 'off') {
    btn.disabled = false;
    $('startBtnLabel').textContent = 'START ENGINE';
    led.className = 'dot';
    label.textContent = 'Engine off';
  } else if (state === 'cranking') {
    btn.disabled = true;
    btn.classList.add('is-busy');
    $('startBtnLabel').textContent = 'CRANKING…';
    led.className = 'dot crank';
    label.textContent = 'Cranking…';
  } else if (state === 'running') {
    btn.disabled = false;
    btn.classList.add('is-running');
    $('startBtnLabel').textContent = 'STOP ENGINE';
    led.className = 'dot on';
    label.textContent = `${profile.name} · running`;
  } else {
    btn.disabled = true;
    btn.classList.add('is-busy');
    $('startBtnLabel').textContent = 'STOPPING…';
    led.className = 'dot crank';
    label.textContent = 'Shutting down…';
  }
}

async function onStartStop(): Promise<void> {
  const st = engine.getState();
  if (st === 'off') {
    try {
      await engine.start();
      setWakeLockActive(true);
      toast(`${profile.name} started`);
    } catch (err) {
      console.error(err);
      toast('Audio failed to start — try tapping again');
    }
  } else if (st === 'running') {
    engine.stop();
    setWakeLockActive(false);
  }
}

function renderProfiles(): void {
  const wrap = $('profiles');
  wrap.innerHTML = '';
  for (const p of PROFILES) {
    const b = document.createElement('button');
    b.className = 'profile' + (p.id === profile.id ? ' active' : '');
    b.style.setProperty('--accent', p.accent);
    b.innerHTML = `<span class="p-name">${p.name}</span><span class="p-tag">${p.tagline}</span>`;
    b.addEventListener('click', () => {
      if (p.id === profile.id) return;
      profile = p;
      void engine.switchProfile(p);
      document.documentElement.style.setProperty('--accent', p.accent);
      updateRedlineArc();
      renderProfiles();
      setStartUi(engine.getState());
      toast(`${p.name} selected`);
    });
    wrap.appendChild(b);
  }
}

async function setMode(next: Mode): Promise<void> {
  if (next === mode) return;
  if (next === 'speed') {
    toast('Waiting for GPS fix…');
    const ok = await speedTracker.enable();
    if (!ok) {
      toast('GPS speed unavailable — staying in manual mode');
      return;
    }
    mode = 'speed';
    gear = 1;
    lastMph = 0;
    lastT = performance.now();
    toast('RPM now follows vehicle speed');
  } else {
    speedTracker.disable();
    mode = 'manual';
    toast('Manual throttle mode');
  }
  $('modeManual').classList.toggle('active', mode === 'manual');
  $('modeSpeed').classList.toggle('active', mode === 'speed');
  $('throttleWrap').classList.toggle('disabled', mode === 'speed');
}

// ------------------------------------------------------------------ boot
function init(): void {
  buildTach();
  renderProfiles();
  document.documentElement.style.setProperty('--accent', profile.accent);

  ($('startBtn') as HTMLButtonElement).addEventListener('click', () => void onStartStop());
  engine.onStateChange = (s) => setStartUi(s);
  setStartUi('off');

  const throttle = $('throttle') as HTMLInputElement;
  throttle.addEventListener('input', () => {
    sliderThrottle = Number(throttle.value) / 100;
    $('throttleVal').textContent = `${throttle.value}%`;
    paintRange(throttle);
  });
  paintRange(throttle);

  const volume = $('volume') as HTMLInputElement;
  volume.addEventListener('input', () => {
    engine.setVolume(Number(volume.value) / 100);
    $('volumeVal').textContent = `${volume.value}%`;
    paintRange(volume);
  });
  paintRange(volume);
  engine.setVolume(Number(volume.value) / 100);

  ($('crackleToggle') as HTMLInputElement).addEventListener('change', (e) => {
    engine.setCrackleEnabled((e.target as HTMLInputElement).checked);
  });

  $('modeManual').addEventListener('click', () => void setMode('manual'));
  $('modeSpeed').addEventListener('click', () => void setMode('speed'));

  speedTracker.onSpeed = (s) => {
    latestMph = s.mph;
  };

  // PWA install prompt
  let deferredPrompt: {
    prompt(): Promise<void>;
    userChoice: Promise<{ outcome: string }>;
  } | null = null;
  const installBtn = $('installBtn') as HTMLButtonElement;
  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault();
    deferredPrompt = e as unknown as typeof deferredPrompt;
    installBtn.hidden = false;
  });
  installBtn.addEventListener('click', () => {
    if (!deferredPrompt) return;
    void deferredPrompt.prompt().then(() => {
      deferredPrompt = null;
      installBtn.hidden = true;
    });
  });
  window.addEventListener('appinstalled', () => {
    installBtn.hidden = true;
    toast('Installed — find it on your home screen');
  });

  requestAnimationFrame(frame);
}

document.addEventListener('DOMContentLoaded', init);
