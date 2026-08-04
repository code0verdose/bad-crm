import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { PrismaInstrumentation } from '@prisma/instrumentation';

/** Everything in development; a tenth in production, where the collector is paid for. */
export const DEFAULT_DEV_SAMPLE_RATIO = 1;
export const DEFAULT_PRODUCTION_SAMPLE_RATIO = 0.1;

export interface SampleRatioInput {
  readonly environment: string;
  readonly configured: number | undefined;
}

/**
 * How much to keep, with a typo treated as a typo.
 *
 * A ratio outside `[0, 1]` is almost always `10` meaning «ten percent». Clamped rather than thrown:
 * refusing to start an installation over a sampling rate would be a worse outcome than sampling
 * everything for a while, and the setting has an obvious safe reading.
 */
export const resolveSampleRatio = ({ environment, configured }: SampleRatioInput): number => {
  if (configured !== undefined) return Math.min(1, Math.max(0, configured));

  return environment === 'production' ? DEFAULT_PRODUCTION_SAMPLE_RATIO : DEFAULT_DEV_SAMPLE_RATIO;
};

export interface TracingInput {
  readonly endpoint: string | undefined;
  readonly environment: string;
  readonly version: string;
  readonly sampleRatio?: number;
}

/**
 * Starts the SDK, or does nothing at all.
 *
 * **Nothing at all is the default, and it is not the same as «started and idle».** The
 * instrumentations patch `http`, `express`, Prisma and `ioredis` at import time, a span is held per
 * request, and the exporter opens a connection to a collector. An installation with no
 * `OTEL_EXPORTER_OTLP_ENDPOINT` asked for none of that, and this function returning `undefined` is
 * how it gets none of it (`docs/architecture/stack.md`, «Деградация при отсутствии опционального
 * сервиса»).
 *
 * The instrumentations are listed rather than taken from `auto-instrumentations-node`: the bundle
 * pulls in forty packages to patch libraries this server does not use, and every one of them is a
 * supply-chain surface for a subsystem that is off by default.
 *
 * `ParentBasedSampler` so a decision made upstream is honoured: a request already being traced by a
 * gateway must not lose its child spans to a local coin flip, and one that was not sampled must not
 * gain a fragment here.
 *
 * An unreachable collector is deliberately not handled here. The exporter retries and logs through
 * the OTel diagnostics channel; a failure to export must never reach the request that produced the
 * span, which is why nothing here awaits it.
 */
export const startTracing = (input: TracingInput): NodeSDK | undefined => {
  if (input.endpoint === undefined || input.endpoint.trim() === '') return undefined;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: '@bad-crm/server',
      [ATTR_SERVICE_VERSION]: input.version,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${input.endpoint}/v1/traces` }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(
        resolveSampleRatio({ environment: input.environment, configured: input.sampleRatio }),
      ),
    }),
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      new PrismaInstrumentation(),
      new IORedisInstrumentation(),
    ],
  });

  sdk.start();

  return sdk;
};
