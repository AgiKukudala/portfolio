// Picks the best available water backend.
//
// The GPU heightfield simulation needs WebGL2 with float render targets. Where
// that is missing (older iOS Safari, software renderers, blocked WebGL) the
// Canvas 2D wake falls in behind it: visually simpler, but the same pointer
// behaviour and the same teardown contract.

import { createGLWater } from './water-gl.js';
import { createWaterCanvas } from './water.js';

export function createWater(canvas, options = {}) {
  try {
    const gpu = createGLWater(canvas, options);
    if (gpu) return gpu;
  } catch (error) {
    console.warn('WebGL water unavailable, falling back to canvas:', error.message);
  }
  return { backend: 'canvas2d', ...createWaterCanvas(canvas, options) };
}
