// Water-inspired pointer field for the Home background.
//
// Three models share one 2D context and one rAF loop:
//
//   1. Ripples  — expanding concentric rings whose amplitude follows a damped
//                 envelope. Emitted on click and when the pointer dwells.
//   2. Wake     — the disturbance a finger leaves dragging through water: a
//                 chain of critically damped springs, drawn not as one stroke
//                 but as several strands that fan outward and wobble apart
//                 toward the tail.
//   3. Wavelets — short transverse arcs shed along the path, bowing away from
//                 the direction of travel, which is what actually reads as
//                 displaced liquid rather than as a drawn line.
//
// The loop is demand-driven: it stops once every ripple and wavelet has decayed
// and the spring chain is at rest, and restarts on the next pointer event. That
// keeps an idle Home page at zero CPU.

const DPR_CAP = 2;
const MAX_DT = 1 / 30;          // clamp so a backgrounded tab cannot explode the integrator

// --- ripple model ---------------------------------------------------------
const RIPPLE_SPEED = 95;        // px/s, radius growth of the leading crest
// A ripple is retired by the distance its leading crest has covered from the
// point it started at, not by a clock. Kept short so a ring stays a local
// disturbance around the cursor and is gone before it can wash across the page.
const RIPPLE_TRAVEL = 120;      // px the leading crest reaches before it is gone
const RIPPLE_LIFE = RIPPLE_TRAVEL / RIPPLE_SPEED;   // s, derived hard cutoff
const RIPPLE_TAU = RIPPLE_LIFE * 0.42;              // s, exponential amplitude decay constant
const RIPPLE_WAVELENGTH = 38;   // px between trailing crests
const RIPPLE_CRESTS = 3;
const RIPPLE_CLICK = 0.52;      // peak strength of a click ripple
const RIPPLE_DWELL = 0.32;      // peak strength of a dwell ripple

// --- wake model -----------------------------------------------------------
const NODES = 16;               // spring chain length
const HEAD_STIFFNESS = 200;     // spring constant of node 0 toward the pointer
const TAIL_FALLOFF = 0.93;      // each node is slightly softer than the one ahead
const STRANDS = [-1.7, -0.85, 0, 0.85, 1.7];  // lateral offsets, in spread units
const WAKE_SPREAD = 11;         // px, lateral fan at the tail
const WAKE_MAX_ALPHA = 0.15;    // ceiling for the centre strand
const REST_SPEED = 4;           // px/s below which the chain counts as settled

// --- wavelet model --------------------------------------------------------
const WAVELET_GAP = 26;         // px of travel between shed wavelets
const WAVELET_LIFE = 0.9;       // s
const WAVELET_GROWTH = 52;      // px/s radial growth
const WAVELET_MIN_SPEED = 110;  // px/s before the pointer sheds anything
const WAVELET_ARC = 1.15;       // rad, half-width of each arc
const WAVELET_MAX = 26;

// --- dwell ----------------------------------------------------------------
const DWELL_MS = 520;           // pointer stationary this long emits a ripple
const DWELL_RADIUS = 3;         // px of movement still considered "stationary"
const DWELL_COOLDOWN_MS = 1400;
const DWELL_BURST = 3;          // ripples per pause, so a resting pointer settles

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ surface?: EventTarget }} [options]
 *   surface - where pointer events are read from. Defaults to the canvas. A
 *   full-page background passes `document`, because that canvas sets
 *   `pointer-events: none` so links and buttons above it stay clickable, and
 *   therefore never receives pointer events of its own.
 * @returns {{ destroy(): void }}
 */
