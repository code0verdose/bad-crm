import clsx from 'clsx';
import { Fragment, type ReactNode } from 'react';

import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { Icon } from '@/shared/ui/icon.component.js';

import classes from './invariant-visual.module.css';

/**
 * A figure per invariant: rows filtered by tenant, a permission matrix, a secret going in and
 * ciphertext coming out, one box you own.
 *
 * Indexed rather than named for the same reason the domain previews are — the four invariants are a
 * list the dictionary owns, and a name here would be a second place to keep in step. Every word in
 * them comes from the dictionary too: "yours", "hidden" and "5 containers" written into the markup
 * are English words that show up unchanged inside the Russian page.
 */
export const InvariantVisual = ({ index }: { index: number }) => {
  const { copy } = useLocale();
  const visual = copy.invariants.visual;

  const visuals: ReactNode[] = [
    // Multi-tenancy — three rows, one of them yours.
    <Fragment key="tenancy">
      {[
        { id: `org_7f2 · ${visual.tenantOwn}`, own: true },
        { id: `org_a91 · ${visual.tenantHidden}`, own: false },
        { id: `org_c04 · ${visual.tenantHidden}`, own: false },
      ].map((row) => (
        <span key={row.id} className={clsx(classes['row'], row.own && classes['rowOwn'])}>
          {row.id}
          <span className={classes['rowTag']}>
            {row.own ? <Icon name="check" className={classes['rowIcon']} /> : null}
          </span>
        </span>
      ))}
    </Fragment>,
    // Permissions — a role × action matrix, mostly off.
    <span className={classes['matrix']} key="matrix">
      {Array.from({ length: 16 }, (_unused, index) => (
        <span
          key={index}
          className={clsx(
            classes['cell'],
            [0, 1, 4, 6, 9, 12].includes(index) && classes['cellOn'],
          )}
        />
      ))}
    </span>,
    // End-to-end encryption — in clear, out as noise.
    <Fragment key="e2ee">
      <span className={classes['row']} key="plain">
        {visual.plaintext}
      </span>
      <span className={classes['arrow']} key="arrow">
        XChaCha20-Poly1305
      </span>
      <span className={classes['cipher']} key="cipher">
        qT9c1Lm2xR8vP0aZ7nK4wE6yB3sH5jD1gF8uC2oI9tX4
      </span>
    </Fragment>,
    // Self-hosting — one machine, running.
    <span className={classes['host']} key="host">
      <span className={classes['box']}>
        <Icon name="server" className={classes['boxIcon']} />
      </span>
      <span className={classes['hostLines']}>
        <span>{visual.hostName}</span>
        <span>
          <span className={classes['pulse']} /> {visual.hostContainers}
        </span>
        <span>{visual.hostOutbound}</span>
      </span>
    </span>,
  ];

  return (
    <div className={classes['visual']} aria-hidden="true">
      {visuals[index % visuals.length]}
    </div>
  );
};
