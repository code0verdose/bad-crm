/**
 * Framework-free helpers of the `shared` layer: the query-key registry, the ports the data layer
 * announces through, and the validation primitives every list screen reuses. Nothing here knows
 * about a domain — that is what `units/**` is for (`rules/frontend-fsd.mdc`, rule 8).
 */
export * from './enums/index.js';
export * from './format/index.js';
export * from './notifications/index.js';
export * from './validation/index.js';
