// Explainer for the site-wide background. Every constant quoted here is the one the
// simulation actually uses; see src/fx/water-gl.js and src/fx/water.js.

export const fluid = {
  render: () => `
    <section class="page-heading">
      <div class="eyebrow"><span class="dot"></span> INTERFACE ENGINEERING</div>
      <h1>Fluid Dynamics</h1>
      <p class="intro">
        The background is a real fluid simulation: a damped wave equation solved on the GPU
        every frame, then lit from the surface it produces.
      </p>
    </section>

    <section class="model">
      <div class="model-head">
        <span class="eyebrow">HOW IT WORKS</span>
        <h2>Five steps</h2>
      </div>
      <div class="model-body">
        <pre class="formula">&part;&sup2;h/&part;t&sup2; = c&sup2;&nabla;&sup2;h &minus; k&middot;&part;h/&part;t</pre>
        <ol class="fluid-steps">
          <li><b>Surface.</b> A height grid in a float texture. Each step computes the new height from the last two: <code>2h&#8345; &minus; h&#8345;&#8331;&#8321; + C&sup2;&nabla;&sup2;h</code>.</li>
          <li><b>Stability.</b> Courant number C = 0.42, under the 2D limit of 0.707. Fixed 1/120&nbsp;s step, up to 3 substeps per frame.</li>
          <li><b>Input.</b> The pointer presses a Gaussian dent along its path, deeper when faster. A weaker lift behind it forms the wake.</li>
          <li><b>Decay.</b> Damping is set so a ripple keeps 5% amplitude at 10% of the screen. A sponge border absorbs the rest, so nothing reflects.</li>
          <li><b>Light.</b> Slope gives the normal, which drives specular and Fresnel. Curvature (&nabla;&sup2;h, already computed) gives caustics for free.</li>
        </ol>
        <p class="fluid-cost">
          <b>Cost:</b> 256-cell grid, adaptive resolution, loop stops when the surface is still.
          Honors reduced motion. Canvas 2D fallback without WebGL2.
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
          <span>Pointer</span><i>&#8594;</i><span>Dent h</span><i>&#8594;</i><span>Wave step &#8635;</span><i>&#8594;</i><span>Shade</span><i>&#8594;</i><span>Screen</span>
        </div>

        <svg class="fluid-diagram" viewBox="0 0 640 220" role="img"
             aria-label="Cross-section of the surface: the pointer dents it, a wake lifts behind, ripples spread and shrink, and the sponge border absorbs them.">
          <rect class="fd-sponge" x="0" y="40" width="70" height="150" />
          <rect class="fd-sponge" x="570" y="40" width="70" height="150" />
          <text class="fd-label" x="35" y="208" text-anchor="middle">sponge</text>
          <text class="fd-label" x="605" y="208" text-anchor="middle">sponge</text>

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
          <text class="fd-label" x="408" y="34">drag</text>
          <text class="fd-label fd-strong" x="342" y="178">dent</text>
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
