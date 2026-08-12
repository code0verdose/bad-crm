import { describe, expect, it } from 'vitest';

import { qrImageSource } from './qr-image-source.util.js';

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#000" width="1" height="1"/></svg>';

describe('the QR code as an image source', () => {
  it('is an SVG data URI carrying the document the server drew', () => {
    const source = qrImageSource(SVG);

    expect(source.startsWith('data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(source.slice('data:image/svg+xml,'.length))).toBe(SVG);
  });

  /**
   * The characters that would end the attribute early, or start a new one.
   *
   * An SVG dropped into `src` unescaped is a quote away from being markup again — and this string
   * arrives from the network. Percent-encoding is what makes «the server's document» stay a value.
   */
  it('escapes what would otherwise close the attribute', () => {
    const source = qrImageSource('<svg data-x="a b&c"></svg>');

    expect(source).not.toContain('"');
    expect(source).not.toContain('<');
    expect(source).not.toContain('&');
  });

  /**
   * The document itself is never touched, only wrapped.
   *
   * Whether the *alternative* — putting the SVG through `dangerouslySetInnerHTML` — is even
   * available is asserted where the QR is actually rendered (`test/widgets/totp-setup.test.tsx`),
   * against the Trusted Types policy that refuses it: a unit may not import from `app`, and the
   * question is about the screen rather than about this function.
   */
  it('leaves the document intact — decoding gives back exactly what was passed', () => {
    const painted = '<svg><path d="M0 0h1v1H0z"/></svg>';

    expect(decodeURIComponent(qrImageSource(painted).split(',')[1] ?? '')).toBe(painted);
  });
});
