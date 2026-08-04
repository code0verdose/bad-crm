import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { navigate, ROUTES } from '@/shared/lib/use-route.hook.js';
import { SECTION_IDS } from '@/shared/lib/site-links.constant.js';
import { Icon } from '@/shared/ui/icon.component.js';

import classes from './legal.module.css';

/**
 * The three legal pages, rendered from one component.
 *
 * Terms, privacy and cookies differ only in their content, and their content lives in the
 * dictionary like every other string on the site — which is also what keeps them in step across
 * the two languages: a section added to one and forgotten in the other fails `tsc`.
 *
 * They open with the draft warning rather than burying it: the documents carry placeholders where
 * the operator's legal details belong, and no lawyer has read them.
 */
export const LegalPage = ({ document }: { document: 'terms' | 'privacy' | 'cookies' }) => {
  const { copy } = useLocale();
  const doc = copy.legal[document];

  return (
    <main id={SECTION_IDS.main} className={classes['page']}>
      <a
        className={classes['back']}
        href={ROUTES.home}
        onClick={(event) => {
          event.preventDefault();
          navigate(ROUTES.home);
        }}
      >
        <Icon name="arrowLeft" className={classes['backIcon']} />
        {copy.legal.back}
      </a>

      <h1 className={classes['title']}>{doc.title}</h1>
      <span className={classes['updated']}>
        {copy.legal.updatedLabel}: {doc.updated}
      </span>

      <p className={classes['notice']}>{copy.legal.draftNotice}</p>
      <p className={classes['intro']}>{doc.intro}</p>

      {doc.sections.map((section) => (
        <section key={section.heading} className={classes['section']}>
          <h2 className={classes['heading']}>{section.heading}</h2>
          {section.body.map((paragraph) => (
            <p key={paragraph} className={classes['paragraph']}>
              {paragraph}
            </p>
          ))}
        </section>
      ))}
    </main>
  );
};
