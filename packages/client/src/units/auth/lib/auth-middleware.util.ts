import { createAuthMiddleware, type ApiMiddleware } from '@shared/api';

import { emitAuthEvent } from './auth-event-bus.util.js';
import { clearAccessToken, readAccessToken } from './auth-token-storage.util.js';
import { refreshSession } from './session-refresh.util.js';

/**
 * Binds the transport in `shared/api` to the session this unit owns.
 *
 * The split is the FSD boundary doing its job: `shared/api` knows *how* to refresh and replay and
 * nothing about who we are; this unit knows where the token lives and who has to be told when the
 * session ends; `app/` knows what to do about it — subscribe to the bus and navigate. Nothing here
 * imports a router, which is why every one of these paths is testable without mounting one.
 *
 * The rotation goes through `refreshSession`, the same gate the session bootstrap uses, so a 401
 * arriving while the tab is still restoring its session joins that exchange instead of starting a
 * second one — and the second one is what reuse detection reads as theft. What comes back is an
 * identity, never a token: the token is in memory by then, and `readAccessToken()` is how the
 * middleware picks it up for the replay.
 *
 * Installed once by the composition root: `apiClient.use(AuthLib.createSessionAuthMiddleware())`.
 */
export const createSessionAuthMiddleware = (): ApiMiddleware =>
  createAuthMiddleware({
    readAccessToken,

    refreshSession: async () => {
      const rotation = await refreshSession();

      if (rotation.kind === 'unavailable') return { kind: 'unavailable' };

      if (rotation.kind === 'refused') {
        emitAuthEvent('refresh-failed');

        return { kind: 'refused' };
      }

      // `adoptSession` has already put the token in memory; the middleware reads it from there for
      // the replay. Nothing about it travels through this return value, which is what keeps the
      // token to one home (CLAUDE.md, invariant 3).
      return { kind: 'rotated' };
    },

    onSessionLost: () => {
      clearAccessToken();
      emitAuthEvent('logged-out');
    },
  });
