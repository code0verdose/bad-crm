import { describe, expect, it } from 'vitest';

import { describeDevice, UNKNOWN_DEVICE } from '@/domain/identity/session-device.util.js';

describe('the device description', () => {
  /**
   * The ordering cases, which is where a naive parser goes wrong: every Chromium browser claims
   * `Safari` in its agent, Edge claims `Chrome`, and an Android agent also says `Linux`.
   */
  it.each([
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0',
      'Firefox on macOS',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Chrome on Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
      'Edge on Windows',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Safari on iOS',
    ],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Chrome on ChromeOS',
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/112.0.0.0',
      'Opera on Linux',
    ],
  ])('reads %s as %s', (agent, expected) => {
    expect(describeDevice(agent)).toBe(expected);
  });

  it('answers with a constant rather than a fragment when the agent says nothing', () => {
    expect(describeDevice('')).toBe(UNKNOWN_DEVICE);
    expect(describeDevice('   ')).toBe(UNKNOWN_DEVICE);
    expect(describeDevice('curl/8.7.1')).toBe(UNKNOWN_DEVICE);
  });

  it('shows the half it could read', () => {
    expect(describeDevice('MyApp/1.0 (Windows NT 10.0)')).toBe('Unknown browser on Windows');
    expect(describeDevice('Firefox/128.0')).toBe('Firefox');
  });

  it('never echoes the raw agent back', () => {
    const agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:1.2.3) Gecko Firefox/128.0';

    expect(describeDevice(agent)).not.toContain('1.2.3');
    expect(describeDevice(agent)).not.toContain('Win64');
  });
});
