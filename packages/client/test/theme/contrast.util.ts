/**
 * WCAG 2.1 relative luminance and contrast ratio, over opaque sRGB hex colours.
 *
 * Test-only on purpose: nothing in the application computes a contrast ratio at runtime, so a
 * copy of this under `src/**` would be code that only its own test executes.
 */

const CHANNEL = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i;

/** `#fff` → `#ffffff`. Mantine writes `theme.white` in the short form, and both are the same colour. */
const expand = (hex: string): string =>
  /^#[\da-f]{3}$/i.test(hex)
    ? `#${[...hex.slice(1)].map((channel) => `${channel}${channel}`).join('')}`
    : hex;

/** sRGB → linear, the transfer function of WCAG 2.1 «relative luminance». */
const linearise = (channel: number): number => {
  const value = channel / 255;

  return value <= 0.040_45 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

export const relativeLuminance = (hex: string): number => {
  const match = CHANNEL.exec(expand(hex.trim()));

  if (match === null) {
    throw new Error(`not an opaque 6-digit hex colour: ${hex}`);
  }

  const [red, green, blue] = match.slice(1, 4).map((part) => linearise(Number.parseInt(part, 16)));

  return 0.2126 * (red as number) + 0.7152 * (green as number) + 0.0722 * (blue as number);
};

/** Contrast ratio of two opaque colours, 1 (identical) to 21 (black on white). */
export const contrastRatio = (foreground: string, background: string): number => {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);

  return (lighter + 0.05) / (darker + 0.05);
};

/** Rounded down to two decimals, so a failure message reports what was measured, not a float. */
export const roundRatio = (ratio: number): number => Math.floor(ratio * 100) / 100;
