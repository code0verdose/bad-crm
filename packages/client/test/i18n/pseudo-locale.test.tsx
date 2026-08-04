/**
 * Renders the product in a language that is obviously not a language, and looks for text that did
 * not come from the catalogue.
 *
 * This is the check `i18next/no-literal-string` cannot make. The rule reads source and sees string
 * literals; it is blind to a sentence assembled at runtime, one supplied by a library's default
 * prop, and one baked into a component nobody thought of as text. Asking the *finished screen* sees
 * all three, because every catalogue string arrives wrapped in `⟦…⟧` and anything unwrapped came
 * from somewhere else.
 *
 * The length half is R-17 (`docs/product/prd.md`): Russian runs longer than English for the same
 * sentence. jsdom lays nothing out, so overflow itself cannot be asserted here — what *can* be
 * asserted, and is, is that a 40 % longer string still reaches the DOM intact rather than being
 * truncated by the component that renders it.
 */
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import i18next, { type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';

import {
  isPseudoLocalised,
  PSEUDO_MARKERS,
  pseudoLocalise,
  pseudoLocaliseValue,
} from '../support/pseudo-locale.util.js';
import { renderApp } from '../support/render-app.util.js';
import { setTestLanguage } from '../support/test-language.util.js';

/**
 * The catalogues as the bundle sees them, not as the filesystem does. This file runs in `jsdom`,
 * where `import.meta.url` is not a `file:` URL and `node:fs` has nothing to resolve against —
 * `import.meta.glob` is how Vite answers the same question, and it has the better property anyway:
 * a namespace added to the tree is picked up without anybody editing a list here.
 */
const CATALOGUES = import.meta.glob<Record<string, unknown>>(
  '../../src/shared/i18n/locales/en/*.json',
  { eager: true, import: 'default' },
);

const NAMESPACES = Object.keys(CATALOGUES).map(
  (path) =>
    path
      .split('/')
      .pop()
      ?.replace(/\.json$/, '') ?? '',
);

const pseudoResources = (): Record<string, Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(CATALOGUES).map(([path, tree]) => [
      path
        .split('/')
        .pop()
        ?.replace(/\.json$/, '') ?? '',
      pseudoLocalise(tree),
    ]),
  );

const pseudoInstance = async (): Promise<I18n> => {
  const instance = i18next.createInstance();

  await instance.use(initReactI18next).init({
    lng: 'pseudo',
    ns: NAMESPACES,
    defaultNS: 'common',
    nsSeparator: '.',
    keySeparator: '.',
    resources: { pseudo: pseudoResources() },
    interpolation: { escapeValue: false },
  });

  return instance;
};

/**
 * Text that is legitimately not a translation.
 *
 * `Bad CRM` is a proper noun and carries the same exemption it has in `topbar.component.tsx` and in
 * `index.html`. Everything else here is punctuation, digits or whitespace — a separator is not a
 * sentence, and demanding a catalogue entry for `·` would be the rule eating itself.
 */
const NOT_A_SENTENCE = /^[\s\d\p{P}\p{S}]*$/u;
const PROPER_NOUNS = new Set(['Bad CRM']);

/**
 * Every text node a reader could see, trimmed, with the empty ones dropped.
 *
 * `<style>` and `<script>` hold text nodes too — Mantine injects its whole variable sheet as one —
 * and a stylesheet is not a sentence anybody asked to have translated.
 */
const INVISIBLE_PARENTS = new Set(['STYLE', 'SCRIPT']);

const textNodes = (root: HTMLElement): string[] => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found: string[] = [];

  let node = walker.nextNode();
  while (node !== null) {
    const text = node.textContent?.trim() ?? '';
    const parent = node.parentElement?.tagName ?? '';

    if (text !== '' && !INVISIBLE_PARENTS.has(parent)) found.push(text);
    node = walker.nextNode();
  }

  return found;
};

beforeEach(() => {
  localStorage.clear();
  // The application drives the instance now: `useLanguage` reads the stored choice and calls
  // `changeLanguage`. Seeding `cimode` here — the suite's usual answer — would pull the instance
  // straight back out of the pseudo locale, and every string would render as its own key.
  setTestLanguage('pseudo');
});

afterEach(async () => {
  if (i18next.language !== 'cimode') await i18next.changeLanguage('cimode');
});

describe('pseudoLocaliseValue', () => {
  it('marks the string and makes it about 40 % longer', () => {
    const value = pseudoLocaliseValue('Sign in');

    expect(value.startsWith(PSEUDO_MARKERS.open)).toBe(true);
    expect(value.endsWith(PSEUDO_MARKERS.close)).toBe(true);
    expect(value).toContain('Sign in');
    expect(value.length).toBeGreaterThan('Sign in'.length * 1.3);
  });

  /**
   * Expanding inside a placeholder would corrupt the value: `{{se·conds}}` interpolates nothing and
   * renders as itself. The one transformation that must not touch what it is padding.
   */
  it.each([
    ['an interpolation placeholder', 'Try again in {{seconds}} s.', '{{seconds}}'],
    ['a Trans tag', 'Read the <1>terms</1>.', '<1>'],
  ])('leaves %s intact', (_case, input, fragment) => {
    expect(pseudoLocaliseValue(input)).toContain(fragment);
  });

  it('walks a nested tree', () => {
    expect(pseudoLocalise({ a: { b: 'Save' }, c: 'Cancel' })).toEqual({
      a: { b: pseudoLocaliseValue('Save') },
      c: pseudoLocaliseValue('Cancel'),
    });
  });

  it.each([
    ['CONTROL: recognises a marked string', pseudoLocaliseValue('Save'), true],
    ['CONTROL: leaves a plain string unrecognised', 'Save', false],
  ])('%s', (_case, value, expected) => {
    expect(isPseudoLocalised(value)).toBe(expected);
  });
});

/**
 * The screens an installation always shows. A hardcoded string on either of them is a string half
 * the product's readers cannot read, and neither the parity gate nor the lint rule would say so.
 */
describe.each([
  ['the sign-in screen', '/login', 'anonymous'],
  ['the authenticated shell', '/dashboard', 'authenticated'],
] as const)('%s in a pseudo locale', (_case, path, status) => {
  const mount = async () => {
    const { container } = renderApp({
      path,
      status,
      i18n: await pseudoInstance(),
      language: 'pseudo',
    });
    await screen.findByRole('heading', { level: 1 });

    return container;
  };

  it('shows nothing that did not come from the catalogue', async () => {
    const unmarked = textNodes(await mount()).filter(
      (text) => !isPseudoLocalised(text) && !NOT_A_SENTENCE.test(text) && !PROPER_NOUNS.has(text),
    );

    expect(unmarked).toEqual([]);
  });

  /**
   * CONTROL: the walker has to find text at all, and it has to be *this* screen's text.
   *
   * The first version of this file mounted `<App/>` directly with no session, so the guard sent the
   * `/dashboard` case to the sign-in screen and both cases asserted about the same page — green,
   * and blind to every string in the shell. It was caught by planting a hardcoded sentence in the
   * topbar and watching the suite stay green, which is the only way that class of mistake ever
   * surfaces.
   */
  it('CONTROL: is looking at the screen it names', async () => {
    const container = await mount();
    const marked = textNodes(container).filter(isPseudoLocalised);

    expect(marked.length).toBeGreaterThan(3);
    expect(container.querySelector('header') !== null).toBe(status === 'authenticated');
  });
});
