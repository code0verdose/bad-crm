import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@app/app.component.js';
import { installApiMiddleware } from '@app/api-middleware.util.js';
import { subscribeAuthRedirect } from '@app/auth-redirect.util.js';
import { router } from '@app/router.js';
import { installStyleNonce } from '@app/style-nonce.util.js';
import { installTrustedTypesPolicy } from '@app/trusted-types.util.js';

// Mantine first, then the tokens that build on its variables, then the reset. Import order is
// cascade order: tokens declared before the library that defines `--mantine-color-*` would resolve
// against nothing.
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './styles/tokens.css';
import './global.css';

/**
 * Entry point: install the policies the page needs, wire the transport, mount.
 *
 * The order is not arbitrary. The Trusted Types policy has to exist **before the first render**,
 * because the first thing `MantineProvider` does on mount is write its CSS variables through
 * `innerHTML`; without the policy that assignment throws and nothing mounts at all (ADR-0023).
 * `installStyleNonce` follows immediately, and for the same class of reason: the scroll lock of the
 * first overlay injects its own `<style>`, and a nonce published after that overlay has opened is a
 * nonce published too late.
 *
 * The API middleware is installed before the tree so that no component can fire a request through
 * an unauthenticated client, and the sign-out subscription before it for the same reason.
 *
 * `StrictMode` is on in every environment, not only in development — it is how React 19 surfaces
 * an effect that is not idempotent, by mounting, unmounting and mounting again. Nothing in this
 * application fetches from an effect (data comes from TanStack Query, `rules/frontend-fsd.mdc`
 * rule 11), so the double invocation costs nothing and catches the first accidental one.
 *
 * The missing-root case throws rather than falling back to `document.body`: an index.html without
 * `#root` is a broken build, and a silent fallback would ship it.
 */
installTrustedTypesPolicy();
installStyleNonce();
installApiMiddleware();
subscribeAuthRedirect(router);

const container = document.getElementById('root');

if (container === null) {
  throw new Error('index.html is missing the #root element the application mounts into');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
