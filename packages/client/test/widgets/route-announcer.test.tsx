import { MantineProvider } from '@mantine/core';
import { RouterContextProvider, createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@app/router.js';
import { SharedApi, SharedUi } from '@shared';
import { RouteAnnouncer } from '@widgets/route-announcer';

/**
 * The announcer on a page that names nothing.
 *
 * Every screen of the application declares a crumb — the not-found splat included, since it names
 * itself after its heading — so the whole-application suites never reach the other branch: no page
 * name, the product name alone in the tab, and a live region that says nothing rather than
 * «undefined». A router that has not matched anything yet is exactly that page.
 */
describe('RouteAnnouncer on a page with no name', () => {
  it('titles the tab with the product alone and announces nothing', async () => {
    const router = createAppRouter(
      {
        queryClient: SharedApi.createAppQueryClient({ notify: SharedUi.notify, logError: vi.fn() }),
        auth: { status: 'authenticated' },
      },
      createMemoryHistory({ initialEntries: ['/dashboard'] }),
    );

    render(
      <MantineProvider env="test">
        <RouterContextProvider router={router}>
          <RouteAnnouncer />
        </RouterContextProvider>
      </MantineProvider>,
    );

    await waitFor(() => {
      expect(document.title).toBe('Bad CRM');
    });
    expect(screen.getByTestId('route-announcer')).toBeEmptyDOMElement();
  });
});
