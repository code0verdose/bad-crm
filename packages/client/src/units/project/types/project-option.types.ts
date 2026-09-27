import { type ProjectStatus } from '@units/project/model/enums/project-status.enums.js';

/**
 * A project as the switcher draws it — structural, so `ui` does not name the contract
 * (`rules/frontend-fsd.mdc` rule 4: `ui` reaches `api` only through `service`). The contract's
 * `ProjectOption` satisfies it at the hook, which is where a drift would show.
 */
export interface ProjectSwitchOption {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly color: string;
}
