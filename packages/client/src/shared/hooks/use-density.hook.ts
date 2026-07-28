import { useLocalStorage } from '@mantine/hooks';

/**
 * `comfortable` everywhere by default; `compact` for the dense surfaces — timesheet, audit, tables
 * (`ux-architecture.md` → «Плотность»).
 */
export const DENSITIES = ['comfortable', 'compact'] as const;

export type Density = (typeof DENSITIES)[number];

export const DENSITY_LABEL_KEY: Record<Density, string> = {
  comfortable: 'common.appearance.density.comfortable',
  compact: 'common.appearance.density.compact',
};

/** The attribute the shell puts on its root; `tokens.css` keys `--bc-row-height` off it. */
export const DENSITY_ATTRIBUTE = 'data-bc-density';

const STORAGE_KEY = 'bc-density';

export interface DensityControl {
  readonly density: Density;
  readonly setDensity: (value: Density) => void;
}

/**
 * Density is a preference, so it outlives the tab.
 *
 * `getInitialValueInEffect: false` on purpose: the default is to read storage *after* mount, which
 * renders one frame at the wrong density and then reflows every row on the screen. Reading
 * synchronously costs one localStorage access at startup and removes the jump. This is a
 * preference, not a credential — the ban on web storage covers tokens (`rules/security.mdc`), and
 * a row height is neither secret nor authoritative.
 */
export const useDensity = (): DensityControl => {
  const [density, setDensity] = useLocalStorage<Density>({
    key: STORAGE_KEY,
    defaultValue: 'comfortable',
    getInitialValueInEffect: false,
  });

  return { density, setDensity };
};
