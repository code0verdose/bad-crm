import {
  type EmployeeDirectoryRepositoryPort,
  type OrgChartNode,
} from '@/application/iam/ports/employee-directory-repository.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';

export interface GetOrgChartInput {
  readonly actor: Actor;
}

/**
 * Who reports to whom, as flat nodes.
 *
 * **Flat, and the tree is built by whoever draws it.** The answer is the whole organization, so
 * every node is in it and the shape is a rendering decision rather than a storage one; nesting it
 * here would put the same information behind a recursive schema that no other caller wants.
 *
 * **One query, whatever the size of the company.** The chart is `managerId` on every row, read once
 * — not a walk that asks for the reports of each node it finds, which is the N+1 the acceptance
 * criterion of STORY-012-04 names and `employee-directory-repository.test.ts` counts.
 *
 * No capability check in this body: `employee:view_org_chart` is checked by the guard, the answer is
 * the whole tenant, and the tenant is the scope.
 *
 * Names only. A chart is a picture of the structure, and putting hiring dates or capacity on it
 * would hand the employment half of every record to a permission granted to every role but `guest`.
 */
export class GetOrgChartQuery {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly directory: EmployeeDirectoryRepositoryPort,
  ) {}

  execute(input: GetOrgChartInput): Promise<readonly OrgChartNode[]> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      () => this.directory.orgChart(),
    );
  }
}
