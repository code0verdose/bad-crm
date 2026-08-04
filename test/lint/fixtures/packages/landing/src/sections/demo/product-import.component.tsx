/** Deliberately broken: the landing is a leaf — it never imports the product it advertises. */
import { PERMISSIONS } from '@bad-crm/shared';

export function ProductImport() {
  return <div>{String(PERMISSIONS)}</div>;
}
