import { apiClient } from './http.client.js';
import type { components } from './schemas/api-schema.js';

export type ClientErrorReport = components['schemas']['ClientErrorReport'];

/**
 * Sends a browser failure to the installation's own server, and nowhere else.
 *
 * A self-hosted product does not phone home: there is no third-party collector, by decision
 * (`epics/epic-009-observability/epic.md`, «Вне скоупа»). The endpoint is the same origin the
 * application already talks to.
 *
 * The shape is `components['schemas']['ClientErrorReport']` from the generated contract, so a field
 * the specification does not declare cannot be sent by accident — which is the property that makes
 * «the report carries no user content» checkable rather than remembered.
 */
export const sendClientErrorReport = async (report: ClientErrorReport): Promise<void> => {
  await apiClient.POST('/telemetry/client-error', { body: report });
};
