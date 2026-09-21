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
      'Three computers keeping one shared list in sync. Save something, switch a computer off, and watch the others carry on.',
    plain:
      'Think of a shared notebook kept by three computers. One of them is in charge. When you save something, at least two of the three must have a copy before you are told it worked, so one computer breaking loses nothing.',
    technical:
      'A key-value store in Go that uses the Raft algorithm: the computers vote for a leader, the leader copies every change to the others, and a change counts once most of them have it.',
    local:
      'The real AsterKV runs as separate Go programs talking over a network, with data saved to disk. Clone it from GitHub to run the full cluster on your own machine.',
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
      'Browse real filings from company insiders buying their own stock, and see when several of them bought at once.',
    plain:
      'When a company’s executives or directors buy its stock, they must report it to the government. This collects those reports and points out when several insiders bought around the same time.',
    technical:
      'A Python program that downloads SEC Form 4 filings, finds real stock purchases, groups ones made close together, gives each a simple score, and checks how the stock did afterwards compared with the S&P 500.',
    local:
      'The real InsiderPulse is a Python program that downloads fresh filings and price data. Clone it from GitHub to collect up-to-date data and run your own analysis.',
    source: 'https://github.com/AgiKukudala/InsiderPulse',
    flow: ['FORM 4', 'ACTIVITY', 'RESEARCH'],
  },
];
