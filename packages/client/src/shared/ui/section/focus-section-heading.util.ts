/**
 * Moves focus to the heading of the `Section` that contains `element`, if there is one.
 *
 * Lives beside `Section` because it reads `Section`'s own contract — a `<section>` labelled by its
 * heading through `aria-labelledby`, the heading focusable by script (`tabIndex={-1}`). Outside a
 * section it does nothing, and the caller's focus stays where it was.
 */
export const focusSectionHeading = (element: Element): void => {
  const section = element.closest('section[aria-labelledby]');

  if (section === null) return;

  // The selector above matched on the attribute, so it is present.
  const headingId = section.getAttribute('aria-labelledby') as string;

  document.getElementById(headingId)?.focus();
};
