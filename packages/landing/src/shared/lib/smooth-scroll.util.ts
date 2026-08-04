/**
 * Where the page's smooth scroller lives, so that a link can use it without prop-drilling Lenis
 * through the tree.
 *
 * Two callers only: the provider registers the instance it owns, and `SectionLink` asks for a
 * section to be brought into view. When motion is reduced there is no instance — the provider does
 * not mount one — and the native jump is exactly what that setting asks for.
 */
interface SmoothScroller {
  scrollTo: (target: HTMLElement, options?: { immediate?: boolean }) => void;
}

let scroller: SmoothScroller | null = null;

export const registerSmoothScroller = (instance: SmoothScroller | null): void => {
  scroller = instance;
};

/** Close enough to count as arrived: a few pixels of sub-pixel layout drift. */
const ARRIVED_WITHIN_PX = 4;
const RETRY_MS = 60;
const MAX_TRIES = 12;

const jumpTo = (element: HTMLElement): void => {
  /* Immediate rather than animated: the reader has just changed page, so the section is where they
     expect to land, not somewhere to be flown to across ten thousand pixels of another page. */
  if (scroller) scroller.scrollTo(element, { immediate: true });
  else element.scrollIntoView();
};

/**
 * Scroll to a section of the landing page, waiting both for it to exist and for it to stop moving.
 *
 * Two things are unfinished at the moment a legal page is left. The section is not in the document
 * yet — the page that owns it is still rendering — and the sections above it have not settled on
 * their heights, because the tall pinned scenes size themselves after mount. Landing on the first
 * offset that looked right therefore leaves the reader thousands of pixels short of the heading.
 *
 * So it retries until the section really is at the top of the viewport, and gives up quietly if the
 * id is not on the page at all. A timer rather than `requestAnimationFrame`: a hidden tab stops
 * handing out frames, and a link that does nothing until the tab is looked at is worse than one
 * that arrives a moment late.
 */
export const scrollToSection = (id: string, triesLeft = MAX_TRIES): void => {
  const element = globalThis.document.getElementById(id);

  const retry = (): void => {
    if (triesLeft > 0) globalThis.setTimeout(() => scrollToSection(id, triesLeft - 1), RETRY_MS);
  };

  if (!element) {
    retry();
    return;
  }

  jumpTo(element);

  if (Math.abs(element.getBoundingClientRect().top) > ARRIVED_WITHIN_PX) retry();
};
