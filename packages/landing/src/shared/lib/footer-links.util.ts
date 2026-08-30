import {
  CONTRIBUTING_URL,
  GITHUB_URL,
  LICENCE_URL,
  SECTION_IDS,
  SECURITY_POLICY_URL,
} from './site-links.constant.js';

/** A footer link goes either to a section of this page or to a document outside it. */
export type FooterLinkTarget = { readonly section: string } | { readonly href: string };

/**
 * Where each footer link goes, in the order the dictionaries list the labels.
 *
 * The split is deliberate: a label is copy and exists twice, once per language, so it lives in
 * `app/i18n`; a target is structure and is the same in both languages, so it lives here. Before
 * this table the footer gave every link `GITHUB_URL` — including `Workspace`, `Domains`,
 * `Security` and `Self-host`, which name sections of the page the reader is standing on, and
 * including `Licence`, whose address was already imported in the same file two lines above.
 *
 * The pairing is positional, which is the one thing here that can drift in silence:
 * `test/widgets/site-footer.widget.test.tsx` asserts the arity of every column against both
 * dictionaries, so a label added to one and not to this table fails there.
 */
export const FOOTER_COLUMN_TARGETS: readonly (readonly FooterLinkTarget[])[] = [
  [
    { section: SECTION_IDS.workspace },
    { section: SECTION_IDS.domains },
    { section: SECTION_IDS.security },
    { section: SECTION_IDS.selfHost },
  ],
  [
    { href: GITHUB_URL },
    { href: LICENCE_URL },
    { href: SECURITY_POLICY_URL },
    { href: CONTRIBUTING_URL },
  ],
];

export interface FooterLink {
  readonly label: string;
  readonly target: FooterLinkTarget;
}

export interface FooterColumn {
  readonly title: string;
  readonly links: readonly FooterLink[];
}

/**
 * The shape the dictionaries give the footer columns, stated structurally.
 *
 * `shared` does not import from `app`: the type is the contract, not the module.
 */
interface CopyColumn {
  readonly title: string;
  readonly links: readonly string[];
}

/**
 * Labels from the dictionary, targets from the table, paired by position.
 *
 * A label with no target is dropped rather than rendered as a dead link — a footer missing one line
 * is a smaller lie than a link that goes nowhere, and the arity test names the missing row long
 * before a reader could meet it.
 */
export const pairFooterColumns = (columns: readonly CopyColumn[]): FooterColumn[] =>
  columns.map((column, columnIndex) => ({
    title: column.title,
    links: column.links.flatMap((label, linkIndex) => {
      const target = FOOTER_COLUMN_TARGETS[columnIndex]?.[linkIndex];

      return target ? [{ label, target }] : [];
    }),
  }));
