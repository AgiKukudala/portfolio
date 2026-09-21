// Two-column "what this is" block shown at the top of each lab and on Projects.
//
// One column in plain English, one in engineering terms. Side by side means a
// non-technical reader never has to parse the technical copy to find out what
// the thing actually does.

export const explainer = ({ plain, technical }) => `
  <section class="explainer" aria-label="What this project does">
    <div class="explainer-card">
      <span class="explainer-tag">IN PLAIN ENGLISH</span>
      <p>${plain}</p>
    </div>
    <div class="explainer-card technical">
      <span class="explainer-tag">TECHNICALLY</span>
      <p>${technical}</p>
    </div>
  </section>`;
