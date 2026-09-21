// Single source of truth for identity, navigation and outbound links.
// Views import from here so a URL or label changes in exactly one place.

export const profile = {
  name: 'Agastya Kukudala',
  role: 'Software Engineering',
  photo: '/headshot.jpg',   // 256px square, served from public/
  study: 'CS + Advertising @ UIUC',
  studyDates: 'May 2026 — Dec 2028',
  location: 'Chesterfield, MO',
  school: 'University of Illinois Urbana-Champaign',
  email: 'Akukudala19@gmail.com',
  github: 'https://github.com/AgiKukudala',
  githubHandle: 'AgiKukudala',
  linkedin: 'https://www.linkedin.com/in/agastya-kukudala',
  linkedinHandle: 'agastya-kukudala',
};

// `external: true` renders as a real outbound link instead of a hash route.
// `children` renders a dropdown; `routes` lists every route that should mark
// the group active, so opening a lab still highlights Projects.
export const navLinks = [
  { label: 'Home', href: '#home' },
  {
    label: 'Projects',
    href: '#projects',
    routes: ['projects', 'asterkv', 'insiderpulse'],
    children: [
      { label: 'All projects', href: '#projects', note: 'Overview of both projects' },
      { label: 'AsterKV', href: '#asterkv', note: 'Project \u00B7 distributed key-value store' },
      { label: 'InsiderPulse', href: '#insiderpulse', note: 'Project \u00B7 SEC disclosure research' },
    ],
  },
  { label: 'Fluid Dynamics', href: '#fluid' },
  { label: 'Resume', href: '#resume' },
  { label: 'GitHub', href: profile.github, external: true },
  { label: 'Contact', href: '#contact' },
];

// The two interactive labs, surfaced from the consolidated Projects view.
export const labs = [
  {
    id: 'asterkv',
    number: '01',
    name: 'AsterKV',
    stack: 'GO · gRPC · RAFT',
    tagline: 'A replicated key-value store.',
    summary:
      'Follow one command through a real three-node Raft cluster and inspect the response it commits.',
    plain:
      'A shared notebook that three computers keep in sync. Write something on one and the other two have to agree before you are told it saved, so a single machine crashing loses nothing.',
    technical:
      'A Raft-replicated key-value store in Go. Writes reach a quorum through leader election and log replication over gRPC, with checksummed durable state, snapshots and request deduplication.',
    source: 'https://github.com/AgiKukudala/AsterKV',
    flow: ['CLIENT', 'LEADER', 'QUORUM'],
  },
  {
    id: 'insiderpulse',
    number: '02',
    name: 'InsiderPulse',
    stack: 'PYTHON · SEC EDGAR · SQLITE',
    tagline: 'Public disclosures, readable research.',
    summary:
      'Trace an SEC Form 4 filing through parsing, related insider activity and historical evaluation.',
    plain:
      'Company insiders have to tell the public when they buy their own stock. This reads those filings and shows when several insiders bought around the same time.',
    technical:
      'A Python pipeline that parses SEC Form 4 XML into SQLite, groups purchases into clusters by insider and date window, scores them with explainable rules, and backtests returns against SPY.',
    source: 'https://github.com/AgiKukudala/InsiderPulse',
    flow: ['FORM 4', 'ACTIVITY', 'RESEARCH'],
  },
];
