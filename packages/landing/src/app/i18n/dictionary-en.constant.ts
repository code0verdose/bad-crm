import { type BrandedItem } from '@/shared/lib/brand.types.js';
import { type MetricItem } from '@/shared/lib/metric.types.js';

/**
 * Every string on the page, in English. This object is also the *schema* of the page's copy:
 * `Copy` in `locale.types.ts` is inferred from it, and the Russian dictionary is annotated with
 * that type — so the two languages cannot drift without failing `tsc`.
 *
 * Deliberately not `as const`. Literal types would make each string its own type and force the
 * Russian file to repeat the English words to satisfy it.
 */
export const EN_COPY = {
  meta: {
    languageName: 'English',
    switchLanguage: 'Switch language',
    skipToContent: 'Skip to content',
  },

  nav: {
    workspace: 'Workspace',
    domains: 'Domains',
    security: 'Security',
    selfHost: 'Self-host',
    github: 'GitHub',
    cta: 'Get started',
  },

  hero: {
    // Rendered word by word, line by line — the array *is* the line break.
    titleLines: ['All of your work.', 'In one place.', 'On your server.'],
    subtitle:
      'Tasks, documents, a knowledge base, files, time tracking, chat and a password vault — in one system. Shared data, shared permissions, one install on a server you own.',
    ctaPrimary: 'Run it on your host',
    ctaSecondary: 'Read the source',
    scrollHint: 'Scroll',
    stat: 'Six subscriptions replaced by one server',
  },

  showcase: {
    title: 'The six tabs your team keeps open, in one window',
    caption:
      'The board, the document, the timer and the thread work on the same data with the same permissions. Not four services glued together — one product.',
    frame: {
      sidebarTitle: 'Bad CRM',
      projectLabel: 'Project',
      projectName: 'Payments platform',
      boardColumns: ['Backlog', 'In progress', 'Review'],
      cards: [
        {
          title: 'Rotate the webhook signing secret',
          tag: 'security',
          who: 'NK',
          estimate: '2h',
          subtasks: '3/5',
        },
        {
          title: 'Invoice #114 — March retainer',
          tag: 'billing',
          who: 'MI',
          estimate: '1h',
          subtasks: '2/2',
        },
        {
          title: 'RLS policy for time_entries',
          tag: 'database',
          who: 'AS',
          estimate: '4h',
          subtasks: '1/4',
        },
        {
          title: 'Onboarding: design handover',
          tag: 'people',
          who: 'NK',
          estimate: '3h',
          subtasks: '0/3',
        },
      ],
      views: {
        doc: {
          title: 'Contract — acceptance criteria',
          lines: [
            'The milestone is accepted when every story in it is `done` and the',
            'demo has been recorded. Payment terms are net 15 from the invoice',
            'date; overtime is billed at the same rate.',
          ],
          callout: 'Linked: 4 tasks · 2 calls · invoice #114',
        },
        time: {
          title: 'This week',
          columns: ['Task', 'Who', 'Hours'],
          rows: [
            { task: 'Webhook signing secret', who: 'NK', hours: '6.5' },
            { task: 'Budget page', who: 'AS', hours: '4.0' },
            { task: 'RLS for time entries', who: 'NK', hours: '3.5' },
            { task: 'Client sync', who: 'MI', hours: '1.0' },
          ],
          totalLabel: 'Billable',
          totalValue: '15.0 h',
        },
      },
      timerLabel: 'Running',
      aside: {
        board: {
          title: 'Activity',
          lines: [
            'Nina moved a card to Review',
            'Artem logged 2 h on the webhook',
            'Maria left a comment',
          ],
        },
        doc: {
          title: 'Linked to this document',
          lines: ['4 tasks', '2 calls', 'invoice #114'],
        },
        time: {
          title: 'This week',
          lines: ['15.0 h billable', '3 people', 'approved on Friday'],
        },
      },
      timerValue: '01:24:06',
      docTitle: 'Contract — acceptance criteria',
      chatLine: 'shipped the migration, budget page next',
      windowTitle: 'Bad CRM — Tasks',
    },
  },

  replaces: {
    title: 'You can cancel the subscriptions',
    subtitle:
      'Six vendors means six bills, six permission models and six invitations for every new hire. When somebody leaves, one of the six always keeps the access nobody revoked.',
    // `brand` picks the glyph in `brand-mark.component.tsx`; it is not a translated string, but it
    // lives here so that a tool cannot be added to one language and forgotten in the other.
    tools: [
      { name: 'Jira', brand: 'jira' },
      { name: 'Notion', brand: 'notion' },
      { name: 'Obsidian', brand: 'obsidian' },
      { name: 'Slack', brand: 'slack' },
      { name: '1Password', brand: 'onepassword' },
      { name: 'Toggl', brand: 'toggl' },
      { name: 'that spreadsheet', brand: 'sheet' },
    ] as BrandedItem[],
    footnote: 'All of it is replaced by one server you bring up with a single command.',
  },

  domains: {
    preview: {
      milestones: ['Discovery', 'Billing', 'Launch'],
      columns: ['Backlog', 'Doing', 'Review'],
      files: [
        { name: 'contract-v4', size: '820 KB' },
        { name: 'handover', size: '1.4 MB' },
        { name: 'march-hours', size: '12 KB' },
      ],
      weekdays: ['M', 'T', 'W', 'T', 'F'],
      weekTotal: '15.0 h',
      secrets: ['Production database', 'Stripe live key', 'SMTP relay'],
    },
    title: 'Eight areas that behave like one product',
    items: [
      {
        name: 'Projects',
        summary: 'The centre of the graph. Everything else hangs off a project and a person.',
        points: ['Members, roles and rates', 'Milestones and acceptance', 'Budget against burn'],
      },
      {
        name: 'Tasks',
        summary: 'Boards, columns, subtasks, dependencies — with keyboard-first drag and drop.',
        points: ['Per-board access control', 'Comments and mentions', 'Time logged on the card'],
      },
      {
        name: 'Documents',
        summary: 'Block editor with structured content, version history and inline discussion.',
        points: ['Blocks, not HTML soup', 'Mentions of any entity', 'Permissions inherited'],
      },
      {
        name: 'Knowledge base',
        summary: 'Markdown as the source of truth, with backlinks and a graph you can walk.',
        points: ['Plain files, portable', 'Backlinks and tags', 'Full-text and semantic search'],
      },
      {
        name: 'Files',
        summary: 'S3-compatible storage with presigned links, previews and per-entity attachments.',
        points: ['Permission checked first', 'Short-lived links', 'Any entity can carry files'],
      },
      {
        name: 'Time',
        summary: 'One entry model: a timer, a manual row and an import are the same record.',
        points: [
          'One running timer, enforced',
          'Timesheets and approval',
          'Hours reach the invoice',
        ],
      },
      {
        name: 'Chat',
        summary: 'Channels and threads next to the work, not in a separate product.',
        points: ['Rooms built by the server', 'Presence and typing', 'Messages link to entities'],
      },
      {
        name: 'Vault',
        summary: 'Zero-knowledge secrets: the installation admin cannot read your items.',
        points: ['Encrypted in your browser', 'Sharing with key rotation', 'Secure one-time links'],
      },
    ],
  },

  graph: {
    title: 'From a call to an invoice, in one chain',
    subtitle:
      'Not an agreement about who writes what down, but a link in the database: from any step you can reach the next one.',
    nodes: [
      { label: 'Call', detail: 'Thursday, client sync' },
      { label: 'Decision', detail: 'Ship billing in March' },
      { label: 'Task', detail: 'Stripe webhook handler' },
      { label: 'Hours', detail: '14h 20m across 3 people' },
      { label: 'Invoice', detail: '#114 — sent, awaiting payment' },
    ],
    tables: ['calls', 'decisions', 'tasks', 'time_entries', 'invoice_lines'],
    footnote:
      'Every arrow is a link in the database, not a reconciliation somebody does by hand — and every one of them is visible to your team only.',
  },

  invariants: {
    visual: {
      tenantOwn: 'yours',
      tenantHidden: 'hidden',
      plaintext: 'correct horse battery staple',
      hostName: 'your-host.internal',
      hostContainers: '5 containers',
      hostOutbound: '0 outbound calls',
    },
    title: 'Four decisions that cannot be postponed',
    items: [
      {
        tag: 'Multi-tenancy',
        title: 'Isolation lives in the database, not in a forgotten WHERE clause',
        body: 'Every tenant table carries an organization id and a row-level security policy with both halves — what you may read and what you may write. The application role cannot bypass it, and an isolation test proves not only that a foreign row is hidden but that your own is visible.',
        proof: 'FORCE ROW LEVEL SECURITY',
      },
      {
        tag: 'Permissions',
        title: 'One place decides what you may do',
        body: 'Every endpoint declares a permission from a closed catalogue, and the check runs in the use case — not only in middleware. Lists filter in SQL. A resource in another organization answers 404, never 403, so the API never becomes an oracle of what exists.',
        proof: 'effectivePermission = capability ∧ resource ACL',
      },
      {
        tag: 'End-to-end encryption',
        title: 'The server stores ciphertext it cannot open',
        body: 'Vault items are encrypted in your browser with a key derived from your master password. Nothing decrypted reaches the server, the logs, the search index or the AI context — the assistant physically has no port to the vault, and a test fails the build if one appears.',
        proof: 'XChaCha20-Poly1305 · Argon2id',
      },
      {
        tag: 'Self-hosting',
        title: 'The whole thing is yours, including the exit',
        body: 'One compose file brings up the application and everything it needs. No licence server, no phone home, no seat counter. AGPL-3.0 means you can read it, fork it, audit it — and keep running your fork if we disappear.',
        proof: 'docker compose up -d',
      },
    ],
  },

  e2ee: {
    title: 'Type a password and watch what reaches the server',
    subtitle:
      'The field below is not sent anywhere — not from this page, and not from the product. What you see underneath is exactly what would land in the database.',
    windowTitle: 'Vault — new item',
    serverWindowTitle: 'bad-crm — server log',
    inputLabel: 'Your secret',
    inputPlaceholder: 'type anything, for example hello',
    serverLabel: 'What the server stores',
    emptyState: 'Empty so far — and that is exactly how much we want to know about you.',
    bytesLabel: 'bytes stored',
    readableLabel: 'readable by us',
    note: 'Encrypted with a key derived from your master password. We never receive that password, so we cannot help you recover it — that is the trade, and it is the point.',
  },

  ai: {
    youInitials: 'YOU',
    aiInitials: 'AI',
    title: 'Your assistant gets the same access you do — and nothing more',
    subtitle:
      'Bad CRM speaks MCP, so Claude, ChatGPT or your own agent can read the workspace and act in it on your behalf. Every request runs under your account and your permissions: the assistant cannot see a project you cannot see, and cannot close a task you are not allowed to close.',
    windowTitle: 'Claude — Bad CRM (MCP)',
    connect:
      'Bad CRM ships an MCP server. Add it to Claude Desktop, Cursor, ChatGPT or an agent you wrote yourself, sign in once, and the workspace is available in the chat — with your account, your projects and your permissions.',
    clientsLabel: 'Works with',
    clients: ['Claude', 'ChatGPT', 'Cursor', 'Your own agent'],
    prompt: 'What is blocking the March milestone, and who is on it?',
    answer:
      'Two tasks are blocking it. “RLS policy for time_entries” has been in Review for four days (Nina), and “Rotate the webhook signing secret” has no assignee. I can assign it and set the due date.',
    follow: 'Assign it to Artem, due Friday.',
    confirm: 'Done. Task assigned to Artem, due 6 March. Nina was mentioned in the thread.',
    callsLabel: 'What it called',
    calls: [
      { tool: 'tasks.search', detail: 'milestone: March, status: blocked' },
      { tool: 'time.summary', detail: 'project: payments, week: current' },
      { tool: 'tasks.update', detail: 'assignee: artem, due: 2026-03-06' },
    ],
    points: [
      {
        title: 'Reads what you can read',
        body: 'Retrieval runs through the same permission checks as the interface, per request, under your token — not a service account with a view of everything.',
      },
      {
        title: 'Acts within your rights',
        body: 'Creating a task, logging hours, moving a card, replying in a thread — the assistant can do exactly what your role allows, and every action lands in the audit log with your name and the tool that made it.',
      },
      {
        title: 'Never reaches the vault',
        body: 'The AI context has no port to the password vault. That is not a policy, it is the architecture: an import from one to the other fails the build.',
      },
      {
        title: 'Your model, your keys',
        body: 'Anthropic, OpenAI, an OpenAI-compatible endpoint or a local model — you choose the provider and hold the key. Nothing is routed through us, because there is no us to route it through.',
      },
    ],
  },

  metrics: {
    title: 'What it costs and what it collects about you',
    items: [
      {
        kind: 'number',
        value: 0,
        prefix: '$',
        suffix: '',
        caption: 'Per seat, per month — however many of you there are.',
      },
      {
        kind: 'number',
        value: 18,
        prefix: '',
        suffix: '',
        caption: 'Domains in one install, from tasks through to invoices.',
      },
      {
        kind: 'number',
        value: 1,
        prefix: '',
        suffix: '',
        caption: 'Command brings up the database, cache, storage, search and the app.',
      },
      {
        kind: 'text',
        headline: 'Never calls home',
        caption: 'No usage analytics, no crash reports, no licence check.',
      },
      {
        kind: 'number',
        value: 100,
        prefix: '',
        suffix: '%',
        caption: 'Of your data on your host — search index and backups included.',
      },
      {
        kind: 'text',
        headline: 'No seat limit',
        caption: 'The licence does not count seats: put the whole company in.',
      },
    ] as MetricItem[],
    visuals: {
      priceThem: 'Jira + Notion + Slack…',
      priceThemValue: '$1,193',
      priceUs: 'Bad CRM',
      priceUsValue: '$0',
      areas: ['Projects', 'Tasks', 'Documents', 'Knowledge', 'Files', 'Time', 'Chat', 'Vault'],
      areasMore: '+10 more',
      telemetryRows: ['Usage analytics', 'Crash reports', 'Licence check'],
      telemetryState: 'off',
      hostName: 'your-host.internal',
      hostParts: ['database', 'files', 'search', 'backups'],
      seatsNote: 'and the price stays $0',
    },
  },

  demo: {
    title: 'And all of it is live',
    subtitle:
      'Tasks, statuses and messages update for everybody at once — no page reload, no separate chat app.',
    windowTitle: 'Bad CRM — Board',
    columns: ['Backlog', 'In progress', 'Done'],
    cards: [
      { title: 'Rotate signing secret', tag: 'security', who: 'NK', estimate: '2h' },
      { title: 'Budget page', tag: 'billing', who: 'AS', estimate: '6h' },
      { title: 'RLS for time entries', tag: 'database', who: 'NK', estimate: '4h' },
      { title: 'Invoice #114', tag: 'finance', who: 'MI', estimate: '1h' },
    ],
    chat: [
      { author: 'Nina', initials: 'NK', text: 'moved the migration to review', own: false },
      { author: 'You', initials: 'YOU', text: 'nice — I will take the budget page', own: true },
      { author: 'Nina', initials: 'NK', text: 'invoice #114 went out this morning', own: false },
      { author: 'Maria', initials: 'MI', text: 'client confirmed the March milestone', own: false },
    ],
    typing: 'Nina is typing…',
    youTyping: 'you are typing…',
    online: '3 online',
    composerPlaceholder: 'Write something…',
    send: 'Send',
    you: 'You',
    youInitials: 'YOU',
  },

  selfHost: {
    title: 'One command and it is running',
    subtitle:
      'The database, cache, file storage, search and mail come up together with the application. Nothing to wire by hand, and the minimal profile runs without search or AI at all.',
    terminal: [
      '$ git clone https://github.com/badcrm/bad-crm.git',
      '$ cp .env.example .env',
      '$ docker compose up -d',
      '',
      'ok  postgres      healthy',
      'ok  redis         healthy',
      'ok  minio         healthy',
      'ok  meilisearch   healthy',
      'ok  bad-crm       listening on :3000',
    ],
    terminalTitle: 'bad-crm — zsh — 92×24',
    priceLabel: 'Per seat, per month',
    priceCompare: 'What the same team pays elsewhere, per month:',
    priceRows: [
      { name: 'Jira + Confluence', brand: 'jira', cost: '$310' },
      { name: 'Notion', brand: 'notion', cost: '$240' },
      { name: 'Slack', brand: 'slack', cost: '$218' },
      { name: '1Password', brand: 'onepassword', cost: '$200' },
      { name: 'Toggl', brand: 'toggl', cost: '$225' },
    ] as (BrandedItem & { cost: string })[],
    priceTotal: 'Their total, 25 people',
    priceTotalValue: '$1,193',
    priceNote: 'The only bill is your own server.',
  },

  stack: {
    title: 'Built on technology that has already proven itself',
    items: [
      { name: 'PostgreSQL', brand: 'postgres', role: 'Data, and the isolation policy itself' },
      { name: 'Redis', brand: 'redis', role: 'Queues, presence, rate limits' },
      { name: 'MinIO', brand: 'minio', role: 'S3-compatible file storage' },
      { name: 'Meilisearch', brand: 'meilisearch', role: 'Permission-aware search' },
      { name: 'Express', brand: 'express', role: 'Hexagonal HTTP layer' },
      { name: 'Prisma', brand: 'prisma', role: 'Schema and migrations' },
      { name: 'React', brand: 'react', role: 'The interface' },
      { name: 'Socket.IO', brand: 'socketio', role: 'Realtime rooms' },
      { name: 'libsodium', brand: 'libsodium', role: 'The vault crypto' },
      { name: 'Docker', brand: 'docker', role: 'The whole delivery' },
    ] as (BrandedItem & { role: string })[],
  },

  cta: {
    title: 'Own your workspace',
    subtitle:
      'Download it, read the code and run it on your own server. No sign-up, no per-seat limits.',
    primary: 'Get started',
    secondary: 'Star on GitHub',
    form: {
      title: 'Or tell us what you need',
      nameLabel: 'Name',
      namePlaceholder: 'Nina',
      emailLabel: 'Email',
      emailPlaceholder: 'nina@example.com',
      messageLabel: 'Message',
      messagePlaceholder:
        'We are eleven people and we live in Jira. What would migration look like?',
      submit: 'Send',
      hint: 'This page has no server: the button opens your mail app with the message ready.',
      sent: 'Your mail client should be open. If it is not, write to hello@badcrm.dev.',
    },
  },

  legal: {
    back: 'Back to the site',
    updatedLabel: 'Last updated',
    draftNotice:
      'Draft. This site is a prototype and these documents have not been reviewed by a lawyer; the operator’s legal details are placeholders. Do not publish them as they are.',
    terms: {
      title: 'Terms of Service',
      updated: '4 August 2026',
      intro:
        'These terms cover this website only — the pages you are reading now. The Bad CRM software itself is distributed separately under the GNU AGPL-3.0-or-later licence, and that licence, not this document, governs what you may do with the code.',
      sections: [
        {
          heading: 'Who runs this site',
          body: [
            'The site is operated by the Bad CRM project (the “operator”). Contact: hello@badcrm.dev.',
            'The operator’s registered name, address and company number are to be inserted before publication.',
          ],
        },
        {
          heading: 'What the site is',
          body: [
            'An informational page describing a self-hosted product. It sells nothing, hosts no user accounts and stores no user content.',
            'The interactive demonstrations on the page — the vault field, the chat, the board — run entirely in your browser. Nothing you type into them is transmitted anywhere.',
          ],
        },
        {
          heading: 'The software is separate',
          body: [
            'Bad CRM is free software licensed under AGPL-3.0-or-later. You may run, study, modify and redistribute it under the terms of that licence.',
            'Because it is self-hosted, the operator provides no service level, no uptime commitment and no support obligation for your installation.',
          ],
        },
        {
          heading: 'No warranty',
          body: [
            'The site and the software are provided “as is”, without warranty of any kind, to the fullest extent permitted by applicable law. Nothing here is professional, legal or security advice.',
            'Nothing in this document limits any right you have as a consumer under mandatory law.',
          ],
        },
        {
          heading: 'Acceptable use',
          body: [
            'Do not attempt to disrupt the site, scrape it at a rate that degrades it for others, or use it to distribute unlawful content.',
          ],
        },
        {
          heading: 'Changes',
          body: [
            'These terms may change as the project develops. The date above is the date of the current version; earlier versions are in the repository’s history.',
          ],
        },
        {
          heading: 'Governing law',
          body: [
            'The governing law and the competent courts are to be inserted before publication, together with the operator’s registered details.',
          ],
        },
      ],
    },
    privacy: {
      title: 'Privacy Policy',
      updated: '4 August 2026',
      intro:
        'The short version: this site collects nothing about you automatically. There is no analytics, no advertising, no tracking pixel and no third-party script. What follows is the same statement in the form the GDPR asks for.',
      sections: [
        {
          heading: 'Controller',
          body: [
            'The controller for any personal data processed through this site is the Bad CRM project, contact hello@badcrm.dev. Registered details are to be inserted before publication.',
          ],
        },
        {
          heading: 'What is processed, and why',
          body: [
            'Browsing the site: no personal data is collected. No analytics or profiling is performed.',
            'Writing to us through the contact form: the form does not send anything itself — it opens your own email client with the message prefilled. If you then send that email, we process your address and whatever you wrote, on the basis of our legitimate interest in answering you (Art. 6(1)(f) GDPR), and only for that purpose.',
            'Preferences: your chosen language and your cookie choice are stored in your browser’s local storage. They never leave your device and are not personal data in any useful sense — they are settings.',
          ],
        },
        {
          heading: 'Server logs',
          body: [
            'The hosting provider may keep short-lived technical logs (IP address, user agent, requested path) for security and to keep the site running. Where such logs exist, the basis is legitimate interest in operating the site securely, and the retention period is the provider’s default.',
          ],
        },
        {
          heading: 'Who else sees it',
          body: [
            'No data is sold, shared for advertising, or transferred to third parties for their own purposes. The only recipients are the hosting provider and the email provider, acting as processors.',
          ],
        },
        {
          heading: 'How long it is kept',
          body: [
            'Email correspondence is kept for as long as needed to answer you and, where relevant, to keep a record of the exchange. Browser preferences last until you clear them.',
          ],
        },
        {
          heading: 'Your rights',
          body: [
            'You have the right of access, rectification, erasure, restriction, objection and portability, and the right to complain to your supervisory authority. Write to hello@badcrm.dev to exercise any of them.',
          ],
        },
        {
          heading: 'The software is not this site',
          body: [
            'If you self-host Bad CRM, you are the controller for the data in your installation. The operator of this site has no access to it, receives no telemetry from it, and cannot read it.',
          ],
        },
      ],
    },
    cookies: {
      title: 'Cookie Policy',
      updated: '4 August 2026',
      intro:
        'This site sets no cookies. It stores two settings in your browser’s local storage — your language and your answer to the cookie banner — and nothing else. This page explains what that means and what would change if that ever stopped being true.',
      sections: [
        {
          heading: 'What is stored today',
          body: [
            'bcl-locale — the language you chose, so the page opens in it next time. Strictly necessary for the site to behave as you asked; no consent required.',
            'bcl-consent — your answer to the banner, so you are not asked again. Also strictly necessary: without it, respecting your “no” would be impossible.',
            'Both live in local storage, not in cookies, and are never sent to a server.',
          ],
        },
        {
          heading: 'What is not stored',
          body: [
            'No analytics or statistics cookies. No advertising or profiling cookies. No third-party scripts of any kind — no fonts, no maps, no embedded video, no chat widget.',
          ],
        },
        {
          heading: 'The banner',
          body: [
            'Because only strictly necessary storage is in use, the banner asks for nothing you have to grant. It exists to state the fact and to record a decision if analytics is ever added: rejecting is exactly as easy as accepting, and nothing optional is enabled before you agree.',
            'You can change your answer at any time from the link in the footer.',
          ],
        },
        {
          heading: 'If this changes',
          body: [
            'Any future optional storage will be listed here with its purpose, its provider and its lifetime, and will only be set after you have opted in.',
          ],
        },
      ],
    },
  },

  cookies: {
    title: 'Cookies, honestly',
    body: 'This site sets no tracking cookies and loads no third-party scripts. It keeps two settings in your browser: your language, and this answer. Optional analytics is off — and would only be switched on if you allowed it.',
    accept: 'Allow optional',
    reject: 'Only necessary',
    more: 'Cookie policy',
    manage: 'Cookie settings',
  },

  footer: {
    tagline: 'Self-hosted, multi-tenant workspace for software teams.',
    licence: 'AGPL-3.0-or-later',
    columns: [
      { title: 'Product', links: ['Workspace', 'Domains', 'Security', 'Self-host'] },
      { title: 'Project', links: ['GitHub', 'Licence', 'Security policy', 'Contributing'] },
    ],
    legalTitle: 'Legal',
    legalLinks: {
      terms: 'Terms of Service',
      privacy: 'Privacy Policy',
      cookies: 'Cookie Policy',
      manageCookies: 'Cookie settings',
    },
    disclaimer:
      'A design prototype of the product page. The repository is in its foundation phase — this page shows the product as it is specified, not as it is released.',
  },
};
