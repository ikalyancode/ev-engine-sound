// Vehicle speed via the Geolocation API, smoothed with an EMA.
// Graceful degradation: if GPS is unavailable/denied, onSpeed is never fired
// with live data and the caller falls back to manual throttle mode.

export interface SpeedReading {
  mph: number;
  kmh: number;
  live: boolean;
}

const MS_TO_MPH = 2.23694;
const MS_TO_KMH = 3.6;

export class SpeedTracker {
  private watchId = -1;
  private emaMs = 0;
  private hasFix = false;
  private enabled = false;

  onSpeed: ((s: SpeedReading) => void) | null = null;

  /** Resolves true once the first GPS fix arrives, false on denial/timeout. */
  async enable(): Promise<boolean> {
    if (this.enabled) return this.hasFix;
    if (!('geolocation' in navigator)) return false;
    this.enabled = true;

    return new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      // Give the GPS a few seconds; some browsers take a while on first fix.
      const timeoutId = window.setTimeout(() => {
        if (!this.hasFix) {
          this.disable();
          done(false);
        }
      }, 9000);

      this.watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const raw = pos.coords.speed;
          // coords.speed can be null (notably on some desktop browsers);
          // without it we can't do speed-follow — report unavailable.
          if (raw === null || raw === undefined) {
            window.clearTimeout(timeoutId);
            this.disable();
            done(false);
            return;
          }
          this.hasFix = true;
          this.emaMs = this.emaMs === 0 ? raw : this.emaMs * 0.65 + raw * 0.35;
          // Snap tiny jitter to zero so "parked" reads parked.
          const ms = this.emaMs < 0.25 ? 0 : this.emaMs;
          this.onSpeed?.({ mph: ms * MS_TO_MPH, kmh: ms * MS_TO_KMH, live: true });
          window.clearTimeout(timeoutId);
          done(true);
        },
        () => {
          window.clearTimeout(timeoutId);
          this.disable();
          done(false);
        },
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 12000 },
      );
    });
  }

  disable(): void {
    this.enabled = false;
    this.hasFix = false;
    this.emaMs = 0;
    if (this.watchId >= 0) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = -1;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}
