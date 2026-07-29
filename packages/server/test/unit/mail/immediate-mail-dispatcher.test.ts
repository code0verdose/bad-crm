import { describe, expect, it } from 'vitest';

import {
  type MailDelivery,
  type MailPort,
  type OutgoingMail,
} from '@/application/platform/ports/mail.port.js';
import { SECURITY_EVENTS } from '@/domain/identity/security-event.constant.js';
import { ImmediateMailDispatcher } from '@/infrastructure/mail/immediate-mail-dispatcher.adapter.js';

import { recordedValues, recordingLogger } from '../rate-limit/recording-logger.util.js';

/**
 * The stand-in for the outbox queue, held to the three things it exists to guarantee.
 *
 * It returns before the transport is touched — which is what keeps
 * `POST /auth/forgot-password` from timing differently for a registered address; it never lets a
 * failure escape, because it runs after the caller has committed; and it writes nothing about the
 * message it was handed, because that message carries a single-use reset token inside a link.
 */

const MAIL: OutgoingMail = {
  to: 'ada@example.com',
  subject: 'Reset your Bad CRM password',
  text: 'Open https://crm.example.com/reset-password/9f2c8a1e0b',
  html: '<p>Open <a href="https://crm.example.com/reset-password/9f2c8a1e0b">this link</a>.</p>',
};

const CONTEXT = {
  event: SECURITY_EVENTS.passwordResetRequested,
  organizationId: '018f4a3b-0000-7000-8000-000000000001',
  userId: '018f4a3b-0000-7000-8000-0000000000bb',
} as const;

/**
 * A transport whose send can be resolved by the test, so "returned before it finished" is testable.
 *
 * `{ throws }` and not "an `Error` means throw": the dispatcher has to survive an adapter that
 * rejects with something that is not an `Error` at all, and a class that decided by `instanceof`
 * could not express that case.
 */
type DeferredOutcome = MailDelivery | { readonly throws: unknown };

const isThrowing = (outcome: DeferredOutcome): outcome is { readonly throws: unknown } =>
  'throws' in outcome;

class DeferredMail implements MailPort {
  readonly sent: OutgoingMail[] = [];

  /** One per in-flight send, so two messages are two waits rather than one that overwrote the other. */
  private readonly pending: (() => void)[] = [];

  constructor(private readonly outcome: DeferredOutcome) {}

  isConfigured(): boolean {
    return true;
  }

  async send(mail: OutgoingMail): Promise<MailDelivery> {
    this.sent.push(mail);

    await new Promise<void>((resolve) => this.pending.push(resolve));

    if (isThrowing(this.outcome)) throw this.outcome.throws;

    return this.outcome;
  }

  finish(): void {
    for (const resolve of this.pending.splice(0)) resolve();
  }
}

