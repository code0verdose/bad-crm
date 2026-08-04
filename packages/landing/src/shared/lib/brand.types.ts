/**
 * The glyphs `brand-mark.component.tsx` can draw.
 *
 * Declared here rather than beside the component because the dictionaries name them: a tool in the
 * "cancel the stack" band and a technology in the stack band each carry the key of their mark, and
 * a typo there should be a compile error rather than a blank space on the page.
 */
export type BrandName =
  | 'jira'
  | 'notion'
  | 'obsidian'
  | 'slack'
  | 'onepassword'
  | 'toggl'
  | 'sheet'
  | 'postgres'
  | 'redis'
  | 'minio'
  | 'meilisearch'
  | 'express'
  | 'prisma'
  | 'react'
  | 'socketio'
  | 'libsodium'
  | 'docker';

/** One entry of a branded list: a display name and the mark drawn beside it. */
export interface BrandedItem {
  name: string;
  brand: BrandName;
}
