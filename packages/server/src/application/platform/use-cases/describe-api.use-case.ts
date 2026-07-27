import { type ClockPort } from '@/application/platform/ports/clock.port.js';

export interface ApiDescription {
  /** The version segment the caller reached this API through — `v1`. */
  readonly apiVersion: string;
  readonly serverTime: Date;
}

/**
 * What this API is, for a client that just discovered it.
 *
 * It is the first product operation under `/api/v1` and deliberately the smallest one: the value it
 * carries is the *contract* — an operation that exists in `docs/api/openapi.yaml`, has a route, a
 * validator, a serializer and a registry entry, so the bidirectional contract test of STORY-003-07
 * has something to compare in both directions and every later endpoint is a copy of a proven shape.
 *
 * `serverTime` is not decoration: a client that renders relative timestamps or decides whether a
 * token is about to expire needs the server's clock, not the laptop's. It is read through
 * `ClockPort` for the same reason `CheckHealthUseCase` does — a use-case that calls the platform
 * clock directly cannot be tested without freezing global time.
 *
 * `apiVersion` is injected rather than hard-coded here: the version is a property of the transport
 * (the URL prefix), and the composition root is the layer that owns it. This use-case only reports
 * what it was wired with.
 */
export class DescribeApiUseCase {
  constructor(
    private readonly clock: ClockPort,
    private readonly apiVersion: string,
  ) {}

  execute(): Promise<ApiDescription> {
    return Promise.resolve({ apiVersion: this.apiVersion, serverTime: this.clock.now() });
  }
}
