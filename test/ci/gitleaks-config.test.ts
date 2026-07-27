import { describe, expect, it } from 'vitest';

import { readRepoFile } from '../repo/repo-fixture.util.js';

const config = (): string => readRepoFile('.gitleaks.toml');

const entries = (): string[] =>
  config()
    .split(/^\[\[allowlists\]\]$/m)
    .slice(1);

describe('gitleaks configuration', () => {
  /**
   * The default ruleset is the entire value of running gitleaks; this file is allowed to narrow it
   * and never to replace it. A config without `useDefault` detects nothing and reports success.
   */
  it('extends the default ruleset', () => {
    expect(config()).toMatch(/\[extend\]\s+useDefault\s*=\s*true/);
  });

  /**
   * Measured on 2026-07-27 with gitleaks 8.30.1, on a scratch repository carrying this config: a
   * `paths` key in a global `[[allowlists]]` block makes gitleaks skip the whole file before any
   * rule runs — `condition = "AND"` does not scope it to the accompanying value pattern. A planted
   * 40-character secret was reported in a neighbouring file and not in the listed ones.
   *
   * Three of the four paths this config used to list are test suites *about* secret handling.
   * Excluding them is the one thing the file must never do, and nothing but this assertion notices
   * when a `paths` line comes back.
   */
  it('scopes every allowlist by value, never by path', () => {
    for (const entry of entries()) {
      expect(
        entry,
        `an allowlist with paths excludes the whole file:\n${entry.trim()}`,
      ).not.toMatch(/^\s*paths\s*=/m);
    }
  });

  it('gives every allowlist a value pattern and a description', () => {
    expect(entries().length).toBeGreaterThan(0);
    for (const entry of entries()) {
      expect(entry, entry.trim()).toMatch(/^\s*regexes\s*=/m);
      expect(entry, entry.trim()).toMatch(/^\s*description\s*=/m);
    }
  });

  /**
   * A config that quotes the values it exempts is a config that leaks them — and gitleaks scans its
   * own configuration like any other tracked file. Every pattern here describes the shape of a
   * fixture; none of them is a fixture.
   */
  it('never contains a long high-entropy literal of its own', () => {
    for (const literal of config().matchAll(/'''(.+?)'''/gs)) {
      expect(literal[1], literal[1]).not.toMatch(/[A-Za-z0-9+/]{32,}/);
    }
  });
});
