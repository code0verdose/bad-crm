import { CookieBanner } from '@/widgets/cookie-banner.widget.js';
import { ScrollProgress } from '@/widgets/scroll-progress.widget.js';
import { SiteFooter } from '@/widgets/site-footer.widget.js';
import { SiteHeader } from '@/widgets/site-header.widget.js';

import { Page } from './page.js';
import { Providers } from './providers.js';

/**
 * The composition root: providers, the chrome that stays put, and the page itself.
 *
 * The split exists so that `Page` can read the locale — it remounts the sections when the language
 * changes, and that has to happen *inside* the provider that owns the language.
 */
export const App = () => (
  <Providers>
    <ScrollProgress />
    <SiteHeader />
    <Page />
    <SiteFooter />
    <CookieBanner />
  </Providers>
);
