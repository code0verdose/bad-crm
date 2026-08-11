import { Table } from '@mantine/core';
import { memo } from 'react';
import { type SharedPermissions } from '@bad-crm/shared';
import { useTranslation } from 'react-i18next';

import { IamModel, type IamTypes } from '@units/iam';

import { PermissionRow } from './permission-row.component.js';

/** Permission · effect · source · exception — the columns this group spans in its heading. */
const COLUMN_COUNT = 4;

export interface PermissionDomainGroupProps {
  readonly domain: SharedPermissions.PermissionDomain;
  readonly rows: readonly IamTypes.PermissionRow[];
  readonly canWrite: boolean;
  readonly isOwner: boolean;
  readonly isSaving: boolean;
  readonly now: Date;
  readonly onChoose: (permission: string, choice: IamModel.PermissionChoice) => void;
}

/**
 * One domain of the catalogue as a block of rows, under a heading that spans the table.
 *
 * `scope="colgroup"` rather than a styled row: a screen reader then reads «Vault» before every row
 * beneath it, which on a table of three hundred keys is the difference between a list of names and
 * a structure. The same shape the roles matrix uses next door, minus the collapse control — that
 * one exists because the matrix is three hundred rows *wide* as well; this table is four columns,
 * and the search box above it is the narrowing anybody actually reaches for.
 */
function PermissionDomainRows({
  domain,
  rows,
  canWrite,
  isOwner,
  isSaving,
  now,
  onChoose,
}: PermissionDomainGroupProps) {
  const { t } = useTranslation();

  return (
    <>
      <Table.Tr>
        <Table.Th colSpan={COLUMN_COUNT} scope="colgroup">
          {`${t(IamModel.PERMISSION_DOMAIN_LABEL_KEY[domain])} (${String(rows.length)})`}
        </Table.Th>
      </Table.Tr>

      {rows.map((row) => (
        <PermissionRow
          canWrite={canWrite}
          isOwner={isOwner}
          isSaving={isSaving}
          key={row.key}
          now={now}
          onChoose={onChoose}
          row={row}
        />
      ))}
    </>
  );
}

export const PermissionDomainGroup = memo(PermissionDomainRows);
