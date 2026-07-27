import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@app/app.component.js';

import './global.css';

/**
 * Entry point: find the mount node, render the tree, nothing else.
 *
 * `StrictMode` is on in every environment, not only in development — it is how React 19 surfaces
 * an effect that is not idempotent, by mounting, unmounting and mounting again. Nothing in this
 * application fetches from an effect (data comes from TanStack Query, `rules/frontend-fsd.mdc`
 * rule 11), so the double invocation costs nothing and catches the first accidental one.
 *
 * The missing-root case throws rather than falling back to `document.body`: an index.html without
 * `#root` is a broken build, and a silent fallback would ship it.
 */
const container = document.getElementById('root');

if (container === null) {
  throw new Error('index.html is missing the #root element the application mounts into');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
