import { type ReactNode } from 'react';

/**
 * One glyph per domain, in the order the dictionary lists them: projects, tasks, documents,
 * knowledge base, files, time, chat, vault.
 *
 * Filled shapes on a 24-unit grid, like the brand marks and the chain icons — the page has one
 * drawing style and this is it. Indexed rather than named because the domains are a list the
 * dictionary owns: a name here would be a second place to keep them in step.
 */
const ICONS: ReactNode[] = [
  // Projects — a folder.
  <path
    key="projects"
    d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.2a2 2 0 0 1 1.6.8l1 1.4h7.2A2.5 2.5 0 0 1 21 8.7v8.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"
  />,
  // Tasks — a board of three columns.
  <path
    key="tasks"
    d="M4.5 3h15A1.5 1.5 0 0 1 21 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19.5v-15A1.5 1.5 0 0 1 4.5 3zm2 3a1 1 0 0 0-1 1v7a1 1 0 1 0 2 0V7a1 1 0 0 0-1-1zm5.5 0a1 1 0 0 0-1 1v10a1 1 0 1 0 2 0V7a1 1 0 0 0-1-1zm5.5 0a1 1 0 0 0-1 1v4a1 1 0 1 0 2 0V7a1 1 0 0 0-1-1z"
  />,
  // Documents — a page with lines.
  <path
    key="documents"
    d="M6.5 2h7L19 7.5v12A2.5 2.5 0 0 1 16.5 22h-10A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2zm1.5 8a1 1 0 1 0 0 2h7a1 1 0 1 0 0-2zm0 4a1 1 0 1 0 0 2h5a1 1 0 1 0 0-2z"
  />,
  // Knowledge base — three linked nodes.
  <path
    key="knowledge"
    d="M6 3a3 3 0 0 1 1.6 5.5l2.3 3.7a3 3 0 0 1 2.5.4l3-2.6A3 3 0 1 1 18 12a3 3 0 0 1-1.9-.7l-3 2.6a3 3 0 1 1-4.6.5L6.2 10.5A3 3 0 1 1 6 3z"
  />,
  // Files — a stack of sheets.
  <path
    key="files"
    d="M8 2h6l4.5 4.5V16A2 2 0 0 1 16.5 18h-8.5A2 2 0 0 1 6 16V4a2 2 0 0 1 2-2zM4 7a1 1 0 0 1 1 1v10.5A1.5 1.5 0 0 0 6.5 20H16a1 1 0 1 1 0 2H6.5A3.5 3.5 0 0 1 3 18.5V8a1 1 0 0 1 1-1z"
  />,
  // Time — a stopwatch.
  <path
    key="time"
    d="M9.5 1.5h5a1 1 0 1 1 0 2h-1.4v1.6a8 8 0 1 1-2.2 0V3.5H9.5a1 1 0 0 1 0-2zM13 9a1 1 0 1 0-2 0v3.8a1 1 0 0 0 .5.9l2.6 1.5a1 1 0 0 0 1-1.7L13 12.2z"
  />,
  // Chat — a bubble with a tail.
  <path
    key="chat"
    d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.4 3.9A1 1 0 0 1 5 19.2V16h-.5A.5.5 0 0 1 4 15.5z"
  />,
  // Vault — a padlock.
  <path
    key="vault"
    d="M12 1.5A5.5 5.5 0 0 0 6.5 7v2.5h-.8A2 2 0 0 0 3.7 11.5v8.2A2 2 0 0 0 5.7 21.7h12.6a2 2 0 0 0 2-2V11.5a2 2 0 0 0-2-2h-.8V7A5.5 5.5 0 0 0 12 1.5zm0 2.2A3.3 3.3 0 0 1 15.3 7v2.5H8.7V7A3.3 3.3 0 0 1 12 3.7zm0 9.6a2 2 0 0 1 1 3.7v1.7a1 1 0 1 1-2 0V17a2 2 0 0 1 1-3.7z"
  />,
];

export const DomainIcon = ({
  index,
  className,
}: {
  index: number;
  className?: string | undefined;
}) => (
  <svg
    viewBox="0 0 24 24"
    className={className}
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    {ICONS[index % ICONS.length]}
  </svg>
);
