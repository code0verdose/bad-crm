import { z } from 'zod';

/** EN and RU are equal first-class languages of the product (ADR-0019). */
export const LOCALES = ['en', 'ru'] as const;

export const localeSchema = z.enum(LOCALES, { error: 'validation.locale.unsupported' });

export type Locale = (typeof LOCALES)[number];

/** Fallback used when a subject has no locale of its own and the organization sets none. */
export const DEFAULT_LOCALE: Locale = 'en';
