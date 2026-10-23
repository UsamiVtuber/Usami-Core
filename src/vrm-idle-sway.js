// Subtle idle sway for VRM avatars: a slow breathing sine plus two
// desynchronized lateral sway sines, all normalized (breath in 0..1, swayX
// and swayZ in -1..1) so the integrator can scale them to radians and apply
// them to the spine/chest/neck bones through vrm.humanoid. Pure module — no
// three.js, no DOM, no on/off state: the caller decides frame by frame
// whether to apply the result (zero branching inside). Every value is a pure
// function of the time passed to update(), anchored at t0 captured once from
// the injected clock at creation, so behavior is fully deterministic in tests.

const TAU = Math.PI * 2;
// swayZ runs 17% slower than swayX so the two axes never lock in phase.
const SWAY_Z_HZ_RATIO = 0.83;

export function createVrmIdleSway({ now = () => Date.now(), breathHz = 0.25, swayHz = 0.11, breathAmp = 1, swayAmp = 1 } = {}) {
  const t0 = now();
  // Radians per millisecond for each oscillator.
  const breathPhase = TAU * breathHz / 1000;
  const swayXPhase = TAU * swayHz / 1000;
  const swayZPhase = TAU * SWAY_Z_HZ_RATIO * swayHz / 1000;

  return {
    // Call once per frame; t defaults to the injected clock.
    update(t = now()) {
      const dt = t - t0;
      return {
        breath: ((Math.sin(breathPhase * dt) + 1) / 2) * breathAmp,
        swayX: Math.sin(swayXPhase * dt) * swayAmp,
        swayZ: Math.sin(swayZPhase * dt) * swayAmp,
      };
    },
  };
}
