export * from './breadcrumbs.widget.js';
/** Namespaced: the pure crumb helpers are used by the route announcer as well as by the widget. */
export * as BreadcrumbsLib from './lib/index.js';
export * from './breadcrumb-trail.component.js';
/** The trail with its titles — read by the route announcer too, so the tab says what the trail does. */
export * from './hooks/use-route-crumbs.hook.js';
