// Automatic life layer for avatars: randomized blinking plus an idle trigger
// that fires after a stretch without user activity. Pure module — no three.js,
// no DOM. Time comes from the injected clock and randomness from the injected
// rng, so behavior is fully deterministic in tests. All state lives inside the
// closure; update() returns a fresh lightweight state object every frame.

const BLINK_UP_MS = 120;
const BLINK_HOLD_MS = 60;
const BLINK_DOWN_MS = 140;
const BLINK_TOTAL_MS = BLINK_UP_MS + BLINK_HOLD_MS + BLINK_DOWN_MS;

export function createAutoMotion({ blink, idle, now = () => Date.now(), rng = Math.random, blinkGapMinMs = 2000, blinkGapMaxMs = 6000, idleAfterMs = 30000, notify = null } = {}) {
  const blinkEnabled = blink !== false;
  const idleEnabled = idle !== false;
  const emit = typeof notify === 'function' ? notify : null;
  const scheduleNextBlink = from => from + blinkGapMinMs + rng() * (blinkGapMaxMs - blinkGapMinMs);
  let nextBlinkAt = scheduleNextBlink(now());
  let blinkStart = null;
  let lastActivityAt = now();
  let idleActive = false;

  // Triangle ramp: 0 -> 1 over 120 ms, hold 1 for 60 ms, 1 -> 0 over 140 ms.
  const blinkWeight = elapsed => {
    if (elapsed < 0) return 0;
    if (elapsed < BLINK_UP_MS) return elapsed / BLINK_UP_MS;
    if (elapsed < BLINK_UP_MS + BLINK_HOLD_MS) return 1;
    if (elapsed < BLINK_TOTAL_MS) return (BLINK_TOTAL_MS - elapsed) / BLINK_DOWN_MS;
    return 0;
  };

  return {
    // Resets the inactivity timer — call on chat, gestures or clip plays.
    notifyActivity() { lastActivityAt = now(); },
    // Call once per frame; t defaults to the injected clock.
    update(t = now()) {
      let weight = 0;
      if (blinkEnabled) {
        if (t >= nextBlinkAt) {
          blinkStart = t;
          nextBlinkAt = scheduleNextBlink(t);
          if (emit) emit({ kind: 'blink' });
        }
        if (blinkStart !== null) weight = blinkWeight(t - blinkStart);
      }
      const active = idleEnabled && t - lastActivityAt >= idleAfterMs;
      if (active !== idleActive) {
        idleActive = active;
        if (emit) emit({ kind: active ? 'idleOn' : 'idleOff' });
      }
      return { blink: weight, idleActive: active };
    },
  };
}
