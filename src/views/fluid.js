// Explainer for the site-wide background. Every constant quoted here is the one the
// simulation actually uses; see src/fx/water-gl.js and src/fx/water.js.

export const fluid = {
  render: () => `
    <section class="page-heading">
      <div class="eyebrow"><span class="dot"></span> INTERFACE ENGINEERING</div>
      <h1>Fluid Dynamics</h1>
      <p class="intro">
        The background behind every page is a real fluid simulation: a wave equation solved on
        the GPU every frame, shaded from the surface it produces. Here is the physics,
        the shading, and what it costs.
      </p>
    </section>

    <section class="spec-grid">
      <div class="spec">
        <span class="eyebrow">RENDERER</span>
        <h3>WebGL2</h3>
        <p>
          The surface lives in a floating-point texture, ping-ponged between two
          framebuffers &mdash; one pass to advance the physics, one to shade it. The canvas
          is fixed behind the whole page and set <code>pointer-events: none</code>, so it
          reads the pointer from the document and every link above it stays clickable.
        </p>
      </div>
      <div class="spec">
        <span class="eyebrow">PHYSICS</span>
        <h3>Damped wave equation</h3>
        <p>
          A heightfield, not a particle trail. Ripples interfere, reflect off each other
          and decay because the equation says so, not because a timer tells them to.
        </p>
      </div>
      <div class="spec">
        <span class="eyebrow">COST</span>
        <h3>60 FPS, then idle</h3>
        <p>
          Fixed timestep, resolution that adapts to the device, and a loop that releases
          entirely once the surface is still. A quiet page runs no frames at all.
        </p>
      </div>
    </section>

    <section class="model">
      <div class="model-head">
        <span class="eyebrow">MODEL 01</span>
        <h2>The surface</h2>
        <p>
          Height obeys the wave equation with a linear damping term &mdash; the same
          equation as a drum head, with friction added so it settles.
        </p>
      </div>
      <div class="model-body">
        <pre class="formula">&part;&sup2;h/&part;t&sup2; = c&sup2;&nabla;&sup2;h &minus; k&middot;&part;h/&part;t</pre>
        <p>
          Discretised explicitly using the previous two states, which are stored in the
          red and green channels of one texture. Each step writes the new height to red
          and demotes the old one to green:
        </p>
        <pre class="formula">h&#8345;&#8330;&#8321; = (2h&#8345; &minus; h&#8345;&#8331;&#8321; + C&sup2;&middot;&nabla;&sup2;h&#8345;) &middot; damping

&nabla;&sup2;h = h&#8343;&#8331;&#8321;,&#8342; + h&#8343;&#8330;&#8321;,&#8342; + h&#8343;,&#8342;&#8331;&#8321; + h&#8343;,&#8342;&#8330;&#8321; &minus; 4h&#8343;,&#8342;
C = 0.42        (Courant number)
step = 1/120 s, at most 3 substeps per frame
damping = exp(C &middot; ln(0.05) / (0.1 &middot; longEdge))</pre>
        <p>
          <b>C is the whole stability story.</b> The Courant number <code>c&middot;&Delta;t/&Delta;x</code>
          must stay under 1/&radic;2 &asymp; 0.707 in two dimensions or the explicit scheme
          diverges &mdash; the surface detonates rather than settles. 0.42 leaves real margin.
          The timestep is fixed and decoupled from the frame rate, so a slow frame is
          absorbed by running extra substeps (capped at three, after which the backlog is
          dropped rather than allowed to spiral) instead of by taking a larger, unstable
          step.
        </p>
        <p>
          The grid keeps square cells regardless of the window's aspect ratio, so the
          Laplacian stays isotropic and ripples stay circular instead of elliptical.
        </p>
        <p>
          <b>Damping is what bounds how far a wave can travel.</b> A crest moving at C
          cells per step loses amplitude as <code>damping^(distance/C)</code>, so the
          damping constant is solved backwards from the distance a ripple should reach:
          10% of the grid's long edge, with 5% of its amplitude left at that point. That
          distance is deliberately short: a ripple is meant to read as a local
          disturbance under the cursor, so it expires close to where it started rather
          than travelling on and washing back and forth across the page.
        </p>
        <p>
          Deriving it rather than fixing it keeps ripples the same size relative to the
          screen on every device. A fixed constant tuned on a desktop grid leaves a phone
          &mdash; whose grid is a third the size &mdash; with waves washing across the whole
          display. Measured: a click spreads to 17% of the long edge, peaks at 0.6&nbsp;s and has cleared
          by 1.2&nbsp;s &mdash; identically at 1440&times;900, 1920&times;1080 and on a
          390&times;844 phone. A drag is gone 1.1&nbsp;s after the pointer stops.
        </p>
        <p>
          The remaining energy is swallowed by an absorbing boundary &mdash; a sponge layer
          over the outer 16% of the grid, ramped quadratically from a 0.9 multiplier at
          the outermost cell to none inside. The ramp matters: an abrupt absorber
          reflects nearly as much as a hard wall, which is what produces waves bouncing
          around the viewport. Measured peak amplitude in the border cells is <b>0</b>.
        </p>
        <p>
          Finally, amplitudes below roughly 0.0008 are faded out, so spent ripples clear
          the screen instead of lingering as a haze. That threshold sits far below
          anything visible on purpose &mdash; set near the visible range it slices smooth
          gradients into fragments, and the caustic term, being a second derivative,
          turns those fragments into speckle.
        </p>
      </div>
    </section>

    <section class="model">
      <div class="model-head">
        <span class="eyebrow">MODEL 02</span>
        <h2>Disturbing it</h2>
        <p>
          Dragging presses the surface down along the whole segment the pointer covered,
          not at a point, so a fast flick leaves a continuous furrow rather than beads.
        </p>
      </div>
      <div class="model-body">
        <p>
          The simulation shader measures distance to that segment in grid-cell space and
          subtracts a Gaussian:
        </p>
        <pre class="formula">d = distance(cell, segment(previous &rarr; current))
h &minus;= strength &middot; e<sup>&minus;d&sup2;/r&sup2;</sup>

drag   r = 3.0 cells, strength 0.011 &times; (0.45 + speed)
click  r = 4.2 cells, strength 0.075</pre>
        <p>
          A second, weaker Gaussian of opposite sign sits 4.0 cells behind the drag at 45%
          of its strength. That lift behind the press is the wake: the surface piles up
          where the finger has just left, and the wave equation carries the turbulence
          outward from there on its own.
        </p>
        <p>
          Strength scales with pointer speed, so a slow drag barely dents the surface and
          a quick sweep throws a visible bow wave. Nothing about the ripples is animated
          directly &mdash; releasing the pointer stops the forcing term, and everything
          already in the field keeps expanding and decaying under the equation.
        </p>
      </div>
    </section>

    <section class="model">
      <div class="model-head">
        <span class="eyebrow">MODEL 03</span>
        <h2>Lighting it</h2>
        <p>
          The shading pass never sees the pointer. It only sees a heightfield, and
          derives everything from the shape of that surface.
        </p>
      </div>
      <div class="model-body">
        <pre class="formula">n = normalize(&minus;&part;h/&part;x &middot; 26, &minus;&part;h/&part;y &middot; 26, 1)
spec = max(n &middot; halfway(light, view), 0)<sup>55</sup>
fresnel = (1 &minus; n &middot; view)<sup>4</sup>
caustic = max(&minus;&nabla;&sup2;h &middot; 16, 0)</pre>
        <p>
          Specular highlights are Blinn-Phong against a fixed light, so they sit on the
          crests and slide as the crests move. The Fresnel term brightens grazing angles,
          which is what puts a rim on the edge of a swell.
        </p>
        <p>
          <b>The caustics are the Laplacian.</b> Light focuses where the surface curves,
          and curvature is exactly the second derivative the physics pass already needs
          &mdash; so the bright filaments come free from a value that was computed anyway,
          with no extra texture samples. It is gated on local amplitude: in near-flat
          water a second derivative measures discretisation noise, not real curvature.
        </p>
        <p>
          Refraction is a single sample displaced along the surface normal, deepening the
          tint where the surface bends light away from you. Worth being precise about
          what that is and is not: the canvas is its own layer, so it cannot refract the
          text and images drawn above it. It refracts its own depth, which reads as
          thickness &mdash; it is not distorting the page.
        </p>
        <p>
          Output is premultiplied alpha that falls to zero on flat water, so an
          undisturbed page is untouched rather than covered by a transparent sheet. Peak
          opacity is kept deliberately low; this sits behind body text, and it should
          read as a disturbance in the light rather than as a layer over the content.
        </p>
      </div>
    </section>

    <section class="model">
      <div class="model-head">
        <span class="eyebrow">CONSTRAINTS</span>
        <h2>Paying for it</h2>
      </div>
      <div class="model-body">
        <ul class="constraint-list">
          <li><b>Simulation cost is fixed by the grid, not the window.</b> 256 cells on the long edge, dropping to 176 or 112 on devices reporting few cores or little memory.</li>
          <li><b>Shading cost scales with pixels, so that is what gives first.</b> Render resolution steps down 1.5 &rarr; 1.15 &rarr; 0.85 &rarr; 0.6 &rarr; 0.45 after 40 frames slower than 22&nbsp;ms, and steps back up after 240 frames faster than 12&nbsp;ms. The gap between those thresholds is deliberate: without it the page would oscillate between two quality levels.</li>
          <li><b>Six texture fetches per pixel.</b> Five for the normal and the Laplacian, one for refraction &mdash; the caustic reuses the normal's samples rather than taking five of its own.</li>
          <li><b>The loop releases.</b> Four seconds after the last disturbance the surface fades out over 0.8&nbsp;s and the animation frame is cancelled. An idle page costs nothing.</li>
          <li><b>Paused on <code>visibilitychange</code>,</b> and torn down by the router on navigation &mdash; framebuffers, textures, programs and listeners all released.</li>
          <li><b><code>prefers-reduced-motion</code> honoured.</b> The simulation never starts, and the preference is watched live rather than read once.</li>
          <li><b>Touch is handled once, not twice.</b> Pointer events already cover touch, so <code>touchmove</code> is attached only where <code>PointerEvent</code> is missing. Attaching both would inject every gesture twice.</li>
          <li><b>There is a fallback.</b> Without WebGL2 or float render targets, a Canvas 2D approximation takes over: a spring-chain wake with shed wavelets, same pointer behaviour, no simulation.</li>
        </ul>
      </div>
    </section>
  `,
};
