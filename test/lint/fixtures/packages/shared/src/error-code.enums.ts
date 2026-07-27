export const ERROR_CODES = ['resource_not_found', 'stale_version'] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
