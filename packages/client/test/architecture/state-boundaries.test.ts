/**
 * @vitest-environment node
 *
 * Правило 16 `rules/frontend-fsd.mdc` — таблица «где живёт какое состояние» — как проверка, а не
 * как абзац. Ни одно из четырёх нарушений ниже не ломает сборку и не роняет тест:
 *
 *   * стор со **серверными** данными выглядит рабочим ровно до первой инвалидации, которая его не
 *     касается: экран показывает вчерашнее, пока кто-нибудь не перезагрузит вкладку;
 *   * `create()` вместо `createStore()` даёт хук там, где гард `beforeLoad` читает состояние вне
 *     React, — и обнаруживается это на первом гарде, а не на сборке;
 *   * `*.store.ts` вне `service/stores` и `zustand`, импортированный из виджета, — начало
 *     глобального стора, который правило 16 запрещает именно потому, что он схлопывает слои.
 *
 * Каждый детектор сначала прогоняется по фикстурам, и только потом — по дереву: проверка, которая
 * никогда не срабатывала, проходит и на пустом списке файлов.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

const sourceFiles = (directory: string = SRC): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;

    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) return [];

    return [path];
  });

const relative = (path: string): string => path.slice(SRC.length + 1);

/**
 * Комментарии вырезаны: они объясняют запреты и называют их словами. Файл, объясняющий, почему
 * `create()` здесь не годится, не должен становиться нарушением из-за собственного объяснения.
 */
const codeOf = (path: string): string =>
  readFileSync(path, 'utf8')
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/\/\/.*$/gm, '');

/** Файл стора: `units/<unit>/service/stores/<name>.store.ts` и нигде больше. */
const isStoreFile = (path: string): boolean => /\.store\.tsx?$/.test(path);
const isInStoresSegment = (path: string): boolean =>
  /^units\/[^/]+\/service\/stores\/[^/]+\.store\.ts$/.test(path);

/**
 * Where `zustand` may be named at all: the store that creates one, and the hook that subscribes to
 * it. Both live in the `service` segment of a unit, which is what the call chain
 * `ui → service/hooks → …` already says — a widget importing `useStore` would be reaching past the
 * unit's public API to its state.
 */
const isInServiceSegment = (path: string): boolean => /^units\/[^/]+\/service\//.test(path);

const IMPORTS_ZUSTAND = /from\s+'zustand(?:\/[\w/-]+)?'/;
const IMPORTS_QUERY = /from\s+'@tanstack\/react-query'/;
/** `create(` из корня zustand — хук-фабрика; гарду `beforeLoad` нужен `createStore` из vanilla. */
const REACT_STORE_FACTORY = /\bcreate\s*[(<]/;
/** Ручная подписка: её делает `useStore`, и делает правильнее. */
const MANUAL_EXTERNAL_STORE = /\buseSyncExternalStore\b/;

describe('детекторы (CONTROL — без этого блока проверки ниже проходят на пустом множестве)', () => {
  it.each([
    ['стор в юните', 'units/auth/service/stores/auth-session.store.ts', true],
    ['стор в виджете', 'widgets/app-shell/sidebar.store.ts', false],
    ['стор в shared', 'shared/lib/theme.store.ts', false],
    ['стор в хуках юнита', 'units/auth/service/hooks/session.store.ts', false],
  ])('%s → %s', (_case, path, expected) => {
    expect(isStoreFile(path) && isInStoresSegment(path)).toBe(expected);
  });

  it.each([
    ['стор юнита', 'units/auth/service/stores/auth-session.store.ts', true],
    ['хук юнита', 'units/auth/service/hooks/use-bootstrap-session.hook.ts', true],
    ['виджет', 'widgets/app-shell/app-shell.widget.tsx', false],
    ['страница', 'pages/dashboard/page.tsx', false],
    ['shared', 'shared/ui/toaster.tsx', false],
  ])('zustand разрешён в «%s» → %s', (_case, path, expected) => {
    expect(isInServiceSegment(path)).toBe(expected);
  });

  it.each([
    ["импорт из 'zustand'", "import { useStore } from 'zustand';", true],
    ["импорт из 'zustand/vanilla'", "import { createStore } from 'zustand/vanilla';", true],
    [
      "импорт из 'zustand/react/shallow'",
      "import { useShallow } from 'zustand/react/shallow';",
      true,
    ],
    ['посторонний импорт', "import { useStore } from '@units/auth';", false],
  ])('%s → %s', (_case, source, expected) => {
    expect(IMPORTS_ZUSTAND.test(source)).toBe(expected);
  });

  it.each([
    ['create из корня', 'const s = create<T>()((set) => ({}));', true],
    ['createStore из vanilla', 'const s = createStore<T>((set) => ({}));', false],
  ])('%s → %s', (_case, source, expected) => {
    expect(REACT_STORE_FACTORY.test(source.replace(/createStore/g, ''))).toBe(expected);
  });
});

describe('границы клиентского состояния', () => {
  const files = sourceFiles();

  it('в дереве есть что проверять', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  /**
   * Пол, без которого весь файл — зелёная галочка ни над чем. Если сторов в дереве не осталось,
   * проверки ниже проходят, ничего не проверив: правило 16 обещает поймать нарушение, а ловить
   * будет нечего.
   */
  it('в дереве есть хотя бы один стор', () => {
    expect(files.map(relative).filter(isStoreFile)).not.toEqual([]);
  });

  it('держит каждый стор в `units/*/service/stores`', () => {
    const offenders = files
      .map(relative)
      .filter(isStoreFile)
      .filter((path) => !isInStoresSegment(path));

    expect(offenders, 'стор — сегмент юнита; глобального стора нет — правило 16').toEqual([]);
  });

  it('не пускает zustand за пределы `service` своего юнита', () => {
    const offenders = files
      .filter((path) => IMPORTS_ZUSTAND.test(codeOf(path)))
      .map(relative)
      .filter((path) => !isInServiceSegment(path));

    expect(
      offenders,
      'стор создаёт `service/stores`, подписывает `service/hooks`; виджет берёт хук — правило 16',
    ).toEqual([]);
  });

  it('не пускает серверные данные в стор', () => {
    const offenders = files
      .map(relative)
      .filter(isStoreFile)
      .filter((path) => IMPORTS_QUERY.test(codeOf(`${SRC}/${path}`)));

    expect(
      offenders,
      'данные из нашего API живут в TanStack Query и больше нигде — правило 16',
    ).toEqual([]);
  });

  it('создаёт сторы через `createStore`, а не через `create`', () => {
    const offenders = files
      .map(relative)
      .filter(isStoreFile)
      .filter((path) =>
        REACT_STORE_FACTORY.test(codeOf(`${SRC}/${path}`).replaceAll('createStore', '')),
      );

    expect(
      offenders,
      '`beforeLoad` читает стор вне React: нужен vanilla-стор, а не хук-фабрика — правило 16',
    ).toEqual([]);
  });

  it('не оставляет ручных подписок на внешний стор', () => {
    const offenders = files
      .filter((path) => MANUAL_EXTERNAL_STORE.test(codeOf(path)))
      .map(relative);

    expect(offenders, 'подписку делает `useStore` из zustand — правило 16').toEqual([]);
  });
});
