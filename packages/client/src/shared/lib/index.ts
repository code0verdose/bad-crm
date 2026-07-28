/**
 * Framework-free helpers of the `shared` layer: the query-key registry and the ports the data layer
 * announces through. Nothing here knows about a domain — that is what `units/**` is for
 * (`rules/frontend-fsd.mdc`, rule 8).
 */
export * from './enums/index.js';
export * from './notifications/index.js';
