// Structured resume content. This is the drop-in container: edit the objects
// below (or paste converted LaTeX content into them) and the Resume view
// re-renders without touching any markup or styles.
//
// Shapes:
//   education: { school, degree, location, dates }
//   experience / projects: { title, org?, stack?, dates?, bullets: string[] }
//   skills: { group, items }
//   awards: string[]

export const summary =
  'Computer Science + Advertising at the University of Illinois Urbana-Champaign. ' +
  'I build systems that can be inspected: distributed storage, research pipelines, and the interfaces that make them legible.';

export const education = [
  {
    school: 'University of Illinois Urbana-Champaign',
    degree: 'B.S. Computer Science + Advertising',
    location: 'Urbana, IL',
    dates: 'Expected December 2028',
  },
];

export const experience = [
  {
    title: 'Software Development Intern',
    org: 'Sketch Development',
    dates: 'Feb. 2026 — May 2026',
    bullets: [
      'Rebuilt 50 reusable HubSpot CMS modules across six pages using HubL, HTML/CSS, and JavaScript, resolving more than 70 rendering defects and enabling consistent service-page updates.',
      'Restructured service pages, added schema-rich FAQs, and created machine-readable service mappings, contributing to search impressions more than doubling from 75,000 to 200,000.',
      'Mapped application, database, network, compliance, and recovery dependencies for AWS migration planning so the team could identify prerequisites before implementation and account for business continuity requirements.',
    ],
  },
  {
    title: 'Software Development Mentorship',
    org: 'World Wide Technology (WWT)',
    dates: 'Feb. 2025 — May 2025',
    bullets: [
      'Led a five-person team with WWT engineer Michael Wilson to build a centralized scheduling platform used by three administrators and more than 10 Parkway clubs, replacing separate manual reminders; coordinated frontend, authentication, and backend handoffs.',
      'Built scheduling and event-management interfaces with JavaScript and HTML/CSS, integrating Python backend logic for user access and administrator approvals to connect student-facing workflows with administrative oversight.',
    ],
  },
  {
    title: 'Director of Advertising',
    org: 'Connect Me Tutoring',
    dates: 'Jan. 2023 — Apr. 2026',
    bullets: [
      'Built a continuously running, self-hosted Python/PostgreSQL system for a 13-person team to monitor media-outlet information, match stories to relevant outlets, and draft personalized LLM-assisted pitches, automating a manual workflow that previously required approximately 15 minutes per email.',
      'Implemented recipient exclusion lists, deduplication, human approval gates, and retry controls to prevent duplicate or unreviewed outreach while preserving editorial oversight; helped secure more than 10 television placements through media outreach.',
    ],
  },
];

export const projects = [
  {
    title: 'ContextTree',
    subtitle: 'Branching Conversation Engine for LLMs',
    stack: 'Python, FastAPI, SQLite, React, TypeScript',
    bullets: [
      'Built a branching chat application with React/TypeScript and FastAPI/SQLAlchemy, persisting conversation nodes in SQLite and reconstructing only the active root-to-node path for model prompts.',
      'Reduced estimated prompt tokens by 39.4% versus flat history, from 2,443 to 1,480 across nine synthetic branching requests.',
    ],
  },
  {
    title: 'AsterKV',
    subtitle: 'Fault-Tolerant Distributed Key-Value Store',
    stack: 'Go, gRPC, Protocol Buffers, Raft',
    bullets: [
      'Implemented Raft leader election and write replication for a three-node Go key-value store, using gRPC/Protocol Buffers for communication and durable snapshots for recovery.',
      'Added checksummed persistent state, client-request deduplication, and compare-and-swap; passed 70 repeated fault/safety runs with no acknowledged-write loss or duplicate retried writes and restored writes within 0.40—1.70 seconds after leader failure.',
    ],
  },
  {
    title: 'InsiderPulse',
    subtitle: 'SEC Insider-Purchase Analysis & Backtesting',
    stack: 'Python, pandas, SQLite, requests, yfinance',
    bullets: [
      'Built an EDGAR ingestion pipeline that parsed 1,892 SEC Form 4 filings without parse failures, extracting 66 open-market purchase records and grouping them into 47 signals.',
      'Implemented rule-based scoring by insider role, transaction size, and clustered buying; backtested available 7/30/90-day returns against SPY with look-ahead-bias checks.',
    ],
  },
];

export const skills = [
  { group: 'Languages', items: 'C++, Python, Go, Java, SQL, JavaScript, TypeScript' },
  { group: 'Machine Learning & AI', items: 'PyTorch, Computer Vision, LLM APIs' },
  {
    group: 'Systems & Infrastructure',
    items: 'Distributed Systems, PostgreSQL, SQLite, gRPC, Protocol Buffers, REST APIs, Git, GitHub',
  },
  { group: 'Web', items: 'FastAPI, SQLAlchemy, React, Flask, HTML/CSS, HubL, HubSpot CMS' },
];

export const awards = [
  'FBLA National Finalist (9th in U.S.)',
  '3× Missouri Financial Math Champion',
  'USACO Gold',
  'Mathleague National Finalist',
];
