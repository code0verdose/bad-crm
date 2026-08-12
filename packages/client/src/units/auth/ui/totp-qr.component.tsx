import { Code, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { qrImageSource } from '@units/auth/lib';

import classes from './totp-qr.module.css';

export interface TotpQrProps {
  /** The base32 secret, shown as text — see below for why this is not an optional extra. */
  readonly secret: string;
  /** The QR as an inline SVG document, exactly as `POST /auth/2fa/setup` answered it. */
  readonly qrSvg: string;
}

/**
 * The QR code **and** the secret written out, always both.
 *
 * The text is not a fallback for the picture, it is the other half of the same instruction. A
 * desktop browser has no camera to scan its own screen with; a hardware authenticator has no camera
 * at all; a screen-reader user cannot be handed a picture and told to point a phone at it; and a
 * password manager takes the string. STORY-013-01 acceptance 10 asks for exactly this, and the
 * contract carries the same sentence on the `secret` field.
 *
 * It is therefore also the QR's text alternative in the accessibility sense (`rules/a11y.mdc` §22):
 * the `alt` says what the picture is and points at the string, and the string is the content.
 *
 * The picture is an `<img>` with a `data:` source rather than an inlined SVG document, and that is
 * not a preference either — `qr-image-source.util.ts` explains at length why `innerHTML` throws in
 * this application.
 */
export function TotpQr({ secret, qrSvg }: TotpQrProps) {
  const { t } = useTranslation();

  return (
    <Stack align="center" gap="sm">
      <img alt={t('security.totp.qr.alt')} className={classes['code']} src={qrImageSource(qrSvg)} />
      <Text size="sm">{t('security.totp.secret.hint')}</Text>
      <Code className={classes['secret']}>{secret}</Code>
    </Stack>
  );
}
