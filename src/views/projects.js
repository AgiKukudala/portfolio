import { labs } from '../content/site.js';

// Consolidated entry point for both labs, so the header carries one link
// instead of one per project.
export const projects = {
  render: () => `
    <section class="page-heading">
      <div class="eyebrow"><span class="dot"></span> PROJECTS &amp; LABS</div>
      <h1>Projects</h1>
      <p class="intro">
        Two systems you can operate from this page. Each lab runs against the real
        project code and reports only what that code can actually observe.
      </p>
    </section>

    ${labs
      .map(
        (lab) => `
      <article class="project">
        <span class="project-number">${lab.number}</span>
        <div>
          <div class="eyebrow">${lab.stack}</div>
          <h3>${lab.name}</h3>
          <p class="project-plain">${lab.plain}</p>
          <p class="project-technical"><span>TECHNICALLY</span> ${lab.technical}</p>
          <div class="project-actions">
            <a class="button primary" href="#${lab.id}">Open the lab <span>&#8599;</span></a>
            <a class="text-link" href="${lab.source}" target="_blank" rel="noopener">Source &#8599;</a>
          </div>
        </div>
        <div class="project-drawing">
          ${lab.flow.map((step) => `<span>${step}</span>`).join('<i>&#8594;</i>')}
        </div>
      </article>`,
      )
      .join('')}

    <section class="simple-section" id="experience">
      <div class="eyebrow">EXPERIENCE</div>
      <h2>Learning through implementation.</h2>
      <div class="experience-row">
        <span>Distributed systems</span>
        <p>Custom Raft, durable state, snapshots, atomic compare-and-swap and failure testing in AsterKV.</p>
      </div>
      <div class="experience-row">
        <span>Research pipelines</span>
        <p>SEC ingestion, XML parsing, explainable rules and historical evaluation in InsiderPulse.</p>
      </div>
      <div class="experience-row">
        <span>Interface engineering</span>
        <p>The canvas field behind every page, documented end to end in <a class="text-link" href="#fluid">Fluid Dynamics</a>.</p>
      </div>
    </section>
  `,
};
