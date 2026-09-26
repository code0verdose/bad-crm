import { type ProjectApi, type ProjectLib } from '@units/project';

import { ProjectCard } from './project-card.component.js';
import classes from './project-list-ui.module.css';

export interface ProjectGridProps {
  readonly rows: readonly ProjectLib.ProjectListRow<ProjectApi.ProjectListItem>[];
  /** The accessible name of the list — the same words as the view it is. */
  readonly label: string;
}

/**
 * The page as cards. A `ul` of `li`, so a screen reader announces «list, 24 items» and a reader can
 * jump over it. A plain list laid out by CSS grid rather than `SimpleGrid`: that component is not
 * polymorphic, and a grid of `div`s would lose the list semantics.
 */
export function ProjectGrid({ rows, label }: ProjectGridProps) {
  return (
    <ul aria-label={label} className={classes['grid']}>
      {rows.map((row) => (
        <li key={row.id}>
          <ProjectCard row={row} />
        </li>
      ))}
    </ul>
  );
}
