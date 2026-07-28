import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The build-time switch that decides whether the TanStack Query devtools exist at all, on both of
 * its settings.
 *
 * Nothing is imported statically on purpose. A module evaluates its condition once, at import;
 * observing the other answer means importing it again behind a mock, and every module that goes
 * with it — the renderer included — has to come from the same registry afterwards.
 *
 * What is asserted is the switch and the mount, not the panel's own markup:
 * `@tanstack/react-query-devtools` exports a component that returns `null` unless
 * `process.env.NODE_ENV` is `development`, so under Vitest there is nothing on screen to look for
 * either way. `size-limit` in `pnpm --filter @bad-crm/client build` is what proves the production
 * bundle carries none of it; this is what proves the tree does not either.
 */

afterEach(() => {
  vi.doUnmock('@shared/config');
  vi.resetModules();
});

const loadAppModules = async () => {
  const [testingLibrary, providers, devtools, vendor, shared] = await Promise.all([
    import('@testing-library/react'),
    import('@app/providers.js'),
    import('@app/query-devtools.component.js'),
    import('@tanstack/react-query-devtools'),
    import('@shared'),
  ]);

  return {
    ...testingLibrary,
    Providers: providers.Providers,
    QueryDevtools: devtools.QueryDevtools,
    ReactQueryDevtools: vendor.ReactQueryDevtools,
    queryClient: shared.SharedApi.createAppQueryClient({
      notify: shared.SharedUi.notify,
      logError: vi.fn(),
    }),
  };
};

describe('the query devtools', () => {
  it('do not exist in the build everyone but a developer runs', async () => {
    const { render, screen, Providers, QueryDevtools, queryClient } = await loadAppModules();

    expect(QueryDevtools).toBeNull();

    render(
      <Providers queryClient={queryClient}>
        <p>content</p>
      </Providers>,
    );

    await screen.findByText('content');
    expect(screen.queryByRole('button', { name: /devtools/i })).not.toBeInTheDocument();
  });

  it('are the vendor panel itself when the bundle is the dev server one', async () => {
    vi.doMock('@shared/config', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@shared/config')>()),
      IS_DEV_SERVER: true,
    }));

    const { render, screen, Providers, QueryDevtools, ReactQueryDevtools, queryClient } =
      await loadAppModules();

    expect(QueryDevtools).toBe(ReactQueryDevtools);

    // Mounted inside the cache it inspects, and the render is the assertion: the panel reads the
    // query client from context, so a devtools mounted outside `QueryClientProvider` throws here.
    render(
      <Providers queryClient={queryClient}>
        <p>content</p>
      </Providers>,
    );

    expect(await screen.findByText('content')).toBeInTheDocument();
  });
});
