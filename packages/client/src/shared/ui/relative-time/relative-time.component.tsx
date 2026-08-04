import { useTranslation } from 'react-i18next';

import { formatDateTimeWithZone, formatRelativeTime, resolveTimeZone } from '@shared/lib/format';

export interface RelativeTimeProps {
  /** ISO 8601 in UTC, the way everything is stored and transported (`rules/i18n.mdc` §11). */
  readonly iso: string;
  /** The moment to measure from. A parameter so a test can state one; the caller passes `new Date()`. */
  readonly now: Date;
}

/**
 * «5 минут назад», with the exact moment one hover away.
 *
 * A `<time>` element rather than a `<span>`, and `dateTime` carrying the machine-readable instant:
 * a relative phrase is friendly and lossy, and the element is the place the specification keeps the
 * unambiguous value — for a screen reader, for a browser translating the page, for anything parsing
 * the document.
 *
 * `title` holds the absolute time **with its zone**, which is the pairing that makes a relative
 * phrase safe to show at all: «yesterday» is ambiguous across a team spread over three time zones,
 * and the answer to «yesterday for whom» has to be reachable rather than merely correct.
 */
export function RelativeTime({ iso, now }: RelativeTimeProps) {
  const { i18n } = useTranslation();
  const absolute = formatDateTimeWithZone(iso, i18n.language, resolveTimeZone());

  return (
    <time dateTime={iso} title={absolute}>
      {formatRelativeTime(iso, now, i18n.language)}
    </time>
  );
}