describe('handing a message to the dispatcher', () => {
  it('returns before the transport has finished, and drain waits for it', async () => {
    const transport = new DeferredMail({ status: 'sent', messageId: '<1@example.test>' });
    const { logger, lines } = recordingLogger();
    const dispatcher = new ImmediateMailDispatcher(transport, logger);

    dispatcher.dispatch(MAIL, CONTEXT);

    // Synchronously after `dispatch`: nothing has been recorded, so nothing was awaited.
    expect(lines).toEqual([]);

    transport.finish();
    await dispatcher.drain();

    expect(transport.sent).toEqual([MAIL]);
    expect(lines).toHaveLength(1);
  });

  it('drains to nothing when nothing was handed over', async () => {
    const transport = new DeferredMail({ status: 'sent', messageId: '<1@example.test>' });
    const { logger } = recordingLogger();

    await expect(new ImmediateMailDispatcher(transport, logger).drain()).resolves.toBeUndefined();
  });

  it('records the delivery with the identifiers and nothing from the message', async () => {
    const transport = new DeferredMail({ status: 'sent', messageId: '<1@example.test>' });
    const { logger, lines } = recordingLogger();
    const dispatcher = new ImmediateMailDispatcher(transport, logger);

    dispatcher.dispatch(MAIL, CONTEXT);
    transport.finish();
    await dispatcher.drain();

    const written = recordedValues(lines);

    expect(lines[0]).toMatchObject({
      level: 'info',
      fields: { ...CONTEXT, delivery: 'sent' },
    });
    expect(written).not.toContain('ada@example.com');
    expect(written).not.toContain('9f2c8a1e0b');
    expect(written).not.toContain('Reset your Bad CRM password');
  });

  it('records a transport that refused the message at error, without letting it escape', async () => {
    const transport = new DeferredMail({ status: 'failed', failure: 'connection' });
    const { logger, lines } = recordingLogger();
    const dispatcher = new ImmediateMailDispatcher(transport, logger);

    dispatcher.dispatch(MAIL, CONTEXT);
    transport.finish();

    await expect(dispatcher.drain()).resolves.toBeUndefined();
    expect(lines[0]).toMatchObject({
      level: 'error',
      fields: { ...CONTEXT, delivery: 'failed', failure: 'connection' },
    });
  });

  /**
   * `not_configured` is **warn**, not error, and the difference is what an operator does with it.
   *
   * It used to be an error, on the reasoning that every caller asks `isConfigured()` first, so
   * reaching this branch was a defect. That stopped being true when `change-password` was allowed
   * to proceed without a transport: on a `minimal` installation, every password change now arrives
   * here. An error per password change on a supported configuration is an alert that gets muted,
   * and muting it is how the *real* failures below stop being read. It is a documented degradation
   * with one actionable half — `SMTP_URL` — and the message says so.
   */
  it('records a message that had no transport at warn, naming the variable to set', async () => {
    const transport = new DeferredMail({ status: 'not_configured' });
    const { logger, lines } = recordingLogger();
    const dispatcher = new ImmediateMailDispatcher(transport, logger);

    dispatcher.dispatch(MAIL, CONTEXT);
    transport.finish();

    await expect(dispatcher.drain()).resolves.toBeUndefined();
    expect(lines[0]).toMatchObject({
      level: 'warn',
      fields: { ...CONTEXT, delivery: 'not_configured' },
    });
    expect(lines[0]?.message).toContain('SMTP_URL');
  });

  /**
   * The failure that would otherwise take the process down: `dispatch` returns `void`, so a
   * rejection has nobody to catch it and Node's default is to exit. It runs after the caller has
   * committed, so there is nothing to undo either — only something to write down.
   */
  it('absorbs a transport that raises instead of answering', async () => {
    const transport = new DeferredMail({ throws: new Error('socket hang up') });
    const { logger, lines } = recordingLogger();
    const dispatcher = new ImmediateMailDispatcher(transport, logger);

    dispatcher.dispatch(MAIL, CONTEXT);
    transport.finish();

    await expect(dispatcher.drain()).resolves.toBeUndefined();
    expect(lines[0]).toMatchObject({ level: 'error', fields: { delivery: 'failed' } });
    expect(recordedValues(lines)).not.toContain('9f2c8a1e0b');
  });

  /**
   * The raised error itself is **not** a field of that line, and the difference is invisible to
   * `recordedValues`: an `Error` has no enumerable properties, so `JSON.stringify` renders it as
   * `{}` and every "nothing leaked" assertion above passes over it. pino does not — its `err`
   * serializer writes `message` and `stack` — and the message of an SMTP error is written by the
   * remote relay, which quotes the envelope back: `550 5.1.1 <ada@example.com>: Recipient address
   * rejected`. `NodemailerMailAdapter` never hands one over, which is why this went unnoticed; the
   * second adapter is the one that would.
   *
   * What is kept is the class of the thrown value, which is bounded, actionable and says the one
   * thing worth saying here — an adapter broke its contract by throwing at all.
   */
  it('names the class of what was thrown and keeps the error itself out of the line', async () => {
    const rejection = new TypeError('550 5.1.1 <ada@example.com>: Recipient address rejected');
    const transport = new DeferredMail({ throws: rejection });
    const { logger, lines } = recordingLogger();
    const dispatcher = new ImmediateMailDispatcher(transport, logger);

    dispatcher.dispatch(MAIL, CONTEXT);
    transport.finish();
    await dispatcher.drain();

    const fields = lines[0]?.fields ?? {};
    // The replacer is the point: without it an `Error` serializes to `{}` and this assertion is
    // vacuous, which is exactly how the field survived the suite it was already in.
    const written = JSON.stringify(fields, (_key, value: unknown) =>
      value instanceof Error ? { name: value.name, message: value.message } : value,
    );

    expect(fields).toMatchObject({ delivery: 'failed', errorName: 'TypeError' });
    expect(written).not.toContain('ada@example.com');
    expect(Object.values(fields).some((value) => value instanceof Error)).toBe(false);
  });

  it('records a value that is not an Error at all without asking it for a name', async () => {
    const transport = new DeferredMail({ throws: 'not an error' });
    const { logger, lines } = recordingLogger();
    const dispatcher = new ImmediateMailDispatcher(transport, logger);

    dispatcher.dispatch(MAIL, CONTEXT);
    transport.finish();
    await dispatcher.drain();

    expect(lines[0]).toMatchObject({ level: 'error', fields: { errorName: 'string' } });
  });

  it('waits for every message handed over, not only for the first', async () => {
    const transport = new DeferredMail({ status: 'sent', messageId: '<1@example.test>' });
    const { logger, lines } = recordingLogger();
    const dispatcher = new ImmediateMailDispatcher(transport, logger);

    dispatcher.dispatch(MAIL, CONTEXT);
    dispatcher.dispatch({ ...MAIL, to: 'grace@example.com' }, CONTEXT);
    transport.finish();
    await dispatcher.drain();

    expect(transport.sent).toHaveLength(2);
    expect(lines).toHaveLength(2);
  });
});
