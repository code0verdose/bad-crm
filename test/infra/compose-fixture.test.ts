import { describe, expect, it } from 'vitest';

import {
  alwaysOnServices,
  composeServices,
  environmentOf,
  healthcheckCommandOf,
  hostInterfaceOf,
  imageMajorOf,
  namedVolumesOf,
  publishedPortOf,
  splitPortMapping,
  type ComposeFile,
  type ComposeService,
} from './compose-fixture.util.js';

/**
 * The helpers under test are what every assertion in `compose.test.ts` is built on: if
 * `hostInterfaceOf` returns `undefined` for a mapping that *does* pin an interface, the test that
 * forbids exposing Postgres on `0.0.0.0` passes on a compose file that exposes it. A silently
 * wrong fixture is worse than a missing test, because it reads as a green gate.
 *
 * Both Compose syntaxes are covered on purpose. `docker-compose.yml` happens to use the short one
 * today, so the long-syntax branches are exercised nowhere else — and the day someone rewrites a
 * port mapping in long syntax, these helpers have to already work.
 */
describe('healthcheckCommandOf', () => {
  it.each([
    [
      'array form',
      { healthcheck: { test: ['CMD-SHELL', 'pg_isready -U app'] } },
      'CMD-SHELL pg_isready -U app',
    ],
    ['bare string form', { healthcheck: { test: 'redis-cli ping' } }, 'redis-cli ping'],
    ['no test key', { healthcheck: {} }, ''],
    ['no healthcheck at all', {}, ''],
  ])('flattens the %s', (_name, service: ComposeService, expected) => {
    expect(healthcheckCommandOf(service)).toBe(expected);
  });
});

describe('imageMajorOf', () => {
  it.each([
    ['redis:8.8.1-alpine', 8],
    ['pgvector/pgvector:pg16', Number.NaN],
    ['getmeili/meilisearch:v1.24.0', 1],
  ])('reads the major of %s', (image, expected) => {
    expect(imageMajorOf({ image })).toBe(expected);
  });

  it('is NaN when no image is declared, rather than silently 0', () => {
    expect(imageMajorOf({})).toBe(Number.NaN);
  });
});

describe('environmentOf', () => {
  it('passes the map form through', () => {
    expect(environmentOf({ environment: { POSTGRES_DB: 'bad_crm' } })).toEqual({
      POSTGRES_DB: 'bad_crm',
    });
  });

  it('normalises the list form, keeping "=" inside the value', () => {
    expect(environmentOf({ environment: ['POSTGRES_DB=bad_crm', 'DSN=a=b', 'BARE'] })).toEqual({
      POSTGRES_DB: 'bad_crm',
      DSN: 'a=b',
      BARE: '',
    });
  });

  it('is an empty map when the service declares no environment', () => {
    expect(environmentOf({})).toEqual({});
  });
});

describe('splitPortMapping', () => {
  it('treats a ${VAR:-default} interpolation as one atom, colon and all', () => {
    expect(splitPortMapping('127.0.0.1:${POSTGRES_PORT:-5432}:5432')).toEqual([
      '127.0.0.1',
      '${POSTGRES_PORT:-5432}',
      '5432',
    ]);
  });

  it('splits a plain mapping', () => {
    expect(splitPortMapping('5432:5432')).toEqual(['5432', '5432']);
  });
});

describe('hostInterfaceOf', () => {
  it.each([
    ['127.0.0.1:5432:5432', '127.0.0.1'],
    ['127.0.0.1:${POSTGRES_PORT:-5432}:5432', '127.0.0.1'],
  ])('reads the pinned interface out of %s', (mapping, expected) => {
    expect(hostInterfaceOf(mapping)).toBe(expected);
  });

  it.each(['5432:5432', '5432'])(
    'reports no interface for %s, which binds to every one of them',
    (mapping) => {
      expect(hostInterfaceOf(mapping)).toBeUndefined();
    },
  );

  it('reads host_ip from the long syntax', () => {
    expect(hostInterfaceOf({ host_ip: '127.0.0.1', published: 5432, target: 5432 })).toBe(
      '127.0.0.1',
    );
  });
});

describe('publishedPortOf', () => {
  it.each([
    ['127.0.0.1:5432:5432', '5432'],
    ['15432:5432', '15432'],
    ['5432', '5432'],
  ])('reads the host-side port out of %s', (mapping, expected) => {
    expect(publishedPortOf(mapping)).toBe(expected);
  });

  it('stringifies the long syntax, whichever type the YAML produced', () => {
    expect(publishedPortOf({ published: 5432, target: 5432 })).toBe('5432');
    expect(publishedPortOf({ published: '5432', target: 5432 })).toBe('5432');
  });

  it('reports nothing when the long syntax publishes no host port', () => {
    expect(publishedPortOf({ target: 5432 })).toBeUndefined();
  });
});

describe('namedVolumesOf', () => {
  it('keeps named volumes and drops bind mounts, relative and absolute alike', () => {
    expect(
      namedVolumesOf({
        volumes: [
          'pgdata:/var/lib/postgresql/data',
          './initdb:/docker-entrypoint-initdb.d',
          '/tmp:/tmp',
        ],
      }),
    ).toEqual(['pgdata']);
  });

  it('is empty when the service mounts nothing', () => {
    expect(namedVolumesOf({})).toEqual([]);
  });
});

describe('composeServices and alwaysOnServices', () => {
  const compose: ComposeFile = {
    services: {
      postgres: {},
      redis: {},
      meilisearch: { profiles: ['default'] },
    },
  };

  it('lists services in declaration order', () => {
    expect(composeServices(compose).map(([name]) => name)).toEqual([
      'postgres',
      'redis',
      'meilisearch',
    ]);
  });

  it('treats "declares no profile" as the minimal set, since Compose cannot exclude', () => {
    expect(alwaysOnServices(compose)).toEqual(['postgres', 'redis']);
  });

  it('survives a compose file with no services key', () => {
    expect(composeServices({} as ComposeFile)).toEqual([]);
  });
});
