import { type Request } from 'express';

import { type SessionClient } from '@/application/identity/use-cases/issue-session.use-case.js';

/**
 * The peer address, as far as the process is allowed to believe it.
 *
 * `req.ip` and not `X-Forwarded-For` read by hand: `trust proxy` is set to exactly one hop in
 * `http-server.factory.ts`, so Express takes the entry the operator's own proxy wrote and ignores
 * whatever a client prepended. The value is masked and hashed before it is stored, and it appears in
 * no log and in no response.
 *
 * Shared by every operation that opens a session — sign-in, registration and accepting an
 * invitation. One definition, because «which header do we believe» is the sort of decision that
 * drifts the moment it exists twice.
 */
export const clientOf = (request: Request): SessionClient => ({
  userAgent: request.headers['user-agent'] ?? '',
  ipAddress: request.ip,
});
