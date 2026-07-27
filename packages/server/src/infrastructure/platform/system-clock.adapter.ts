import { type ClockPort } from '@/application/platform/ports/clock.port.js';

/**
 * `ClockPort` on the platform clock.
 *
 * The only place in the server allowed to read the wall clock, which is what lets every use-case
 * above it be tested with a fixed instant instead of a tolerance window.
 */
export class SystemClockAdapter implements ClockPort {
  now(): Date {
    return new Date();
  }
}
