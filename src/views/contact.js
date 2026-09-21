import { profile } from '../content/site.js';

export const contact = {
  render: () => `
    <section class="page-heading">
      <div class="eyebrow"><span class="dot"></span> CONTACT</div>
      <h1>Get in touch.</h1>
      <p class="intro">
        Open to software engineering internships and to talking about anything on this
        site. Email is the fastest way to reach me.
      </p>
    </section>

    <section class="contact-grid">
      <a class="contact-card" href="mailto:${profile.email}">
        <span class="eyebrow">EMAIL</span>
        <b>${profile.email}</b>
        <span class="text-link">Send a message &#8599;</span>
      </a>
      <a class="contact-card" href="${profile.linkedin}" target="_blank" rel="noopener">
        <span class="eyebrow">LINKEDIN</span>
        <b>/in/${profile.linkedinHandle}</b>
        <span class="text-link">Open profile &#8599;</span>
      </a>
      <a class="contact-card" href="${profile.github}" target="_blank" rel="noopener">
        <span class="eyebrow">GITHUB</span>
        <b>@${profile.githubHandle}</b>
        <span class="text-link">Browse repositories &#8599;</span>
      </a>
    </section>

    <p class="contact-note">${profile.location} &middot; ${profile.school}</p>
  `,
};
