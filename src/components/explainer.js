// Two-column "what this is" block shown at the top of each lab and on Projects.
//
// One column in plain English, one in engineering terms. Side by side means a
// non-technical reader never has to parse the technical copy to find out what
// the thing actually does.

// Shown above each lab: this page is a lightweight browser version, and the
// full project is meant to be run from its GitHub repository.
export const localNote = ({ name, local, source }) => `
  <aside class="local-note">
    <b>Heads up: this is a lightweight version that runs in your browser.</b>
    <span>${local} <a href="${source}" target="_blank" rel="noopener">${name} on GitHub &#8599;</a></span>
  </aside>`;

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
