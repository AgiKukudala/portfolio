// GPU water surface: a damped 2D wave equation solved on a texture, shaded
// with normals derived from the resulting heightfield.
//
// Physics
// -------
// The surface is a heightfield h(x, y, t) obeying the wave equation with a
// linear damping term:
//
//     d2h/dt2 = c^2 * laplacian(h) - k * dh/dt
//
// Discretised explicitly, using the previous two states (stored in the red and
// green channels of one texture, ping-ponged between two framebuffers):
//
//     h_next = (2h - h_prev + C^2 * laplacian(h)) * damping
//
// C = c*dt/dx is the Courant number. The 2D stability limit is C <= 1/sqrt(2)
// ~= 0.707; SIM_C stays well under it, and the timestep is fixed regardless of
// frame rate, so the integrator cannot be destabilised by a slow frame.
//
// Dragging presses the surface down along the segment between the previous and
// current pointer position (not just at a point, so fast movement leaves no
// gaps), with a weaker lift behind it that becomes the wake.
//
// Shading
// -------
// Normals come from the height gradient. Specular highlights use Blinn-Phong
// against a fixed light. Caustics are taken from the Laplacian of the height,
// which is what actually focuses light through a wavy surface, and are sampled
// through a normal-based offset for refraction. Output is premultiplied alpha
// and near-zero where the surface is flat, so the page shows through untouched
// until something disturbs it.

const SIM_C = 0.42;             // Courant number, stability limit is ~0.707
// Damping sets how far a wave can travel before it is gone: a crest moving at
// C cells per step loses amplitude as damping^(distance/C). Solving that for a
// target travel distance keeps ripples the same size relative to the screen on
// every device, instead of covering a phone while staying local on a desktop.
//
//     damping = exp(C * ln(residual) / (travel * longEdge))
//
const TARGET_TRAVEL = 0.1;       // fraction of the grid's long edge a ripple reaches
const TARGET_RESIDUAL = 0.05;   // amplitude left at that distance
const SIM_STEP = 1 / 120;       // fixed integrator step, seconds
const MAX_SUBSTEPS = 3;
// Absorbing boundary (a sponge layer). Wide and ramped, because an abrupt
// absorber reflects almost as much as a hard wall does.
const EDGE_FADE = 0.16;         // fraction of the grid used as the sponge
const EDGE_ABSORB = 0.9;        // step multiplier at the outermost cell
// Amplitude below this is faded to nothing, so spent ripples clear the screen
// instead of lingering as a haze.
const DEAD_LOW = 0.00022;
const DEAD_HIGH = 0.00085;

const DRAG_RADIUS = 3.0;        // grid cells
const DRAG_STRENGTH = 0.011;
const CLICK_RADIUS = 4.2;
const CLICK_STRENGTH = 0.075;
const WAKE_OFFSET = 4.0;        // cells behind the drag, where the lift sits
const WAKE_RATIO = 0.45;        // lift strength relative to the press

const SETTLE_SECONDS = 4;       // quiet time before the surface is let go
const FADE_SECONDS = 0.8;

// Grid tiers. Simulation cost is independent of display resolution.
const GRID_HIGH = 256;
const GRID_MID = 176;
const GRID_LOW = 112;
const SLOW_FRAME_MS = 22;       // sustained frame cost that triggers a downgrade
const SLOW_FRAME_RUN = 40;
const FAST_FRAME_MS = 12;
const FAST_FRAME_RUN = 240;
// Shading cost scales with canvas pixels, not with grid size, so the first
// thing to give up under load is render resolution. Water is soft-edged, so
// upscaling a smaller buffer is close to free visually.
const RENDER_SCALES = [1.5, 1.15, 0.85, 0.6, 0.45];

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const SIM_FS = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_state;
uniform vec2 u_texel;
uniform vec2 u_grid;
uniform float u_c2;
uniform float u_damping;
uniform vec2 u_from;
uniform vec2 u_to;
uniform float u_radius;
uniform float u_strength;
uniform float u_wakeStrength;
uniform vec2 u_wakeDir;

// Distance from p to the segment ab, all in grid-cell space so the footprint
// stays circular regardless of the grid's aspect ratio.
float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * t);
}

