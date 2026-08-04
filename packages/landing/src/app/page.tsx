import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { LegalPage } from '@/pages/legal/legal-page.component.js';
import { Ai } from '@/sections/ai/ai.component.js';
import { Cta } from '@/sections/cta/cta.component.js';
import { Demo } from '@/sections/demo/demo.component.js';
import { Domains } from '@/sections/domains/domains.component.js';
import { E2ee } from '@/sections/e2ee/e2ee.component.js';
import { Graph } from '@/sections/graph/graph.component.js';
import { Hero } from '@/sections/hero/hero.component.js';
import { Invariants } from '@/sections/invariants/invariants.component.js';
import { Metrics } from '@/sections/metrics/metrics.component.js';
import { Replaces } from '@/sections/replaces/replaces.component.js';
import { SelfHost } from '@/sections/self-host/self-host.component.js';
import { Showcase } from '@/sections/showcase/showcase.component.js';
import { Stack } from '@/sections/stack/stack.component.js';
import { SECTION_IDS } from '@/shared/lib/site-links.constant.js';
import { ROUTES, useRoute } from '@/shared/lib/use-route.hook.js';

/**
 * The page, in reading order: what it is, what it looks like, what it replaces, what is inside it,
 * how it holds together, what it refuses to compromise on, proof of the last of those, the numbers,
 * it moving, how you run it, what it is made of, and the ask.
 *
 * **`key={locale}` remounts everything when the language changes, and that is load-bearing.** Half
 * the page reveals itself with `whileInView` and `once: true`, which detaches its observer after
 * the first run; swapping the dictionary in place leaves those elements mounted, hidden, with
 * nothing left to tell them to appear — the reader switches to Russian and the section goes blank.
 * A remount costs a few milliseconds on a static page and makes the whole class of bug impossible,
 * instead of fixing it once per component and waiting for the next one.
 */
export const Page = () => {
  const { locale } = useLocale();
  const route = useRoute();

  if (route === ROUTES.terms) return <LegalPage key={locale} document="terms" />;
  if (route === ROUTES.privacy) return <LegalPage key={locale} document="privacy" />;
  if (route === ROUTES.cookies) return <LegalPage key={locale} document="cookies" />;

  return (
    <main id={SECTION_IDS.main} key={locale}>
      <Hero />
      <Showcase />
      <Replaces />
      <Domains />
      <Graph />
      <Invariants />
      <E2ee />
      <Ai />
      <Metrics />
      <Demo />
      <SelfHost />
      <Stack />
      <Cta />
    </main>
  );
};
