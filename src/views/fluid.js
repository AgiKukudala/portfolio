// Explainer for the site-wide background. Written for a general reader; the
// numbers behind it live in src/fx/water-gl.js and src/fx/water.js.

export const fluid = {
  render: () => `
    <section class="page-heading">
      <div class="eyebrow"><span class="dot"></span> INTERFACE ENGINEERING</div>
      <h1>Fluid Dynamics</h1>
      <p class="intro">
        The background is water. Move your cursor across it and it ripples, like dragging
        a finger through a still pool.
      </p>
    </section>

    <section class="model">
      <div class="model-head">
        <span class="eyebrow">HOW IT WORKS</span>
        <h2>Four steps</h2>
      </div>
      <div class="model-body">
        <ol class="fluid-steps">
          <li><b>The surface.</b> The page keeps an invisible grid of heights &mdash; how high or low the water sits at each point.</li>
          <li><b>You push it.</b> Your cursor dips the surface as it moves, harder when you move faster, and leaves a small wake behind it.</li>
          <li><b>It spreads.</b> Each dip pushes its neighbours, so ripples travel outward and fade as they go. They soak into the edges instead of bouncing back.</li>
          <li><b>It gets lit.</b> Wherever the surface tilts, light catches it &mdash; that's the shine and the bright ribbons you see.</li>
        </ol>
        <p class="fluid-cost">
          <b>Under the hood:</b> the whole thing is one physics equation for waves, redone
          about a hundred times a second on the graphics card. It idles when the water is
          still, turns off if you've asked your system to reduce motion, and falls back to a
          simpler version on older browsers.
        </p>
      </div>
    </section>

    <section class="model">
      <div class="model-head">
        <span class="eyebrow">MODEL</span>
        <h2>The mechanism</h2>
      </div>
      <div class="model-body">
        <div class="project-drawing fluid-flow">
          <span>Cursor</span><i>&#8594;</i><span>Dip</span><i>&#8594;</i><span>Ripples spread &#8635;</span><i>&#8594;</i><span>Light</span><i>&#8594;</i><span>Screen</span>
        </div>

        <svg class="fluid-diagram" viewBox="0 0 640 220" role="img"
             aria-label="Side view of the water: the cursor dips the surface, a wake lifts behind it, ripples spread out and shrink, and the edges soak them up.">
          <rect class="fd-sponge" x="0" y="40" width="70" height="150" />
          <rect class="fd-sponge" x="570" y="40" width="70" height="150" />
          <text class="fd-label" x="42" y="208" text-anchor="middle">soaked up</text>
          <text class="fd-label" x="598" y="208" text-anchor="middle">soaked up</text>

          <line class="fd-rest" x1="0" y1="110" x2="640" y2="110" />
          <path class="fd-wave" d="M0 110 L90 110
            C120 110 130 104 150 104 C170 104 180 117 200 117 C220 117 228 96 248 96
            C262 96 268 124 282 124 C294 124 298 84 308 84
            C316 84 318 160 330 160 C342 160 344 94 356 94
            C370 94 376 122 390 122 C406 122 412 100 430 100
            C448 100 458 114 478 114 C498 114 508 107 528 107 C546 107 556 110 570 110 L640 110" />

          <circle class="fd-pointer" cx="330" cy="30" r="7" />
          <line class="fd-arrow" x1="330" y1="40" x2="330" y2="146" marker-end="url(#fd-head)" />
          <line class="fd-arrow" x1="336" y1="30" x2="400" y2="30" marker-end="url(#fd-head)" />
          <text class="fd-label" x="408" y="34">you drag</text>
          <text class="fd-label fd-strong" x="342" y="178">dip</text>
          <text class="fd-label" x="300" y="74" text-anchor="middle">wake</text>
          <text class="fd-label" x="470" y="86" text-anchor="middle">ripples shrink</text>
          <text class="fd-label" x="160" y="140" text-anchor="middle">ripples shrink</text>

          <defs>
            <marker id="fd-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0 0 L10 5 L0 10 z" class="fd-head" />
            </marker>
          </defs>
        </svg>
      </div>
    </section>
  `,
};
