import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  RUN_FRAME_MS,
  RUN_PHASES,
  STABLE_RUN_FRAME_INDEX,
  advanceRunClock,
  feedbackRunRateForWorldRate,
  runFrameDurationForSpeed,
} from '../js/player-animation.js';

const EXPECTED_PHASES = [
  'right-push-off',
  'right-air',
  'left-landing',
  'left-compression',
  'left-push-off',
  'left-air',
  'right-landing',
  'right-compression',
];

function uint24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

test('run manifest locks the approved eight-phase gait and unique files', () => {
  assert.deepEqual(RUN_PHASES.map((frame) => frame.id), EXPECTED_PHASES);
  assert.equal(new Set(RUN_PHASES.map((frame) => frame.src)).size, 8);
  assert.equal(new Set(RUN_PHASES.map((frame) => frame.fallbackSrc)).size, 8);
});

test('every runtime WebP and PNG fallback exists at the locked 1254px canvas', async () => {
  for (const frame of RUN_PHASES) {
    const webp = await readFile(new URL(`../${frame.src}`, import.meta.url));
    assert.equal(webp.subarray(0, 4).toString('ascii'), 'RIFF', frame.src);
    assert.equal(webp.subarray(8, 12).toString('ascii'), 'WEBP', frame.src);
    assert.equal(webp.subarray(12, 16).toString('ascii'), 'VP8X', frame.src);
    assert.equal(uint24LE(webp, 24) + 1, 1254, `${frame.src} width`);
    assert.equal(uint24LE(webp, 27) + 1, 1254, `${frame.src} height`);

    const png = await readFile(new URL(`../${frame.fallbackSrc}`, import.meta.url));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], frame.fallbackSrc);
    assert.equal(png.readUInt32BE(16), 1254, `${frame.fallbackSrc} width`);
    assert.equal(png.readUInt32BE(20), 1254, `${frame.fallbackSrc} height`);
  }
});

test('normal cadence stays within the 600–760ms acceptance range', () => {
  assert.ok(RUN_FRAME_MS.normal >= 75 && RUN_FRAME_MS.normal <= 95);
  assert.equal(RUN_FRAME_MS.normal * RUN_PHASES.length, 704);
});

test('speed mapping is gently clamped to 95ms slow and 75ms fast', () => {
  assert.equal(runFrameDurationForSpeed(0.44, 0.44, 0.62), 95);
  assert.equal(runFrameDurationForSpeed(0.62, 0.44, 0.62), 75);
  assert.equal(runFrameDurationForSpeed(-10, 0.44, 0.62), 95);
  assert.equal(runFrameDurationForSpeed(10, 0.44, 0.62), 75);
  assert.equal(runFrameDurationForSpeed(NaN, 0.44, 0.62), 88);
});

test('feedback always slows the gait instead of accelerating it', () => {
  assert.equal(feedbackRunRateForWorldRate(1), 0.58);
  assert.ok(Math.abs(feedbackRunRateForWorldRate(0) - 0.325) < 1e-12);
  assert.ok(feedbackRunRateForWorldRate(0.4) < 1);
});

test('accumulated delta advances multiple frames and wraps 8 → 1 seamlessly', () => {
  assert.deepEqual(
    advanceRunClock({ index: 7, accumulator: 80 }, 16, 88, 8),
    { index: 0, accumulator: 8 },
  );
  assert.deepEqual(
    advanceRunClock({ index: 0, accumulator: 0 }, 184, 88, 8),
    { index: 2, accumulator: 8 },
  );
});

test('airborne shadows are lighter/smaller than landing and compression shadows', () => {
  for (const airIndex of [1, 5]) {
    for (const groundedIndex of [2, 3, 6, 7]) {
      assert.ok(RUN_PHASES[airIndex].shadowScale < RUN_PHASES[groundedIndex].shadowScale);
      assert.ok(RUN_PHASES[airIndex].shadowOpacity < RUN_PHASES[groundedIndex].shadowOpacity);
    }
  }
});

test('the reduced-motion pose is a stable compression frame', () => {
  assert.match(RUN_PHASES[STABLE_RUN_FRAME_INDEX].id, /compression$/);
});

