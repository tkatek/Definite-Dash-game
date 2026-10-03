/* ========================================================================== 
 * Definite Dash — fox run-cycle specification
 * --------------------------------------------------------------------------
 * This module is deliberately DOM-free. The browser controller consumes the
 * phase data, while tests can lock the gait order, timing, and shadow logic
 * without importing the game UI.
 * ========================================================================== */

export const RUN_FRAME_MS = Object.freeze({
  fastest: 75,
  normal: 88,
  slowest: 95,
});

/**
 * The approved rear-view gait. Runtime WebPs are deterministic, translated
 * copies of the PNG masters: one scale, one 1254px square canvas, one body
 * centre. The tiny vertical trajectory is baked into those normalized files.
 */
export const RUN_PHASES = Object.freeze([
  Object.freeze({
    id: 'right-push-off',
    label: 'Right-leg push-off',
    src: 'assets/characters/runtime/fox-run-01.webp',
    fallbackSrc: 'assets/characters/fox-run-01.png',
    shadowScale: 0.98,
    shadowOpacity: 0.39,
    shadowBlurPx: 1.1,
  }),
  Object.freeze({
    id: 'right-air',
    label: 'Right-side airborne',
    src: 'assets/characters/runtime/fox-run-02.webp',
    fallbackSrc: 'assets/characters/fox-run-02.png',
    shadowScale: 0.84,
    shadowOpacity: 0.24,
    shadowBlurPx: 1.8,
  }),
  Object.freeze({
    id: 'left-landing',
    label: 'Left-foot landing',
    src: 'assets/characters/runtime/fox-run-03.webp',
    fallbackSrc: 'assets/characters/fox-run-03.png',
    shadowScale: 1.03,
    shadowOpacity: 0.44,
    shadowBlurPx: 0.8,
  }),
  Object.freeze({
    id: 'left-compression',
    label: 'Left-side compression',
    src: 'assets/characters/runtime/fox-run-04.webp',
    fallbackSrc: 'assets/characters/fox-run-04.png',
    shadowScale: 1.08,
    shadowOpacity: 0.49,
    shadowBlurPx: 0.5,
  }),
  Object.freeze({
    id: 'left-push-off',
    label: 'Left-leg push-off',
    src: 'assets/characters/runtime/fox-run-05.webp',
    fallbackSrc: 'assets/characters/fox-run-05.png',
    shadowScale: 0.98,
    shadowOpacity: 0.39,
    shadowBlurPx: 1.1,
  }),
  Object.freeze({
    id: 'left-air',
    label: 'Left-side airborne',
    src: 'assets/characters/runtime/fox-run-06.webp',
    fallbackSrc: 'assets/characters/fox-run-06.png',
    shadowScale: 0.84,
    shadowOpacity: 0.24,
    shadowBlurPx: 1.8,
  }),
  Object.freeze({
    id: 'right-landing',
    label: 'Right-foot landing',
    src: 'assets/characters/runtime/fox-run-07.webp',
    fallbackSrc: 'assets/characters/fox-run-07.png',
    shadowScale: 1.03,
    shadowOpacity: 0.44,
    shadowBlurPx: 0.8,
  }),
  Object.freeze({
    id: 'right-compression',
    label: 'Right-side compression',
    src: 'assets/characters/runtime/fox-run-08.webp',
    fallbackSrc: 'assets/characters/fox-run-08.png',
    shadowScale: 1.08,
    shadowOpacity: 0.49,
    shadowBlurPx: 0.5,
  }),
]);

/** Compression is a planted, readable pose for reduced motion/terminal UI. */
export const STABLE_RUN_FRAME_INDEX = 3;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Gently follows world speed without tying the cadence 1:1 to gameplay.
 * The returned value is always within the approved 75–95ms range.
 */
export function runFrameDurationForSpeed(
  worldSpeed,
  speedMin,
  speedMax,
) {
  if (![worldSpeed, speedMin, speedMax].every(Number.isFinite) || speedMax <= speedMin) {
    return RUN_FRAME_MS.normal;
  }
  const t = clamp((worldSpeed - speedMin) / (speedMax - speedMin), 0, 1);
  return RUN_FRAME_MS.slowest - t * (RUN_FRAME_MS.slowest - RUN_FRAME_MS.fastest);
}

/**
 * Advance an accumulated frame clock. Large deltas are clamped so returning
 * from a background tab never fast-forwards through the gait.
 */
export function advanceRunClock(
  { index, accumulator },
  deltaMs,
  frameDurationMs,
  frameCount = RUN_PHASES.length,
) {
  if (!Number.isInteger(frameCount) || frameCount < 1) {
    throw new RangeError('frameCount must be a positive integer');
  }
  const duration = Math.max(1, Number(frameDurationMs) || RUN_FRAME_MS.normal);
  const safeDelta = clamp(Number(deltaMs) || 0, 0, 250);
  const total = Math.max(0, Number(accumulator) || 0) + safeDelta;
  const steps = Math.floor(total / duration);
  return {
    index: ((Number(index) || 0) + steps) % frameCount,
    accumulator: total - steps * duration,
  };
}

