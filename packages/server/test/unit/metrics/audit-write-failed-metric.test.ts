import { describe, expect, it } from 'vitest';

import {
  type AuditEvent,
  type AuditLoggerPort,
} from '../../../src/application/platform/ports/audit-logger.port.js';
import { countedAuditLogger } from '../../../src/infrastructure/metrics/counted-audit-logger.adapter.js';
import { createPromMetrics } from '../../../src/infrastructure/metrics/prom-client.adapter.js';

const EVENT: AuditEvent = {
  action: 'session.signed_in',
  actor: { userId: 'user-1', organizationId: 'org-1', ipAddress: undefined },
  target: { type: 'USER', id: 'user-1' },
  requestId: 'req-1',
};

const writing = (record: AuditLoggerPort['record']): AuditLoggerPort => ({ record });

const countOf = (rendered: string): string | undefined =>
  rendered.split('\n').find((line) => line.startsWith('audit_write_failed_total '));

/**
 * `audit_write_failed_total` — STORY-016-02, acceptance 9.
 *
 * Today a failed insert brings the whole transaction down, which is the right answer for a
 * `warning` or a `critical`: an action nobody could write down did not happen. What is missing is
 * that the operator learns of it only through the request that failed, and a request that failed
 * looks like every other one in the RED set. This counter is the difference between «the trail is
 * broken» and «somebody complained».
 *
 * The decorator counts and **rethrows**. The one thing this suite must not let through is a version
 * that reports the failure and swallows it — that would turn fail-closed into fail-open by way of
 * an improvement in observability.
 */
describe('the counted audit logger', () => {
  it('counts a write that failed', async () => {
    const metrics = createPromMetrics();
    const audit = countedAuditLogger(
      writing(() => Promise.reject(new Error('deadlock detected'))),
      metrics,
    );

    await expect(audit.record(EVENT)).rejects.toThrow('deadlock detected');
    expect(countOf(await metrics.render())).toBe('audit_write_failed_total 1');
  });

  /**
   * The property the metric must not cost. `rejects.toThrow` above already fails if the rejection is
   * swallowed, but it would still pass for a decorator that replaced the cause with one of its own —
   * and the cause is what an operator needs to know whether the table is gone or the row was bad.
   */
  it('rethrows the original failure unchanged, so the caller still fails closed', async () => {
    const cause = new Error('relation "audit_logs" does not exist');
    const audit = countedAuditLogger(
      writing(() => Promise.reject(cause)),
      createPromMetrics(),
    );

    await expect(audit.record(EVENT)).rejects.toBe(cause);
  });

  it('adds up repeated failures', async () => {
    const metrics = createPromMetrics();
    const audit = countedAuditLogger(
      writing(() => Promise.reject(new Error('deadlock detected'))),
      metrics,
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(audit.record(EVENT)).rejects.toThrow();
    }

    expect(countOf(await metrics.render())).toBe('audit_write_failed_total 3');
  });

  /**
   * CONTROL: a successful write is passed through and counted nowhere. Without this the suite is
   * satisfied by a decorator that increments unconditionally, and the alert on it would fire on a
   * healthy installation from the first sign-in.
   */
  it('CONTROL: passes a successful write through and counts nothing', async () => {
    const metrics = createPromMetrics();
    const written: AuditEvent[] = [];
    const audit = countedAuditLogger(
      writing((event) => {
        written.push(event);

        return Promise.resolve();
      }),
      metrics,
    );

    await audit.record(EVENT);

    expect(written).toEqual([EVENT]);
    expect(countOf(await metrics.render())).toBe('audit_write_failed_total 0');
  });

  /**
   * CONTROL: no labels. The tempting one is the action, and it is exactly the wrong one — the
   * catalogue grows with every epic, so the series count grows with it, and the question the metric
   * answers («is the trail writing at all») needs none of them. Which event failed is in the log
   * line the caller's own failure produces.
   */
  it('CONTROL: publishes one unlabelled series', async () => {
    const metrics = createPromMetrics();
    const audit = countedAuditLogger(
      writing(() => Promise.reject(new Error('deadlock detected'))),
      metrics,
    );

    await expect(audit.record(EVENT)).rejects.toThrow();

    const series = (await metrics.render())
      .split('\n')
      .filter((line) => line.startsWith('audit_write_failed_total'))
      .filter((line) => !line.startsWith('audit_write_failed_total{'));

    expect(series).toEqual(['audit_write_failed_total 1']);
  });
});
