/**
 * WCAG 2.1 relative luminance and contrast ratio, over opaque sRGB hex colours.
 *
 * A copy of `packages/client/test/theme/contrast.util.ts` rather than an import: the landing package
 * is a leaf by construction — `eslint.config.js` forbids it from importing any workspace package, so
 * that the marketing page can never drag application code into its bundle. The formula is WCAG's and
 * does not drift; what would drift is a shared package created only to hold thirty lines.
 */

const CHANNEL = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i;

const linearise = (channel: number): number => {
  const value = channel / 255;

  return value <= 0.040_45 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

export const relativeLuminance = (hex: string): number => {
  const match = CHANNEL.exec(hex.trim());

  if (match === null) throw new Error(`not an opaque 6-digit hex colour: ${hex}`);

  const [red, green, blue] = match.slice(1, 4).map((part) => linearise(Number.parseInt(part, 16)));

  return 0.2126 * (red as number) + 0.7152 * (green as number) + 0.0722 * (blue as number);
};

/** Contrast ratio of two opaque colours, 1 (identical) to 21 (black on white). */
export const contrastRatio = (foreground: string, background: string): number => {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);

  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

/** Rounded down, so a failure reports what was measured rather than a float. */
export const roundRatio = (ratio: number): number => Math.floor(ratio * 100) / 100;
