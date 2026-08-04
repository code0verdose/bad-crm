import { type BrandName } from '@/shared/lib/brand.types.js';

import { BRAND_GLYPHS } from './brand-glyphs.constant.js';
import classes from './brand-mark.module.css';

/**
 * The mark beside a product name.
 *
 * The paths come from Simple Icons (CC0) — see `brand-glyphs.constant.ts` for the provenance and for
 * the three that had to be drawn by hand. Everything here is presentation: the name is always
 * spelled out next to the mark, so the glyph carries no information of its own and is hidden from
 * assistive technology.
 */
interface BrandMarkProps {
  name: BrandName;
  className?: string | undefined;
}

export const BrandMark = ({ name, className }: BrandMarkProps) => (
  <svg
    viewBox="0 0 24 24"
    className={className ? `${classes['mark']} ${className}` : classes['mark']}
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <path d={BRAND_GLYPHS[name]} />
  </svg>
);
