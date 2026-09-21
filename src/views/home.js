import { profile, labs } from '../content/site.js';
import { summary, education, experience, skills } from '../content/resume.js';

const icons = {
  education:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/></svg>',
  code: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/></svg>',
  briefcase:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M9 7v13M15 7v13"/></svg>',
};

const aboutSection = () => `
  <section class="home-section about" id="about" aria-labelledby="about-title">
    <span class="section-kicker">INTRODUCTION</span>
    <h2 class="section-title" id="about-title">About Me</h2>

    <div class="about-grid">
      <div class="about-main">
        ${education
          .map(
            (ed) => `
          <article class="info-card">
            <div class="info-card-head">
              <span class="info-icon">${icons.education}</span>
              <h3>Education</h3>
            </div>
            <p class="edu-school">${ed.school}</p>
            <p class="edu-degree">${ed.degree}</p>
            <p class="edu-dates">${ed.dates}</p>
            <p class="edu-location">${ed.location}</p>
          </article>`,
          )
          .join('')}
        <p class="about-summary">${summary}</p>
      </div>

      <article class="info-card">
        <div class="info-card-head">
          <span class="info-icon alt">${icons.code}</span>
          <h3>Technical Skills</h3>
        </div>
        ${skills
          .map(
            (s) => `
          <h4 class="skill-group">${s.group}</h4>
          <div class="pill-row">
            ${s.items.split(', ').map((item) => `<span class="pill">${item}</span>`).join('')}
          </div>`,
          )
          .join('')}
      </article>
    </div>
  </section>
`;

const experienceSection = () => `
  <section class="home-section experience" id="experience" aria-labelledby="experience-title">
    <span class="section-kicker">PROFESSIONAL</span>
    <h2 class="section-title" id="experience-title">Experience</h2>

    <ol class="timeline">
      ${experience
        .map(
          (job) => `
        <li class="timeline-item">
          <span class="timeline-icon">${icons.briefcase}</span>
          <article class="info-card job-card">
            <header>
              <h3>${job.title}</h3>
              <time>${job.dates}</time>
            </header>
            <p class="job-org">${job.org}</p>
            <ul>${job.bullets.map((b) => `<li>${b}</li>`).join('')}</ul>
          </article>
        </li>`,
        )
        .join('')}
    </ol>
  </section>
`;

export const home = {
  render: () => `
    <section class="hero">
      <div class="hero-copy">
        <!-- width/height match the rendered size so the canvas below never
             reflows when the image lands. -->
        <img class="hero-photo" src="${profile.photo}" alt="${profile.name}"
             width="92" height="92" decoding="async" fetchpriority="high">
        <h1>${profile.name}</h1>
        <p class="hero-meta">${profile.study}</p>
        <p class="hero-dates">${profile.studyDates}</p>
        <div class="actions">
          <a class="button primary" href="#projects">Explore the work <span>&#8599;</span></a>
          <a class="text-link" href="${profile.github}" target="_blank" rel="noopener">View source on GitHub &#8599;</a>
        </div>
      </div>
    </section>

    <section class="quick-links" aria-label="Sections">
      ${labs
        .map(
          (lab) => `
        <a class="quick-card" href="#${lab.id}">
          <span class="eyebrow">PROJECT <span class="divider">/</span> ${lab.stack}</span>
          <h3>${lab.name}</h3>
          <p>${lab.tagline}</p>
          <span class="text-link">Open the lab &#8599;</span>
        </a>`,
        )
        .join('')}
      <a class="quick-card" href="#resume">
        <span class="eyebrow">BACKGROUND</span>
        <h3>Resume</h3>
        <p>Education, experience, projects and skills.</p>
        <span class="text-link">Read it &#8599;</span>
      </a>
    </section>

    ${aboutSection()}
    ${experienceSection()}
  `,
};
