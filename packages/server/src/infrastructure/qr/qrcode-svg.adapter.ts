import QRCode from 'qrcode';

import { type QrCodePort } from '@/application/identity/ports/qr-code.port.js';

/**
 * `qrcode` (pure JS, no native bindings), asked for its `svg` renderer.
 *
 * `errorCorrectionLevel: 'M'` — the library's own default and the level every authenticator app's
 * scanner is tested against; `otpauth://` URIs are short enough that a higher level buys nothing but
 * a denser image.
 */
export class QrcodeSvgAdapter implements QrCodePort {
  async renderSvg(uri: string): Promise<string> {
    return QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M' });
  }
}
