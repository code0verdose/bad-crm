/**
 * The heading of the `Section` that contains `element`, or `null` outside one.
 *
 * Lives beside `Section` because it reads `Section`'s own contract — a `<section>` labelled by its
 * heading through `aria-labelledby`, the heading focusable by script (`tabIndex={-1}`).
 */
export const sectionHeadingOf = (element: Element): HTMLElement | null => {
  const section = element.closest('section[aria-labelledby]');

  if (section === null) return null;

  // The selector above matched on the attribute, so it is present.
  const headingId = section.getAttribute('aria-labelledby') as string;

  return document.getElementById(headingId);
};

/**
 * Moves focus to the heading of the `Section` that contains `element`, if there is one. Outside a
 * section it does nothing, and the caller's focus stays where it was.
 */
export const focusSectionHeading = (element: Element): void => {
  sectionHeadingOf(element)?.focus();
};
