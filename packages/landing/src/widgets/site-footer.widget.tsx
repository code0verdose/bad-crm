import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { GITHUB_URL, LICENCE_URL } from '@/shared/lib/site-links.constant.js';
import { clearConsent } from '@/shared/lib/consent.util.js';
import { navigate, ROUTES } from '@/shared/lib/use-route.hook.js';

import classes from './site-footer.module.css';

/**
 * The footer carries the sentence the rest of the page does not: this is a prototype of the product
 * page, and the repository is still building the product. A marketing page that speaks in the
 * present tense owes the reader one honest line, and this is it.
 */
export const SiteFooter = () => {
  const { copy } = useLocale();

  return (
    <footer className={classes['footer']}>
      <div className={classes['inner']}>
        <div className={classes['brand']}>
          <span className={classes['name']}>Bad CRM</span>
          <span className={classes['tagline']}>{copy.footer.tagline}</span>
          <a className={classes['licence']} href={LICENCE_URL}>
            {copy.footer.licence}
          </a>
        </div>

        {copy.footer.columns.map((column) => (
          <nav key={column.title} className={classes['column']} aria-label={column.title}>
            <span className={classes['columnTitle']}>{column.title}</span>
            {column.links.map((link) => (
              <a key={link} className={classes['link']} href={GITHUB_URL}>
                {link}
              </a>
            ))}
          </nav>
        ))}

        <nav className={classes['column']} aria-label={copy.footer.legalTitle}>
          <span className={classes['columnTitle']}>{copy.footer.legalTitle}</span>

          {(
            [
              [ROUTES.terms, copy.footer.legalLinks.terms],
              [ROUTES.privacy, copy.footer.legalLinks.privacy],
              [ROUTES.cookies, copy.footer.legalLinks.cookies],
            ] as const
          ).map(([route, label]) => (
            <a
              key={route}
              className={classes['link']}
              href={route}
              onClick={(event) => {
                event.preventDefault();
                navigate(route);
              }}
            >
              {label}
            </a>
          ))}

          {/* Withdrawing consent has to be as easy as giving it: clearing the stored answer brings
              the banner straight back. */}
          <button
            type="button"
            className={classes['link']}
            onClick={() => {
              clearConsent();
              globalThis.location.reload();
            }}
          >
            {copy.footer.legalLinks.manageCookies}
          </button>
        </nav>

        <p className={classes['disclaimer']}>{copy.footer.disclaimer}</p>
      </div>
    </footer>
  );
};
