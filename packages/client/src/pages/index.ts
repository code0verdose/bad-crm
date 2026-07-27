/**
 * Pages are components, not segmented slices, so this barrel re-exports them by name rather than
 * as namespaces: `import { HomePage } from '@pages'`. The routes that mount them land with
 * TanStack Router (STORY-004-05).
 */
export * from './home/index.js';
