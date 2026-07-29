import { describe, expect, it } from 'vitest';

import { createMailer } from '@/infrastructure/mail/mail.factory.js';
import { NodemailerMailAdapter } from '@/infrastructure/mail/nodemailer.adapter.js';
import { UnconfiguredMailAdapter } from '@/infrastructure/mail/unconfigured-mail.adapter.js';

import { recordedValues, recordingLogger } from '../rate-limit/recording-logger.util.js';
import { FakeMailTransport } from './fake-mail-transport.util.js';

const MAIL = {
  to: 'ada.lovelace@example.com',
  subject: 'Reset your Bad CRM password',
  text: 'Open https://crm.example.com/reset-password/9f2c8a1e0b to choose a new password.',
} as const;

const MAIL_FROM = 'Bad CRM <crm@example.com>';

describe('mail factory', () => {
  it('builds an SMTP mailer when the installation has a transport', async () => {
    const { logger } = recordingLogger();

    const mailer = createMailer({
      smtpUrl: 'smtp://localhost:1025',
      mailFrom: MAIL_FROM,
      logger,
    });

    expect(mailer.isConfigured()).toBe(true);
    await mailer.close();
  });

  it('builds the unconfigured mailer when SMTP_URL is absent', async () => {
    const { logger } = recordingLogger();

    const mailer = createMailer({ smtpUrl: undefined, mailFrom: undefined, logger });

    expect(mailer).toBeInstanceOf(UnconfiguredMailAdapter);
    expect(mailer.isConfigured()).toBe(false);
    await mailer.close();
  });
});

/**
 * The absence of `SMTP_URL` is not a delivery failure — it is the absence of a subsystem, and the
 * caller has to be able to answer `mail_not_configured` (503) rather than pretend the mail went out
 * (STORY-006-08). `isConfigured()` performs no I/O for the same reason: the operation checks it
 * *before* resolving an address, so that the answer of `POST /auth/forgot-password` stays identical
 * for a registered address and an unknown one.
 */
describe('unconfigured mailer', () => {
  it('says so instead of reporting a delivery', async () => {
    const { logger } = recordingLogger();
    const mailer = new UnconfiguredMailAdapter(logger);

    expect(mailer.isConfigured()).toBe(false);
    expect(await mailer.send(MAIL)).toEqual({ status: 'not_configured' });
  });

  it('warns the operator that a mail was wanted, and quotes nothing from it', async () => {
    const { logger, lines } = recordingLogger();

    await new UnconfiguredMailAdapter(logger).send(MAIL);
    const written = recordedValues(lines);

    expect(lines.some((line) => line.level === 'warn')).toBe(true);
    expect(written).toContain('SMTP_URL');
    expect(written).not.toContain('ada.lovelace@example.com');
    expect(written).not.toContain('Reset your Bad CRM password');
    expect(written).not.toContain('9f2c8a1e0b');
  });

  it('closes without anything to close', async () => {
    const { logger } = recordingLogger();

    await expect(new UnconfiguredMailAdapter(logger).close()).resolves.toBeUndefined();
  });
});

/**
 * The envelope sender.
 *
 * Mailpit accepts a message with an empty `MAIL FROM`, which is why the integration suite was green
 * while no installation with a real relay could have sent a single letter: Postfix, SES and every
 * relay that checks the envelope answer 5.x. The mapping made it worse — `EENVELOPE` was reported as
 * `recipient_rejected`, so an operator debugging a missing password-reset mail would go and look at
 * the recipient's address.
 *
 * It is configuration, not content: the adapter carries it and `OutgoingMail` does not, because
 * choosing which mailbox an installation sends from is not a decision any use-case makes.
 */
describe('the envelope sender', () => {
  it('is put on every message the SMTP adapter sends', async () => {
    const { logger } = recordingLogger();
    const transport = new FakeMailTransport();

    await new NodemailerMailAdapter(transport, logger, MAIL_FROM).send(MAIL);

    expect(transport.sent[0]).toMatchObject({ from: MAIL_FROM, to: MAIL.to });
  });

  it('reaches the adapter the factory builds', async () => {
    const { logger } = recordingLogger();

    const mailer = createMailer({
      smtpUrl: 'smtp://localhost:1025',
      mailFrom: MAIL_FROM,
      logger,
    });

    expect(mailer.isConfigured()).toBe(true);
    await mailer.close();
  });

  /**
   * Disabled, not refused — and the distinction is the whole point of this test.
   *
   * This assertion used to be `toThrow(/MAIL_FROM/)`, on the stated grounds that `loadEnv` made
   * `MAIL_FROM` required whenever `SMTP_URL` was set, so the throw was unreachable anyway. That
   * requirement was then deliberately removed from `env.schema.ts`: a variable that becomes
   * required in one release does not let an existing installation start, and `SMTP_URL` has been in
   * `.env.example` since EPIC-001 while `MAIL_FROM` is new. The removal made the throw the *first*
   * thing an upgraded installation hits — `buildContainer` runs before any degradation is printed —
   * so the process exited before opening the port, and the `warn` branch in `env-features.util.ts`
   * became unreachable code. `CHANGELOG.md` and `docs/runbooks/upgrade.md` promised a warning.
   *
   * So the rule the project already committed to — release N warns, release N+1 refuses — is
   * implemented here: no sender means no transport, the installation boots, password reset answers
   * as it does on an installation with no mail at all, and the operator is told at `warn` before
   * the port opens. The refusal moves to the release that mounts mail in the container.
   */
  it('disables mail rather than refusing to start when the sender is missing', async () => {
    const { logger } = recordingLogger();

    const mailer = createMailer({
      smtpUrl: 'smtp://localhost:1025',
      mailFrom: undefined,
      logger,
    });

    expect(
      await mailer.send({ to: 'ada@example.com', subject: 's', text: 't', html: '<p>t</p>' }),
    ).toEqual({ status: 'not_configured' });
  });

  /**
   * The sender is not content, so it does not go to the log either: it is the one address in the
   * message that is *not* personal data, but a line quoting it teaches the next reader that
   * addresses belong in log lines.
   */
  it('is not written to the log', async () => {
    const { logger, lines } = recordingLogger();

    await new NodemailerMailAdapter(new FakeMailTransport(), logger, MAIL_FROM).send(MAIL);

    expect(recordedValues(lines)).not.toContain(MAIL_FROM);
  });
});
