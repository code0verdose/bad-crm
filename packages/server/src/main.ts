/**
 * Entry point of the API process.
 *
 * Still thin by design — the startup sequence lives in
 * `infrastructure/bootstrap/api-process.factory.ts`, where it has injectable seams and is therefore
 * covered by tests. What cannot live there is the **order** below, and it is the whole reason this
 * file grew past three lines.
 *
 * OpenTelemetry instruments `http`, `express`, Prisma and `ioredis` by patching them **as they are
 * imported**. A static import of the process factory pulls all four in before any of our code runs,
 * so an SDK started inside it would patch nothing and produce a trace with no spans in it — quiet,
 * plausible and wrong. Hence: parse the environment (a module that imports none of those), start
 * the SDK, and only then reach for the application through a dynamic import.
 *
 * The parsed environment is handed to `startApiProcess` rather than parsed again, so the process
 * still reads its configuration exactly once.
 */
import { APP_INFO } from '@/app-info.constant.js';
import { loadEnv } from '@/infrastructure/bootstrap/load-env.util.js';
import { startTracing } from '@/infrastructure/tracing/tracing.factory.js';

const env = loadEnv();

startTracing({
  endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  environment: env.NODE_ENV,
  version: APP_INFO.version,
  ...(env.OTEL_TRACES_SAMPLER_ARG === undefined
    ? {}
    : { sampleRatio: env.OTEL_TRACES_SAMPLER_ARG }),
});

const { startApiProcess } = await import('@/infrastructure/bootstrap/api-process.factory.js');

await startApiProcess({ loadEnvironment: () => env });
