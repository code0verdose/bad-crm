import { type ProjectListViewer } from '@/application/project/ports/project-list-query.port.js';
import { type ProjectStatus } from '@/domain/project/project.enums.js';

/**
 * One project as the header's switcher shows it — identity and colour, nothing else
 * (STORY-014-06, acceptance 9: «id, key, name, color, status»). No lead, no member count, no
 * visibility: the switcher is asked on every open, and a row that needs a subquery per project is
 * the full card the acceptance keeps it from pulling.
 */
export interface ProjectOption {
  readonly projectId: string;
  readonly key: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly color: string;
}

/**
 * What the switcher narrows by, on top of the visible set.
 *
 * `ids` is the «recently visited» half: the client remembers ids in the browser, and the server
 * answers which of them this caller can still see — an id of a project they lost, or never had, is
 * simply absent (acceptance 5, «из последних посещённых он вычищается»). `null` means «no id
 * filter», an empty array means «none of them», and the two are kept apart for that reason.
 */
export interface ProjectOptionsFilter {
  /** Trimmed; empty means «no text filter». Matched against the name and the key. */
  readonly query: string;
  /** Never empty: the query decides whether the archive is in. */
  readonly statuses: readonly ProjectStatus[];
  readonly ids: readonly string[] | null;
  /** Rows to return at most; ordered by name, then id. */
  readonly limit: number;
}

/**
 * The switcher's read model — a `*-query.port.ts` in the sense of `rules/hexagonal-backend.mdc` 6.
 *
 * **The same visible set as the list, not a second one.** The viewer carries the plan
 * `visible-projects.policy.ts` computed from the caller's organization node, exactly as
 * `ProjectListQueryPort` does, and the adapter that implements both restates it with one shared SQL
 * prefix. A separate port rather than a third method on the list's: the list's callers and doubles
 * need not learn about a surface they do not serve.
 */
export interface ProjectOptionsQueryPort {
  options(
    viewer: ProjectListViewer,
    filter: ProjectOptionsFilter,
  ): Promise<readonly ProjectOption[]>;
}