export function createWaterCanvas(canvas, { surface = canvas } = {}) {
  const ctx = canvas.getContext('2d', { alpha: true });
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const style = getComputedStyle(canvas);
  const accent = style.getPropertyValue('--fx-accent').trim() || '90, 134, 173';
  const ice = style.getPropertyValue('--fx-ice').trim() || '138, 178, 209';

  let width = 0;
  let height = 0;
  let running = false;
  let frame = 0;
  let last = 0;
  let elapsed = 0;   // seconds since mount, drives the strand wobble

  const ripples = [];
  const wavelets = [];
  const nodes = Array.from({ length: NODES }, () => ({ x: 0, y: 0, vx: 0, vy: 0 }));

  const pointer = { x: 0, y: 0, active: false, seeded: false };
  let shedFrom = { x: 0, y: 0 };
  let dwellAt = 0;
  let dwellOrigin = { x: 0, y: 0 };
  let lastDwellRipple = 0;
  let dwellCount = 0;

  // -- sizing --------------------------------------------------------------

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (!pointer.seeded) seedAtRest();
    clear();
    if (!reduceMotion.matches) request();
  }

  /** Park the chain at the centre so the first pointer move eases in. */
  function seedAtRest() {
    pointer.x = width / 2;
    pointer.y = height / 2;
    for (const node of nodes) {
      node.x = pointer.x;
      node.y = pointer.y;
      node.vx = 0;
      node.vy = 0;
    }
    shedFrom = { x: pointer.x, y: pointer.y };
    pointer.seeded = true;
  }

  // -- loop control --------------------------------------------------------

  function request() {
    if (running || reduceMotion.matches || document.hidden) return;
    running = true;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }

  function settled() {
    if (ripples.length || wavelets.length) return false;
    if (pointer.active) return false;
    return nodes.every((n) => Math.hypot(n.vx, n.vy) < REST_SPEED);
  }

  function tick(now) {
    const dt = Math.min((now - last) / 1000, MAX_DT);
    last = now;
    elapsed += dt;

    age(ripples, dt, RIPPLE_LIFE);
    age(wavelets, dt, WAVELET_LIFE);
    stepChain(dt);
    checkDwell(now);
    draw();

    if (settled()) {
      running = false;
      clear();   // at rest the surface is empty; then stop scheduling frames
      return;
    }
    frame = requestAnimationFrame(tick);
  }

  function age(list, dt, life) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      list[i].age += dt;
      if (list[i].age > life) list.splice(i, 1);
    }
  }

  // -- simulation ----------------------------------------------------------

  /**
   * Semi-implicit Euler on a chain of critically damped springs.
   * Damping c = 2*sqrt(k) gives the fastest approach with no overshoot, which
   * reads as liquid drag rather than a bouncing tail.
   */
  function stepChain(dt) {
    let stiffness = HEAD_STIFFNESS;

    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      const targetX = i === 0 ? pointer.x : nodes[i - 1].x;
      const targetY = i === 0 ? pointer.y : nodes[i - 1].y;
      const damping = 2 * Math.sqrt(stiffness);

      node.vx += (stiffness * (targetX - node.x) - damping * node.vx) * dt;
      node.vy += (stiffness * (targetY - node.y) - damping * node.vy) * dt;
      node.x += node.vx * dt;
      node.y += node.vy * dt;

      stiffness *= TAIL_FALLOFF;
    }
  }

  function checkDwell(now) {
    if (!pointer.active) return;
    if (dwellCount >= DWELL_BURST) return;
    if (now - dwellAt < DWELL_MS) return;
    if (now - lastDwellRipple < DWELL_COOLDOWN_MS) return;
    if (Math.hypot(pointer.x - dwellOrigin.x, pointer.y - dwellOrigin.y) > DWELL_RADIUS) return;

    emitRipple(pointer.x, pointer.y, RIPPLE_DWELL);
    lastDwellRipple = now;
    dwellCount += 1;
  }

  function emitRipple(x, y, strength) {
    if (reduceMotion.matches) return;
    if (ripples.length > 7) ripples.shift();
    ripples.push({ x, y, age: 0, strength });
    request();
  }

  /**
   * Shed a transverse wavelet once the pointer has travelled far enough and is
   * moving fast enough for the surface to actually break.
   */
  function shedWavelets(x, y, speed) {
    const dx = x - shedFrom.x;
    const dy = y - shedFrom.y;
    const travelled = Math.hypot(dx, dy);
    if (travelled < WAVELET_GAP || speed < WAVELET_MIN_SPEED) return;

    if (wavelets.length >= WAVELET_MAX) wavelets.shift();
    wavelets.push({
      x: shedFrom.x,
      y: shedFrom.y,
      heading: Math.atan2(dy, dx),
      strength: Math.min(1, speed / 900),
      age: 0,
    });
    shedFrom = { x, y };
  }

  // -- rendering -----------------------------------------------------------

  const clear = () => ctx.clearRect(0, 0, width, height);

  function draw() {
    clear();
    drawRipples();
    drawWavelets();
    drawWake();
  }

  function drawRipples() {
    ctx.lineCap = 'round';

    for (const ripple of ripples) {
      const lead = ripple.age * RIPPLE_SPEED;
      // Damped envelope: exponential decay, faded out linearly over the tail
      // of the lifetime so a ring never disappears mid-stroke.
      const envelope =
        ripple.strength *
        Math.exp(-ripple.age / RIPPLE_TAU) *
        Math.max(0, 1 - ripple.age / RIPPLE_LIFE);
      if (envelope < 0.004) continue;

      for (let crest = 0; crest < RIPPLE_CRESTS; crest += 1) {
        const radius = lead - crest * RIPPLE_WAVELENGTH;
        if (radius <= 1) continue;

        ctx.beginPath();
        ctx.arc(ripple.x, ripple.y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${accent}, ${envelope * (1 - crest * 0.28)})`;
        ctx.lineWidth = 1.25 - crest * 0.3;
        ctx.stroke();
      }
    }
  }

  /**
   * Each wavelet is an arc bowing away from the direction the pointer was
   * travelling, expanding and flattening as it dies — the little curved ridges
   * that trail a finger pulled across water.
   */
  function drawWavelets() {
    ctx.lineCap = 'round';

    for (const wavelet of wavelets) {
      const t = wavelet.age / WAVELET_LIFE;
      const alpha = wavelet.strength * 0.16 * (1 - t) ** 1.5;
      if (alpha < 0.004) continue;

      const radius = 5 + wavelet.age * WAVELET_GROWTH;
      const back = wavelet.heading + Math.PI;
      const arc = WAVELET_ARC * (1 - t * 0.45);   // narrows as it spreads

      ctx.beginPath();
      ctx.arc(wavelet.x, wavelet.y, radius, back - arc, back + arc);
      ctx.strokeStyle = `rgba(${ice}, ${alpha})`;
      ctx.lineWidth = 1.4 * (1 - t) + 0.3;
      ctx.stroke();
    }
  }

  /**
   * The wake. Instead of one stroked polyline, several strands are offset
   * along the local normal by an amount that grows toward the tail and wobbles
   * with time, so the disturbance fans out and never resolves into a line.
   */
  function drawWake() {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const headSpeed = Math.hypot(nodes[0].vx, nodes[0].vy);
    if (headSpeed < REST_SPEED) return;

    // Local frame per node: position plus the unit normal to its travel.
    const frames = nodes.map((node, i) => {
      const speed = Math.hypot(node.vx, node.vy);
      let dx = node.vx;
      let dy = node.vy;
      if (speed < 1) {
        // Nearly stopped: fall back to the chain's own direction.
        const prev = nodes[i - 1] || node;
        const next = nodes[i + 1] || node;
        dx = next.x - prev.x;
        dy = next.y - prev.y;
      }
      const len = Math.hypot(dx, dy) || 1;
      return { x: node.x, y: node.y, nx: -dy / len, ny: dx / len, speed };
    });

    const widen = 0.55 + Math.min(headSpeed / 800, 0.95);

    for (let s = 0; s < STRANDS.length; s += 1) {
      const lane = STRANDS[s];

      const points = frames.map((f, i) => {
        const along = i / frames.length;
        // Fan: nothing at the head, widening toward the tail, plus a slow
        // wobble per lane so the strands drift apart instead of staying parallel.
        const wobble = 0.78 + 0.22 * Math.sin(i * 0.55 + elapsed * 1.7 + s * 1.3);
        const offset = lane * WAKE_SPREAD * along ** 0.8 * widen * wobble;
        return { x: f.x + f.nx * offset, y: f.y + f.ny * offset, speed: f.speed };
      });

      // Centre strand is strongest; outer lanes are progressively fainter.
      const laneFade = 1 - (Math.abs(lane) / 1.7) * 0.6;

      for (let i = 1; i < points.length - 1; i += 1) {
        const prev = points[i - 1];
        const a = points[i];
        const b = points[i + 1];
        if (a.speed < REST_SPEED) continue;

        const taper = 1 - i / points.length;
        const alpha = Math.min(WAKE_MAX_ALPHA, a.speed / 3200) * taper * laneFade;
        if (alpha < 0.003) continue;

        // Midpoint-to-midpoint with the node as control point, so consecutive
        // segments share endpoints and the strand is gap-free.
        ctx.beginPath();
        ctx.moveTo((prev.x + a.x) / 2, (prev.y + a.y) / 2);
        ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
        ctx.strokeStyle = `rgba(${ice}, ${alpha})`;
        ctx.lineWidth = (0.5 + Math.min(a.speed / 420, 1.9)) * taper * laneFade;
        ctx.stroke();
      }
    }
  }

  // -- input ---------------------------------------------------------------

  function toLocal(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function onPointerMove(event) {
    const { x, y } = toLocal(event);
    if (!pointer.active) {
      // Entering: place the chain at the pointer so it does not whip across
      // the canvas from wherever it was parked.
      for (const node of nodes) {
        node.x = x;
        node.y = y;
        node.vx = 0;
        node.vy = 0;
      }
      shedFrom = { x, y };
    }

    const moved = Math.hypot(x - pointer.x, y - pointer.y);
    pointer.x = x;
    pointer.y = y;
    pointer.active = true;

    // movementX/Y is unreliable across browsers here, so speed comes from the
    // head spring, which is already tracking the pointer.
    shedWavelets(x, y, Math.max(Math.hypot(nodes[0].vx, nodes[0].vy), moved * 60));

    if (Math.hypot(x - dwellOrigin.x, y - dwellOrigin.y) > DWELL_RADIUS) {
      dwellOrigin = { x, y };
      dwellAt = performance.now();
      dwellCount = 0;   // a new pause gets a fresh burst
    }
    request();
  }

  function onPointerLeave() {
    pointer.active = false;
    request();
  }

  function onPointerDown(event) {
    const { x, y } = toLocal(event);
    emitRipple(x, y, RIPPLE_CLICK);
  }

  function onVisibility() {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      running = false;
    } else {
      request();
    }
  }

  function onMotionPreferenceChange() {
    cancelAnimationFrame(frame);
    running = false;
    clear();
    if (!reduceMotion.matches) request();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  surface.addEventListener('pointermove', onPointerMove, { passive: true });
  surface.addEventListener('pointerleave', onPointerLeave, { passive: true });
  surface.addEventListener('pointerdown', onPointerDown, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  reduceMotion.addEventListener('change', onMotionPreferenceChange);
  resize();

  return {
    destroy() {
      cancelAnimationFrame(frame);
      running = false;
      observer.disconnect();
      surface.removeEventListener('pointermove', onPointerMove);
      surface.removeEventListener('pointerleave', onPointerLeave);
      surface.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('visibilitychange', onVisibility);
      reduceMotion.removeEventListener('change', onMotionPreferenceChange);
    },
  };
}
