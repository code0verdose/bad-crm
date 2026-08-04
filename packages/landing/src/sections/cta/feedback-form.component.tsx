import { type FormEvent, useState } from 'react';

import { useLocale } from '@/app/i18n/use-locale.hook.js';

import classes from './feedback-form.module.css';

/** Where the message goes. A real address, so the mail client has something to send to. */
const CONTACT_ADDRESS = 'hello@badcrm.dev';

/**
 * The feedback form, and the honest way to have one on a page with no backend.
 *
 * Submitting composes a `mailto:` and hands it to the operating system — the fields never leave the
 * browser, because there is nothing here to send them to. The alternative would be a third-party
 * form service, which means a request to somebody else's server from a page that spends a whole
 * section explaining that it makes no requests at all. The hint under the button says exactly what
 * pressing it does, rather than letting the reader discover it when their mail client opens.
 *
 * It is also why this is the one place on the landing with a `<form>`: the browser does the
 * validation (`type="email"`, `required`), and the button is a real submit button, so Enter works.
 */
export const FeedbackForm = () => {
  const { copy } = useLocale();
  const [sent, setSent] = useState(false);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    // `FormData.get` is typed as `string | File | null` for the general case; these three controls
    // are inputs, so anything that is not a string is not ours to send.
    const data = new FormData(event.currentTarget);
    const read = (field: string): string => {
      const value = data.get(field);
      return typeof value === 'string' ? value : '';
    };

    const name = read('name');
    const email = read('email');
    const message = read('message');

    const subject = encodeURIComponent(`Bad CRM — ${name || email}`);
    const body = encodeURIComponent(`${message}\n\n— ${name}\n${email}`);
    globalThis.location.href = `mailto:${CONTACT_ADDRESS}?subject=${subject}&body=${body}`;

    setSent(true);
  };

  return (
    <form className={classes['form']} onSubmit={onSubmit}>
      <span className={classes['title']}>{copy.cta.form.title}</span>

      <div className={classes['row']}>
        <label className={classes['field']}>
          <span className={classes['label']}>{copy.cta.form.nameLabel}</span>
          <input
            className={classes['control']}
            name="name"
            type="text"
            autoComplete="name"
            placeholder={copy.cta.form.namePlaceholder}
          />
        </label>

        <label className={classes['field']}>
          <span className={classes['label']}>{copy.cta.form.emailLabel}</span>
          <input
            className={classes['control']}
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder={copy.cta.form.emailPlaceholder}
          />
        </label>
      </div>

      <label className={classes['field']}>
        <span className={classes['label']}>{copy.cta.form.messageLabel}</span>
        <textarea
          className={`${classes['control']} ${classes['message']}`}
          name="message"
          required
          placeholder={copy.cta.form.messagePlaceholder}
        />
      </label>

      <div className={classes['footer']}>
        <span className={classes['hint']}>{copy.cta.form.hint}</span>
        <button type="submit" className={classes['submit']}>
          {copy.cta.form.submit}
        </button>
      </div>

      {sent ? (
        <span className={classes['sent']} role="status">
          {copy.cta.form.sent}
        </span>
      ) : null}
    </form>
  );
};
