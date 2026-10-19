// Screen Wake Lock: keeps the display (and therefore the audio) alive while
// the engine is running. Best-effort — unsupported browsers simply skip it.

interface WakeLockSentinelLike {
  addEventListener(type: string, listener: () => void): void;
  release(): Promise<void>;
}

interface NavigatorWithWakeLock {
  wakeLock?: {
    request(type: 'screen'): Promise<WakeLockSentinelLike>;
  };
}

let lock: WakeLockSentinelLike | null = null;
let wantLock = false;

async function acquire(): Promise<void> {
  if (!wantLock || lock) return;
  try {
    const nav = navigator as unknown as NavigatorWithWakeLock;
    if (!nav.wakeLock) return;
    lock = await nav.wakeLock.request('screen');
    lock.addEventListener('release', () => {
      lock = null;
    });
  } catch {
    lock = null; // denied or not allowed — audio continues regardless
  }
}

/** Turn the wake lock on/off. Call with true when the engine starts. */
export function setWakeLockActive(active: boolean): void {
  wantLock = active;
  if (active) {
    void acquire();
  } else if (lock) {
    lock.release().catch(() => undefined);
    lock = null;
  }
}

// The lock is dropped when the tab hides; re-acquire when visible again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void acquire();
});
