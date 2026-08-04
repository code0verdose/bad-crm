import { type ReactNode } from 'react';

/**
 * The five glyphs of the chain — call, decision, task, hours, invoice.
 *
 * Filled shapes on a 24-unit grid, in the same visual language as the brand marks beside them
 * (`brand-mark.component.tsx`): the earlier line-art set sat next to solid logos and read as an
 * unfinished sketch.
 *
 * Local to this section rather than in `shared/ui`: they illustrate one argument on one screen and
 * nothing else on the page needs them.
 */
const ICONS: ReactNode[] = [
  // Call — a handset in a rounded square.
  <path
    key="call"
    d="M7.6 3.2a1.6 1.6 0 0 1 2.2.6l1.4 2.5a1.6 1.6 0 0 1-.3 2l-1.1 1a10.4 10.4 0 0 0 4.9 4.9l1-1.1a1.6 1.6 0 0 1 2-.3l2.5 1.4a1.6 1.6 0 0 1 .6 2.2l-1 1.8a2.6 2.6 0 0 1-2.7 1.3C10.5 18.4 5.6 13.5 4.5 6.9a2.6 2.6 0 0 1 1.3-2.7z"
  />,
  // Decision — a tick in a disc.
  <path
    key="decision"
    d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm5 7.4-5.7 6.4a1.3 1.3 0 0 1-1.9.05L6.9 12.9a1.3 1.3 0 0 1 1.8-1.8l1.5 1.5 4.8-5.4A1.3 1.3 0 0 1 17 9.4z"
  />,
  // Task — a card with two lines and a checked box.
  <path
    key="task"
    d="M5.5 3h13A2.5 2.5 0 0 1 21 5.5v13a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18.5v-13A2.5 2.5 0 0 1 5.5 3zm2 5.6a1.1 1.1 0 0 0 0 2.2h2.2a1.1 1.1 0 0 0 0-2.2zm0 4.6a1.1 1.1 0 0 0 0 2.2h9a1.1 1.1 0 0 0 0-2.2z"
  />,
  // Hours — a clock.
  <path
    key="hours"
    d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1.1 4.6v5.1l3.2 1.9a1.1 1.1 0 0 1-1.1 1.9l-3.8-2.2a1.1 1.1 0 0 1-.5-1V6.6a1.1 1.1 0 0 1 2.2 0z"
  />,
  // Invoice — a document with a torn edge and two ruled lines.
  <path
    key="invoice"
    d="M6.2 2h8l4.4 4.4v14.3a1.2 1.2 0 0 1-1.8 1l-1.7-1-1.7 1a1.2 1.2 0 0 1-1.2 0l-1.7-1-1.7 1a1.2 1.2 0 0 1-1.2 0l-1.7-1-1.7 1a1.2 1.2 0 0 1-1.8-1V3.2A1.2 1.2 0 0 1 6.2 2zm2 6.2a1.1 1.1 0 0 0 0 2.2h7a1.1 1.1 0 0 0 0-2.2zm0 4a1.1 1.1 0 0 0 0 2.2h4a1.1 1.1 0 0 0 0-2.2z"
  />,
];

export const GraphIcon = ({
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
