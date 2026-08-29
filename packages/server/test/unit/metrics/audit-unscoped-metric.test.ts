import { describe, expect, it } from 'vitest';

import {
  type AuditEvent,
  type AuditLoggerPort,
} from '../../../src/application/platform/ports/audit-logger.port.js';
import { countedUnscopedAuditLogger } from '../../../src/infrastructure/metrics/counted-unscoped-audit-logger.adapter.js';
import { createPromMetrics } from '../../../src/infrastructure/metrics/prom-client.adapter.js';

/**
 * `audit_unscoped_total` — the number the degradation never had.
 *
 * An event that has no organization cannot be a row, so it becomes a log line: rotated, unindexed,
 * outside the append-only guarantees of the table. That is legitimate for the actions on
 * `AUDIT_ACTIONS_WITHOUT_ORGANIZATION` and refused for everything else — but «legitimate» is not
 * «invisible». Without a series here, an installation whose trail quietly moved into the log has no
 * way to notice; with one, it is a line on a dashboard and something to alert on.
 *
 * It is deliberately **not** a failure counter. A refusal throws and is already counted by
 * `audit_write_failed_total`; this one counts the events that were allowed to take the other path.
 */
const EVENT: AuditEvent = {
  action: 'rls.bypassed',
  actor: { userId: undefined, organizationId: undefined, ipAddress: undefined },
  target: { type: 'ORGANIZATION', id: undefined },
  requestId: 'maintenance-1',
};

const writing = (record: AuditLoggerPort['record']): AuditLoggerPort => ({ record });

const countOf = (rendered: string): string | undefined =>
  rendered.split('\n').find((line) => line.startsWith('audit_unscoped_total '));

describe('the counted unscoped sink', () => {
  it('counts an event that went to the log instead of the table', async () => {
    const metrics = createPromMetrics();
    const written: AuditEvent[] = [];
    const sink = countedUnscopedAuditLogger(
      writing((event) => {
        written.push(event);

        return Promise.resolve();
      }),
      metrics,
    );

    await sink.record(EVENT);

    expect(written).toEqual([EVENT]);
    expect(countOf(await metrics.render())).toBe('audit_unscoped_total 1');
  });

  it('adds up repeated ones', async () => {
    const metrics = createPromMetrics();
    const sink = countedUnscopedAuditLogger(
      writing(() => Promise.resolve()),
      metrics,
    );

    await sink.record(EVENT);
    await sink.record(EVENT);
    await sink.record(EVENT);

    expect(countOf(await metrics.render())).toBe('audit_unscoped_total 3');
  });

  /**
   * The half that must not be traded away for the metric: the sink may fail, and a failure of it is
   * still a failure of the trail. Counting it here and swallowing it would make the degradation of
   * the degradation silent in turn.
   */
  it('rethrows a failure of the sink unchanged', async () => {
    const cause = new Error('stdout is gone');
    const sink = countedUnscopedAuditLogger(
      writing(() => Promise.reject(cause)),
      createPromMetrics(),
    );

    await expect(sink.record(EVENT)).rejects.toBe(cause);
  });

  /**
   * CONTROL: nothing published until something takes the path. Without this the suite is satisfied
   * by a counter that increments on construction, and an alert on it would fire on an installation
   * whose trail is entirely in the table — which is every installation today.
   */
  it('CONTROL: publishes zero on an installation where nothing degraded', async () => {
    const metrics = createPromMetrics();

    countedUnscopedAuditLogger(
      writing(() => Promise.resolve()),
      metrics,
    );

    expect(countOf(await metrics.render())).toBe('audit_unscoped_total 0');
  });

  /** CONTROL: one unlabelled series, for the reason `audit_write_failed_total` has none either. */
  it('CONTROL: publishes one unlabelled series', async () => {
    const metrics = createPromMetrics();
    const sink = countedUnscopedAuditLogger(
      writing(() => Promise.resolve()),
      metrics,
    );

    await sink.record(EVENT);

    const series = (await metrics.render())
      .split('\n')
      .filter((line) => line.startsWith('audit_unscoped_total'))
      .filter((line) => !line.startsWith('audit_unscoped_total{'));

    expect(series).toEqual(['audit_unscoped_total 1']);
  });
});
