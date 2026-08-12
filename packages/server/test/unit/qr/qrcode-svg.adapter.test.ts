import { describe, expect, it } from 'vitest';

import { QrcodeSvgAdapter } from '@/infrastructure/qr/qrcode-svg.adapter.js';

describe('QrcodeSvgAdapter', () => {
  it('renders an SVG document for an otpauth URI', async () => {
    const adapter = new QrcodeSvgAdapter();

    const svg = await adapter.renderSvg(
      'otpauth://totp/BadCRM:ada%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=BadCRM&algorithm=SHA1&digits=6&period=30',
    );

    expect(svg.trimStart()).toMatch(/^<svg/);
    expect(svg).toContain('</svg>');
  });

  it('renders a different image for a different URI', async () => {
    const adapter = new QrcodeSvgAdapter();

    const first = await adapter.renderSvg('otpauth://totp/BadCRM:a%40example.com?secret=AAAAAAAA');
    const second = await adapter.renderSvg('otpauth://totp/BadCRM:b%40example.com?secret=BBBBBBBB');

    expect(first).not.toBe(second);
  });
});
