import { configure } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

import { NAMESPACES } from '@shared/i18n/i18n.config.js';

/**
 * One mounted tree per test.
 *
 * Without this, `render` leaves the previous tree in the document and `getByRole` starts matching
 * two elements — a failure that reads as a bug in the component under test rather than as leaked
 * state from the test before it.
 */
afterEach(() => {
  cleanup();
});

/**
 * How long a `findBy*` waits before it reports «not in the document».
 *
 * The default is one second, which is a statement about the machine rather than about the code: this
 * suite mounts the whole application — router, providers, i18next, three hundred rows of catalogue —
 * and under `turbo run test`, with four packages competing, a query that resolves in eighty
 * milliseconds alone has been measured past a second. What comes out then is not «this is slow» but
 * «element not found», printed with a DOM dump that shows the element about to appear.
 *
 * Five seconds is far above what any of these renders costs and far below a hang: a genuinely
 * missing element still fails, five seconds later, with the same message.
 */
configure({ asyncUtilTimeout: 5_000 });

/**
 * Two browser APIs jsdom does not implement and Mantine calls on mount.
 *
 * `matchMedia` is how the provider resolves `auto` to a real colour scheme, and `ResizeObserver` is
 * how `ScrollArea` and `AppShell` measure themselves. Without them every render of a Mantine tree
 * throws before a single assertion runs — so these are not test conveniences, they are the parts of
 * the platform the runner is missing.
 *
 * What they must not become is a behaviour stub. `matches` is always `false` — «no media query
 * matched» — which is the honest answer for a headless DOM with no viewport, and it is why a test
 * about a real breakpoint belongs in Playwright rather than here.
 */
vi.stubGlobal(
  'matchMedia',
  vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
);

/** The router restores scroll on navigation; jsdom has no viewport to scroll. */
vi.stubGlobal('scrollTo', vi.fn());

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  },
);

/**
 * i18next in `cimode`, initialised once for the whole client suite.
 *
 * Every assertion in these tests names a key — `auth.login.title`, `common.retry` — and that is the
 * right thing for them to name: a test that asserts «Sign in» fails when somebody improves the
 * wording, which teaches the next reader to edit the assertion without reading it. `cimode` makes
 * `t(key)` answer with the key, so the suite keeps asserting *which string* a component asks for and
 * stays silent about what it says.
 *
 * The translations themselves are asserted where they are data:
 * `test/i18n/catalogue-parity.test.ts` proves every used key exists in both languages, and
 * `test/i18n/i18n-config.test.ts` proves the instance resolves a real one.
 *
 * Initialised globally rather than through a provider per test, because `useTranslation` falls back
 * to the global instance — so an uninitialised one would leave every render depending on i18next's
 * behaviour when it is not set up, which is a warning today and could be anything tomorrow.
 */
await i18next.use(initReactI18next).init({
  lng: 'cimode',
  // Without this, cimode answers with the key minus its namespace — `login.title` rather than
  // `auth.login.title` — and every assertion in this suite names the full key.
  appendNamespaceToCIMode: true,
  fallbackLng: 'cimode',
  // The product's list, not a copy of it. Which namespaces exist decides what `cimode` answers: an
  // unregistered `teams` is not a namespace but the first segment of a key in `common`, so
  // `t('teams.field.name')` comes back as `common.teams.field.name` — a string no build of the
  // application ever renders, asserted against by a suite that believes it is naming real keys. The
  // hand-written copy that used to stand here had drifted by four namespaces before anyone looked.
  ns: NAMESPACES,
  defaultNS: 'common',
  nsSeparator: '.',
  keySeparator: '.',
  resources: {},
  interpolation: { escapeValue: false },
});

/**
 * Back to `cimode` after every test, because the application changes the language for real: the
 * switcher exists, and a case that clicks «Русский» leaves the shared instance in `ru`. Without
 * this the next file to run asserts against a catalogue it never asked for — an order-dependent
 * failure, the kind that gets debugged by rerunning rather than by reading.
 */
afterEach(async () => {
  if (i18next.language !== 'cimode') await i18next.changeLanguage('cimode');
});