void main() {
  vec2 s = texture2D(u_state, v_uv).rg;
  float h = s.r;
  float hPrev = s.g;

  float l = texture2D(u_state, v_uv - vec2(u_texel.x, 0.0)).r;
  float r = texture2D(u_state, v_uv + vec2(u_texel.x, 0.0)).r;
  float d = texture2D(u_state, v_uv - vec2(0.0, u_texel.y)).r;
  float u = texture2D(u_state, v_uv + vec2(0.0, u_texel.y)).r;

  float lap = l + r + u + d - 4.0 * h;
  float next = (2.0 * h - hPrev + u_c2 * lap) * u_damping;

  if (u_strength > 0.0) {
    vec2 p = v_uv * u_grid;
    float dist = segDist(p, u_from * u_grid, u_to * u_grid);
    next -= u_strength * exp(-(dist * dist) / (u_radius * u_radius));

    if (u_wakeStrength > 0.0) {
      vec2 tail = u_to * u_grid - u_wakeDir * ${WAKE_OFFSET.toFixed(1)};
      float dw = length(p - tail);
      float rw = u_radius * 1.6;
      next += u_wakeStrength * exp(-(dw * dw) / (rw * rw));
    }
  }

  // Sponge layer: ramp from full absorption at the border to none inside, so
  // waves are swallowed before they can reflect off the viewport edges.
  vec2 e = min(v_uv, 1.0 - v_uv) / ${EDGE_FADE.toFixed(3)};
  float edge = clamp(min(e.x, e.y), 0.0, 1.0);
  next *= mix(${EDGE_ABSORB.toFixed(3)}, 1.0, edge * edge);

  // Fade out amplitudes too small to see rather than letting them accumulate.
  next *= smoothstep(${DEAD_LOW.toFixed(5)}, ${DEAD_HIGH.toFixed(5)}, abs(next));

  gl_FragColor = vec4(next, h, 0.0, 1.0);
}`;

const DRAW_FS = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_state;
uniform vec2 u_texel;
uniform vec3 u_deep;
uniform vec3 u_spec;
uniform float u_opacity;

void main() {
  float hl = texture2D(u_state, v_uv - vec2(u_texel.x, 0.0)).r;
  float hr = texture2D(u_state, v_uv + vec2(u_texel.x, 0.0)).r;
  float hd = texture2D(u_state, v_uv - vec2(0.0, u_texel.y)).r;
  float hu = texture2D(u_state, v_uv + vec2(0.0, u_texel.y)).r;
  float h  = texture2D(u_state, v_uv).r;

  // Surface normal from the height gradient.
  vec3 n = normalize(vec3(-(hr - hl) * 26.0, -(hu - hd) * 26.0, 1.0));
  float slopeMag = length(n.xy);

  vec3 light = normalize(vec3(-0.38, 0.55, 0.74));
  vec3 view = vec3(0.0, 0.0, 1.0);
  vec3 halfv = normalize(light + view);
  float spec = pow(max(dot(n, halfv), 0.0), 55.0);

  // Grazing angles catch more light, which reads as the rim of a crest.
  float fresnel = pow(1.0 - max(dot(n, view), 0.0), 4.0);

  // Caustics: light focuses where the surface curves, so the Laplacian already
  // computed for the normal is the caustic term - no extra samples needed.
  float lap = hl + hr + hu + hd - 4.0 * h;
  // Refraction: one sample displaced along the surface normal, which deepens
  // the tint where the surface bends light away from the viewer.
  float refracted = texture2D(u_state, v_uv + n.xy * 0.035).r;
  float presence = smoothstep(0.004, 0.022, abs(h) + slopeMag * 0.05);
  float caustic = max(-lap * 16.0, 0.0) * (1.0 + abs(refracted) * 1.6) * presence;

  float body = clamp(abs(h) * 1.6 + slopeMag * 0.45, 0.0, 1.0);

  vec3 color = u_deep * (0.42 + caustic * 0.7)
             + u_spec * (spec * 1.3 + fresnel * 0.3 + caustic * 0.45);

  // Kept deliberately low: this sits behind body text, so the surface should
  // read as a disturbance in the light, never as a layer over the page.
  float alpha = clamp(body * 0.12 + spec * 0.42 + caustic * 0.13, 0.0, 1.0) * u_opacity;
  gl_FragColor = vec4(color * alpha, alpha);
}`;

