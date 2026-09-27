import { apiClient, unwrapApiResult, type components } from '@shared/api';

/** What the header's switcher reads (`GET /projects/options`). */
export type ProjectOptionList = components['schemas']['ProjectOptionList'];

/** One project as the switcher offers it — id, key, name, status, colour, nothing else. */
export type ProjectOption = components['schemas']['ProjectOption'];

/**
 * What the switcher asks. Every field is present, because the object is also the query key and a
 * key is hashed as JSON.
 */
export interface ProjectOptionsParams {
  /** Trimmed; empty for «no text filter». */
  readonly q: string;
  readonly archived: boolean;
  /** Remembered ids, most recent first — at most five, as the contract allows. */
  readonly recent: readonly string[];
}

/**
 * The projects this caller can switch to, and which of the remembered recent ids they may still
 * open (STORY-014-06). An empty `q` is left out rather than sent empty, like every optional filter
 * of this unit. The signal is required: this is a query, and a query is always cancellable.
 */
export const fetchProjectOptions = async (
  params: ProjectOptionsParams,
  signal: AbortSignal,
): Promise<ProjectOptionList> =>
  unwrapApiResult(
    await apiClient.GET('/projects/options', {
      params: {
        query: {
          ...(params.q === '' ? {} : { q: params.q }),
          archived: params.archived,
          recent: [...params.recent],
        },
      },
      signal,
    }),
  );
