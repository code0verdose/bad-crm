import { createAuthMiddleware, createSessionRefresher, type ApiMiddleware } from '@shared/api';
import { clientEnv } from '@shared/config';

import { emitAuthEvent } from './auth-event-bus.util.js';
import { clearAccessToken, readAccessToken, setAccessToken } from './auth-token-storage.util.js';

/**
 * Binds the transport in `shared/api` to the session this unit owns.
 *
 * The split is the FSD boundary doing its job: `shared/api` knows *how* to refresh and replay and
 * nothing about who we are; this unit knows where the token lives and who has to be told when the
 * session ends; `app/` knows what to do about it — subscribe to the bus and navigate. Nothing here
 * imports a router, which is why every one of these paths is testable without mounting one.
 *
 * Installed once by the composition root: `apiClient.use(AuthLib.createSessionAuthMiddleware())`.
 */
export const createSessionAuthMiddleware = (): ApiMiddleware => {
  const refresh = createSessionRefresher({ baseUrl: clientEnv.VITE_API_BASE_URL });

  return createAuthMiddleware({
    readAccessToken,

    refreshSession: async () => {
      const token = await refresh();

      if (token === null) {
        emitAuthEvent('refresh-failed');

        return null;
      }

      setAccessToken(token);

      return token;
    },

    onSessionLost: () => {
      clearAccessToken();
      emitAuthEvent('logged-out');
    },
  });
};
