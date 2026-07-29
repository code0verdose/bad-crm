/**
 * The user agent, as a sentence a person can recognise their own laptop in.
 *
 * Derived on the way *out* rather than stored, which is what `SessionSummary.device` in
 * `docs/api/openapi.yaml` promises: improving the parser then improves the rows that already exist,
 * and the column keeps the original string for the day somebody has to debug one.
 *
 * Deliberately no library and no remote service. A user-agent database is a dependency that has to
 * be updated forever to keep answering a question whose only consumer is a human glancing at a list
 * — and sending the string to a third party would hand a fingerprint of every employee's machine to
 * somebody outside the installation. The parse is intentionally coarse: browser family and
 * platform, nothing that identifies a build.
 */

/** The value shown when the agent is absent or unreadable — never a fragment of the raw string. */
export const UNKNOWN_DEVICE = 'Unknown device';

/**
 * Ordered, because user agents lie by inheritance: every Chromium browser claims `Safari`, Edge
 * claims `Chrome`, and Chrome claims `Mozilla`. The first match wins, so the most specific token
 * has to be asked about first.
 */
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bYaBrowser\//, 'Yandex Browser'],
  [/\bVivaldi\//, 'Vivaldi'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

const PLATFORMS: readonly (readonly [RegExp, string])[] = [
  // Before the Linux entry: an Android agent also says `Linux`.
  [/\bAndroid\b/, 'Android'],
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bWindows NT\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bLinux\b|\bX11\b/, 'Linux'],
];

const firstMatch = (
  agent: string,
  table: readonly (readonly [RegExp, string])[],
): string | undefined => table.find(([pattern]) => pattern.test(agent))?.[1];

export const describeDevice = (userAgent: string): string => {
  const agent = userAgent.trim();

  if (agent === '') return UNKNOWN_DEVICE;

  const browser = firstMatch(agent, BROWSERS);
  const platform = firstMatch(agent, PLATFORMS);

  if (browser !== undefined && platform !== undefined) return `${browser} on ${platform}`;

  // One half is still worth showing — "Firefox" or "on Windows" narrows the list of candidates a
  // person is looking at. Nothing at all is answered with the stated constant rather than with the
  // raw agent, which is a fingerprint and not a sentence.
  return browser ?? (platform === undefined ? UNKNOWN_DEVICE : `Unknown browser on ${platform}`);
};
