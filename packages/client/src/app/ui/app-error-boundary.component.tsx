import { Component, type ErrorInfo, type ReactNode } from 'react';

import { errorReference } from '@app/global-error-listeners.util.js';

import { AppErrorScreen } from './app-error-screen.component.js';

export interface AppErrorBoundaryProps {
  readonly children: ReactNode;
  /** Where a caught failure goes. Injected so a test asserts the report rather than the console. */
  readonly report: (error: unknown, reference: string) => void;
}

interface AppErrorBoundaryState {
  readonly failed: boolean;
}

/**
 * The screen shown when the part of the application that renders screens is the part that broke.
 *
 * The route boundary (`RouteError`) covers a loader or a component **inside** the route tree. This
 * one covers everything above it — a provider, the session bootstrap, the router itself — where the
 * alternative is a white page that tells the user nothing and the team even less.
 *
 * A class, because `componentDidCatch` has no hook equivalent: React has never shipped one, and the
 * community wrappers are this same class with a different name.
 *
 * **The only offer is a reload, and that is honest.** A boundary above the router cannot re-run a
 * loader — the router is what failed — so «try again» would be a button that does nothing. The
 * identifier below it is what turns «it broke» into a support conversation: the person reads it out
 * and the team finds the same value in the report.
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  /**
   * One identifier per boundary, created when it mounts rather than when it catches.
   *
   * The obvious shape — put it in the state from `getDerivedStateFromError` — makes
   * `componentDidCatch` read a `string | undefined` and need a fallback for a case React's own
   * contract forbids: it runs the static method first, always. That fallback is a line no test can
   * reach and no reader can evaluate, which is exactly what the coverage gate is for. A field costs
   * one `randomUUID` per mounted boundary and removes the impossible branch.
   *
   * One value is enough: a boundary that has caught renders the recovery screen and never returns
   * to its children, so it never catches twice.
   */
  private readonly reference = errorReference();

  override state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    this.props.report(error, this.reference);
  }

  override render(): ReactNode {
    return this.state.failed ? <AppErrorScreen reference={this.reference} /> : this.props.children;
  }
}
