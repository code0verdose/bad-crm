# @bad-crm/landing

**Status: prototype. Not shipped, not deployed, not linked from the repository README.**

The marketing page for Bad CRM. It presents the product as if every domain were finished — that is
what a landing page is for — while [the repository README](../../README.md) states the real state of
the project (design phase plus the M1 foundation). Publishing this page anywhere public is a
separate decision, and until it is taken the two documents must not be allowed to contradict each
other in front of a visitor.

## Why it is a package of its own

- It uses **no Mantine** and none of the application's design system: the visual language here is
  free to be louder than a product screen is allowed to be.
- It imports **nothing** from the workspace — not `@bad-crm/shared`, not `@bad-crm/client`. The
  package is a leaf of the dependency graph, so nothing it does can reach the product.
- It builds to static files with no network calls at runtime: no forms, no analytics, no backend.

## Commands

```bash
pnpm --filter @bad-crm/landing dev      # http://localhost:4321
pnpm --filter @bad-crm/landing build    # static build + size budget
pnpm --filter @bad-crm/landing preview  # http://localhost:4322
pnpm --filter @bad-crm/landing test
```

## Stack

React 19 + Vite, [motion](https://motion.dev) for scroll-driven animation, [Lenis](https://lenis.darkroom.engineering)
for smooth scrolling, [OGL](https://github.com/oframe/ogl) for the shader backgrounds (loaded
dynamically), plain CSS Modules over the landing's own `--bcl-*` tokens.

Several effects are ports of [React Bits](https://reactbits.dev) (MIT). Each port lives in its own
directory under `src/shared/ui/bits/` with a `SOURCE.md` naming the original; the attribution is
also recorded in the repository [`NOTICE`](../../NOTICE).

## Deployment note: the legal pages need a rewrite rule

`/terms`, `/privacy` and `/cookies` are client-side routes (`shared/lib/use-route.hook.ts`). The Vite
dev server serves `index.html` for unknown paths out of the box; a static host has to be told to do
the same — the usual SPA fallback — or those three URLs will 404 when opened directly.

## Legal documents are drafts

The three documents are written from what this site actually does — no analytics, no third-party
scripts, no cookies — but they carry placeholders where the operator's legal details, governing law
and jurisdiction belong, and no lawyer has reviewed them. The pages say so at the top. They must be
completed and reviewed before the site is published.

## Accessibility and motion

Every animation on this page is decoration. `prefers-reduced-motion: reduce` turns the whole thing
static — smooth scrolling off, scroll-linked transforms resolved to their final state, shader
backgrounds never mounted — and the page still reads top to bottom. Decorative layers carry
`aria-hidden`, and nothing is operable by pointer alone.