/** @returns {{ destroy(): void } | null} null when WebGL cannot support it. */
export function createGLWater(canvas, { surface = canvas } = {}) {
  const gl =
    canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
  if (!gl) return null;

  // Rendering to a float texture is the hard requirement; without it the wave
  // equation cannot hold sub-step precision and the caller falls back.
  const floatLinear = gl.getExtension('EXT_color_buffer_float');
  const halfLinear = gl.getExtension('EXT_color_buffer_half_float');
  if (!floatLinear && !halfLinear) return null;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const style = getComputedStyle(canvas);
  const deep = rgbTriple(style.getPropertyValue('--fx-accent'), [0.18, 0.43, 0.61]);
  const spec = rgbTriple(style.getPropertyValue('--fx-ice'), [0.54, 0.70, 0.82]);

  let grid = pickGrid();
  let scaleStep = pickScaleStep();
  let gridW = grid;
  let gridH = grid;
  let damping = 0.988;
  let width = 0;
  let height = 0;

  let running = false;
  let frame = 0;
  let last = 0;
  let accumulator = 0;
  let quietFor = 0;
  let opacity = 1;
  let slowFrames = 0;
  let fastFrames = 0;
  let lost = false;
  let screenProbe = null;   // dev diagnostic, resolved inside render()

  // Pointer state, in uv space.
  const from = { x: 0.5, y: 0.5 };
  const to = { x: 0.5, y: 0.5 };
  let splat = null;
  let hasPointer = false;

  const simProgram = buildProgram(gl, VERT, SIM_FS);
  const drawProgram = buildProgram(gl, VERT, DRAW_FS);
  if (!simProgram || !drawProgram) return null;

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  let targets = null;
  let read = 0;

  function allocTargets() {
    if (targets) for (const t of targets) { gl.deleteTexture(t.texture); gl.deleteFramebuffer(t.fbo); }
    targets = [createTarget(), createTarget()];
    read = 0;
  }

  function createTarget() {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const internal = floatLinear ? gl.RGBA16F : gl.RGBA16F;
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, gridW, gridH, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw Error('water: float framebuffer incomplete (0x' + status.toString(16) + ')');
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { texture, fbo };
  }

  function pickGrid() {
    const memory = navigator.deviceMemory || 4;
    const cores = navigator.hardwareConcurrency || 4;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    if (memory <= 2 || cores <= 2) return GRID_LOW;
    if (coarse || memory <= 4 || cores <= 4) return GRID_MID;
    return GRID_HIGH;
  }

  function pickScaleStep() {
    const dpr = window.devicePixelRatio || 1;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    // Start one rung down on phones and on low-DPR displays where the extra
    // resolution buys nothing.
    if (coarse) return 2;
    return dpr >= 2 ? 0 : 1;
  }

  /** Step quality back up after a sustained run of comfortably fast frames. */
  function upgrade() {
    if (scaleStep === 0) return false;
    scaleStep -= 1;
    resize();
    return true;
  }

  /** Give up render resolution first, then simulation grid. */
  function downgrade() {
    if (scaleStep < RENDER_SCALES.length - 1) {
      scaleStep += 1;
      resize();
      return true;
    }
    const next = grid === GRID_HIGH ? GRID_MID : grid === GRID_MID ? GRID_LOW : null;
    if (!next) return false;
    grid = next;
    sizeGrid();
    allocTargets();
    return true;
  }

  function sizeGrid() {
    const aspect = height > 0 ? height / width : 1;
    // Keep cells square so the Laplacian stays isotropic and ripples stay round.
    if (aspect <= 1) {
      gridW = grid;
      gridH = Math.max(48, Math.round(grid * aspect));
    } else {
      gridH = grid;
      gridW = Math.max(48, Math.round(grid / aspect));
    }
    const travel = TARGET_TRAVEL * Math.max(gridW, gridH);
    damping = Math.exp((SIM_C * Math.log(TARGET_RESIDUAL)) / travel);
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const scale = Math.min(window.devicePixelRatio || 1, RENDER_SCALES[scaleStep]);
    width = rect.width;
    height = rect.height;
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    sizeGrid();
    allocTargets();
    if (!reduceMotion.matches) request();
  }

  // -- loop ----------------------------------------------------------------

  function request() {
    if (running || lost || reduceMotion.matches || document.hidden) return;
    running = true;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }

  function wake() {
    quietFor = 0;
    opacity = 1;
    request();
  }

  function tick(now) {
    const dt = Math.min((now - last) / 1000, 1 / 20);
    const frameMs = now - last;
    last = now;

    if (frameMs > SLOW_FRAME_MS) {
      slowFrames += 1;
      fastFrames = 0;
      if (slowFrames > SLOW_FRAME_RUN) { slowFrames = 0; downgrade(); }
    } else {
      if (slowFrames > 0) slowFrames -= 1;
      if (frameMs < FAST_FRAME_MS) {
        fastFrames += 1;
        if (fastFrames > FAST_FRAME_RUN) { fastFrames = 0; upgrade(); }
      } else {
        fastFrames = 0;
      }
    }

    accumulator += dt;
    let steps = 0;
    while (accumulator >= SIM_STEP && steps < MAX_SUBSTEPS) {
      simulate();
      accumulator -= SIM_STEP;
      steps += 1;
    }
    if (steps === MAX_SUBSTEPS) accumulator = 0;   // shed backlog rather than spiral

    render();

    quietFor += dt;
    if (quietFor > SETTLE_SECONDS) {
      opacity = Math.max(0, 1 - (quietFor - SETTLE_SECONDS) / FADE_SECONDS);
      if (opacity <= 0) {
        running = false;
        clearScreen();
        return;
      }
    }
    frame = requestAnimationFrame(tick);
  }

  function simulate() {
    const src = targets[read];
    const dst = targets[1 - read];

    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, gridW, gridH);
    gl.useProgram(simProgram.program);
    bindQuad(simProgram);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(simProgram.u.u_state, 0);
    gl.uniform2f(simProgram.u.u_texel, 1 / gridW, 1 / gridH);
    gl.uniform2f(simProgram.u.u_grid, gridW, gridH);
    gl.uniform1f(simProgram.u.u_c2, SIM_C * SIM_C);
    gl.uniform1f(simProgram.u.u_damping, damping);

    if (splat) {
      gl.uniform2f(simProgram.u.u_from, splat.from.x, splat.from.y);
      gl.uniform2f(simProgram.u.u_to, splat.to.x, splat.to.y);
      gl.uniform1f(simProgram.u.u_radius, splat.radius);
      gl.uniform1f(simProgram.u.u_strength, splat.strength);
      gl.uniform1f(simProgram.u.u_wakeStrength, splat.wake);
      gl.uniform2f(simProgram.u.u_wakeDir, splat.dir.x, splat.dir.y);
      splat = null;
    } else {
      gl.uniform1f(simProgram.u.u_strength, 0);
      gl.uniform1f(simProgram.u.u_wakeStrength, 0);
    }

    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    read = 1 - read;
  }

  function render() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // premultiplied

    gl.useProgram(drawProgram.program);
    bindQuad(drawProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targets[read].texture);
    gl.uniform1i(drawProgram.u.u_state, 0);
    gl.uniform2f(drawProgram.u.u_texel, 1 / gridW, 1 / gridH);
    gl.uniform3f(drawProgram.u.u_deep, deep[0], deep[1], deep[2]);
    gl.uniform3f(drawProgram.u.u_spec, spec[0], spec[1], spec[2]);
    gl.uniform1f(drawProgram.u.u_opacity, opacity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (screenProbe) {
      const w = canvas.width;
      const h = canvas.height;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let peak = 0;
      let nonZero = 0;
      for (let i = 3; i < px.length; i += 4) {
        if (px[i] > 0) nonZero += 1;
        if (px[i] > peak) peak = px[i];
      }
      const resolve = screenProbe;
      screenProbe = null;
      resolve({ peakAlpha: peak, nonZero, sampled: w * h, glError: gl.getError(), opacity });
    }
  }

  function clearScreen() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  function bindQuad(program) {
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(program.a_pos);
    gl.vertexAttribPointer(program.a_pos, 2, gl.FLOAT, false, 0, 0);
  }

  // -- input ---------------------------------------------------------------

  function toUV(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / rect.width,
      // uv origin is bottom-left in GL, screen origin is top-left
      y: 1 - (clientY - rect.top) / rect.height,
    };
  }

  function drag(clientX, clientY) {
    const p = toUV(clientX, clientY);
    if (!hasPointer) { from.x = p.x; from.y = p.y; hasPointer = true; }
    else { from.x = to.x; from.y = to.y; }
    to.x = p.x;
    to.y = p.y;

    const dx = (to.x - from.x) * gridW;
    const dy = (to.y - from.y) * gridH;
    const travel = Math.hypot(dx, dy);
    if (travel < 0.02) return;

    const speed = Math.min(travel / 6, 1.6);
    splat = {
      from: { x: from.x, y: from.y },
      to: { x: to.x, y: to.y },
      radius: DRAG_RADIUS,
      strength: DRAG_STRENGTH * (0.45 + speed),
      wake: DRAG_STRENGTH * WAKE_RATIO * speed,
      dir: { x: dx / travel, y: dy / travel },
    };
    wake();
  }

  function press(clientX, clientY) {
    const p = toUV(clientX, clientY);
    splat = {
      from: p,
      to: p,
      radius: CLICK_RADIUS,
      strength: CLICK_STRENGTH,
      wake: 0,
      dir: { x: 0, y: 0 },
    };
    wake();
  }

  const onPointerMove = (e) => drag(e.clientX, e.clientY);
  const onPointerDown = (e) => press(e.clientX, e.clientY);
  const onPointerLeave = () => { hasPointer = false; };

  const onTouchMove = (e) => {
    const t = e.touches[0];
    if (t) drag(t.clientX, t.clientY);
  };
  const onTouchStart = (e) => {
    const t = e.touches[0];
    if (t) { hasPointer = false; press(t.clientX, t.clientY); }
  };
  const onTouchEnd = () => { hasPointer = false; };

  // Pointer events already cover touch. Attaching touchmove as well on a
  // pointer-capable browser would inject every gesture twice, so the touch
  // listeners are the fallback path, not an addition.
  const usePointer = 'PointerEvent' in window;
  if (usePointer) {
    surface.addEventListener('pointermove', onPointerMove, { passive: true });
    surface.addEventListener('pointerdown', onPointerDown, { passive: true });
    surface.addEventListener('pointerleave', onPointerLeave, { passive: true });
  } else {
    surface.addEventListener('mousemove', onPointerMove, { passive: true });
    surface.addEventListener('mousedown', onPointerDown, { passive: true });
    surface.addEventListener('touchstart', onTouchStart, { passive: true });
    surface.addEventListener('touchmove', onTouchMove, { passive: true });
    surface.addEventListener('touchend', onTouchEnd, { passive: true });
  }

  function onVisibility() {
    if (document.hidden) { cancelAnimationFrame(frame); running = false; }
    else request();
  }
  function onMotionChange() {
    cancelAnimationFrame(frame);
    running = false;
    clearScreen();
    if (!reduceMotion.matches) request();
  }
  function onContextLost(event) {
    event.preventDefault();
    lost = true;
    cancelAnimationFrame(frame);
    running = false;
  }

  canvas.addEventListener('webglcontextlost', onContextLost);
  document.addEventListener('visibilitychange', onVisibility);
  reduceMotion.addEventListener('change', onMotionChange);

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  return {
    backend: 'webgl',
    get grid() { return `${gridW}x${gridH}`; },
    get renderScale() { return RENDER_SCALES[scaleStep]; },
    /** Reads the default framebuffer inside the draw call. Diagnostics only. */
    probeRender() {
      return new Promise((resolve) => { screenProbe = resolve; wake(); });
    },
    /**
     * Bounding box of the disturbed region and the peak amplitude in the
     * outermost ring of cells. Diagnostics only: used to confirm waves die
     * before reaching the viewport edge instead of reflecting off it.
     */
    extent(threshold = 0.002) {
      const pixels = new Float32Array(gridW * gridH * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets[read].fbo);
      gl.readPixels(0, 0, gridW, gridH, gl.RGBA, gl.FLOAT, pixels);
      let minX = gridW;
      let maxX = -1;
      let minY = gridH;
      let maxY = -1;
      let border = 0;
      for (let y = 0; y < gridH; y += 1) {
        for (let x = 0; x < gridW; x += 1) {
          const v = Math.abs(pixels[(y * gridW + x) * 4]);
          if (x === 0 || y === 0 || x === gridW - 1 || y === gridH - 1) {
            if (v > border) border = v;
          }
          if (v > threshold) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      const long = Math.max(gridW, gridH);
      return {
        grid: `${gridW}x${gridH}`,
        box: maxX < 0 ? null : `${maxX - minX + 1}x${maxY - minY + 1}`,
        spanPctLong: maxX < 0 ? 0 : +((Math.max(maxX - minX, maxY - minY) / long) * 100).toFixed(1),
        borderPeak: +border.toFixed(5),
      };
    },
    /** Peak |height| in the live simulation texture. For diagnostics only. */
    probe() {
      const pixels = new Float32Array(gridW * gridH * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets[read].fbo);
      gl.readPixels(0, 0, gridW, gridH, gl.RGBA, gl.FLOAT, pixels);
      const err = gl.getError();
      let peak = 0;
      let nonZero = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const v = Math.abs(pixels[i]);
        if (v > 1e-6) nonZero += 1;
        if (v > peak) peak = v;
      }
      return {
        grid: `${gridW}x${gridH}`,
        damping: +damping.toFixed(5),
        scale: RENDER_SCALES[scaleStep],
        buffer: `${canvas.width}x${canvas.height}`,
        running,
        peak: +peak.toFixed(5),
        nonZero,
        glError: err,
      };
    },
    destroy() {
      cancelAnimationFrame(frame);
      running = false;
      observer.disconnect();
      if (usePointer) {
        surface.removeEventListener('pointermove', onPointerMove);
        surface.removeEventListener('pointerdown', onPointerDown);
        surface.removeEventListener('pointerleave', onPointerLeave);
      } else {
        surface.removeEventListener('mousemove', onPointerMove);
        surface.removeEventListener('mousedown', onPointerDown);
        surface.removeEventListener('touchstart', onTouchStart);
        surface.removeEventListener('touchmove', onTouchMove);
        surface.removeEventListener('touchend', onTouchEnd);
      }
      canvas.removeEventListener('webglcontextlost', onContextLost);
      document.removeEventListener('visibilitychange', onVisibility);
      reduceMotion.removeEventListener('change', onMotionChange);
      if (targets) for (const t of targets) { gl.deleteTexture(t.texture); gl.deleteFramebuffer(t.fbo); }
      gl.deleteBuffer(quad);
      gl.deleteProgram(simProgram.program);
      gl.deleteProgram(drawProgram.program);
    },
  };
}

// -- helpers ----------------------------------------------------------------

function rgbTriple(value, fallback) {
  const parts = value.split(',').map((n) => parseFloat(n.trim()));
  if (parts.length !== 3 || parts.some(Number.isNaN)) return fallback;
  return parts.map((n) => n / 255);
}

function buildProgram(gl, vertSource, fragSource) {
  const vert = compile(gl, gl.VERTEX_SHADER, '#version 100\n' + vertSource);
  const frag = compile(gl, gl.FRAGMENT_SHADER, '#version 100\n' + fragSource);
  if (!vert || !frag) return null;

  const program = gl.createProgram();
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('water program link:', gl.getProgramInfoLog(program));
    return null;
  }

  const u = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i += 1) {
    const name = gl.getActiveUniform(program, i).name;
    u[name] = gl.getUniformLocation(program, name);
  }
  return { program, u, a_pos: gl.getAttribLocation(program, 'a_pos') };
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('water shader:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}
