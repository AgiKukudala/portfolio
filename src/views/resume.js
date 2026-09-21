import { profile } from '../content/site.js';
import { summary, education, experience, projects, skills, awards } from '../content/resume.js';

const entry = (item) => `
  <article class="resume-entry">
    <header>
      <h3>${item.title}${item.org ? ` <span>&middot; ${item.org}</span>` : ''}</h3>
      ${item.dates ? `<time>${item.dates}</time>` : ''}
    </header>
    ${item.subtitle ? `<p class="resume-subtitle">${item.subtitle}</p>` : ''}
    ${item.stack ? `<p class="resume-stack">${item.stack}</p>` : ''}
    <ul>${item.bullets.map((b) => `<li>${b}</li>`).join('')}</ul>
  </article>`;

const block = (heading, body) => `
  <section class="resume-block">
    <h2>${heading}</h2>
    <div class="resume-block-body">${body}</div>
  </section>`;

export const resume = {
  render: () => `
    <section class="page-heading">
      <div class="eyebrow"><span class="dot"></span> ${profile.name.toUpperCase()}</div>
      <h1>Resume</h1>
      <p class="intro">${summary}</p>
      <div class="actions">
        <a class="text-link" href="mailto:${profile.email}">${profile.email}</a>
        <a class="text-link" href="${profile.linkedin}" target="_blank" rel="noopener">LinkedIn &#8599;</a>
        <a class="text-link" href="${profile.github}" target="_blank" rel="noopener">GitHub &#8599;</a>
      </div>
    </section>

    <div class="resume-sheet">
      ${block(
        'Education',
        education
          .map(
            (e) => `
        <article class="resume-entry">
          <header>
            <h3>${e.school}</h3>
            <time>${e.dates}</time>
          </header>
          <p class="resume-subtitle">${e.degree}</p>
          <p class="resume-stack">${e.location}</p>
        </article>`,
          )
          .join(''),
      )}

      ${block('Experience', experience.map(entry).join(''))}

      ${block('Projects', projects.map(entry).join(''))}

      ${block(
        'Technical Skills',
        `<dl class="skill-list">${skills
          .map((s) => `<dt>${s.group}</dt><dd>${s.items}</dd>`)
          .join('')}</dl>`,
      )}

      ${block(
        'Awards',
        `<ul class="award-list">${awards.map((a) => `<li>${a}</li>`).join('')}</ul>`,
      )}
    </div>
  `,
};
