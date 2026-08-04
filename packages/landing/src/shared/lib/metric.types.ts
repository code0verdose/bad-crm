/**
 * A tile in the cost/telemetry bento.
 *
 * One claim and one line under it — the earlier shape had a number, a label and a detail, which read
 * as two headings stacked on top of each other and made every tile taller than it needed to be.
 *
 * Two kinds, because two of the six claims are not numbers: "no seat limit" written as a literal
 * zero read as a rendering bug rather than as a claim.
 */
export type MetricItem =
  | {
      kind: 'number';
      value: number;
      prefix: string;
      suffix: string;
      caption: string;
    }
  | {
      kind: 'text';
      headline: string;
      caption: string;
    };
