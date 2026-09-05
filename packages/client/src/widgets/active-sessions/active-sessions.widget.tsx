import { Button, Group, Stack } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { type SessionActionKind } from '@widgets/active-sessions/lib';
import { AuthService, type AuthApi } from '@units/auth';

import { SessionConfirmDialog } from './ui/session-confirm-dialog.component.js';
import { SessionTable } from './ui/session-table.component.js';

/** Rows of the skeleton, so the page does not jump when the answer arrives. */
const SKELETON_ROWS = 4;

/** Which question is on screen, and about what. `others` names no device. */
interface SessionAsk {
  readonly action: SessionActionKind;
  readonly session?: AuthApi.SessionSummary;
}

/** Where the focus goes once the confirmation is gone, and it depends on why it went. */
type FocusReturn = 'trigger' | 'heading';

/**
 * Where this account is signed in, and the two ways to close it.
 *
 * The composition point (`rules/frontend-fsd.mdc` rule 7): one hook from the unit, a table, a
 * button and a confirmation. It sorts nothing and pages nothing — `GET /auth/sessions` is
 * deliberately unpaginated, one row per live device, and the order is the server's.
 *
 * **`now` is read once per render rather than kept ticking.** «Last active» is accurate to the
 * fifteen-minute rotation behind it, so a timer that re-rendered the table every minute would be
 * animating a number that cannot move that fast.
 *
 * **The confirmation is mounted by being open**, not hidden with a prop, so its refusal is born and
 * buried with it: a second attempt after a cancelled first cannot inherit a stale message, and there
 * is no `reset()` anywhere that has to remember to run. The one thing that must then be handled here
 * is the focus — see below.
 */
export function ActiveSessions() {
  const { t } = useTranslation();
  const sessions = AuthService.useActiveSessions();
  const [ask, setAsk] = useState<SessionAsk | null>(null);
  /** Whatever had the focus when the question was asked — a row button, or «close the rest». */
  const triggerRef = useRef<HTMLElement | null>(null);
  /** A new object per close, so the effect below runs every time, twice in a row if need be. */
  const [closedTo, setClosedTo] = useState<{ readonly at: FocusReturn } | undefined>(undefined);

  /**
   * Moving the focus after the trap that owned it has been unmounted — a real side effect on the
   * DOM, which is the one thing `useEffect` is still for (`rules/frontend-fsd.mdc` rule 11).
   *
   * It cannot be done in the handler: Mantine's focus trap is live for the rest of that event and
   * pulls the focus straight back inside; and the successful path closes from a promise callback,
   * whose commit has not happened by the time microtasks run. An effect runs after the commit that
   * removed the dialog, which is exactly the moment both destinations below become reachable.
   *
   * **Two destinations, because the trigger is not always there to return to.** After a cancellation
   * it is. After a successful revocation the row it lived in has gone — and focus returned to a
   * detached node is focus on `<body>`, dumping a keyboard user at the top of the shell — so it goes
   * to the page's `h1`, where the route announcer already sends it when what a page is about changes
   * (`rules/a11y.mdc` §21). The `isConnected` check is what decides, rather than the caller: it is
   * the same question, asked of the DOM instead of guessed from the outcome.
   */
  useEffect(() => {
    if (closedTo === undefined) return;

    const trigger = triggerRef.current;
    const target =
      closedTo.at === 'trigger' && trigger?.isConnected === true
        ? trigger
        : document.getElementById(SharedUi.PAGE_TITLE_ID);

    target?.focus();
  }, [closedTo]);

  const open = (next: SessionAsk): void => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    setAsk(next);
  };

  const dismiss = (at: FocusReturn): void => {
    setAsk(null);
    setClosedTo({ at });
  };

  return (
    <SharedUi.Section
      descriptionKey="security.sessions.description"
      titleKey="security.sessions.title"
    >
      <SharedUi.DataState
        errorMessageKey="security.sessions.loadFailed"
        onRetry={sessions.retry}
        skeleton={<SharedUi.TextSkeleton lines={SKELETON_ROWS} />}
        status={sessions.status}
      >
        <Stack gap="md">
          <SessionTable
            now={new Date()}
            onClose={(session) => {
              open({ action: session.current ? 'signOut' : 'revoke', session });
            }}
            sessions={sessions.items}
          />

          {/*
            Offered only while there is a rest to close: on a single-session account the operation can
            only answer «closed nothing», which is a control that exists to disappoint. A `Group` so
            the button keeps its own width — a `Stack` stretches its children.
          */}
          {sessions.hasOthers && (
            <Group>
              <Button
                color="danger"
                onClick={() => {
                  open({ action: 'others' });
                }}
                variant="light"
              >
                {t('security.sessions.action.others')}
              </Button>
            </Group>
          )}
        </Stack>
      </SharedUi.DataState>

      {ask !== null && (
        <SessionConfirmDialog
          action={ask.action}
          device={ask.session?.device ?? ''}
          isPending={sessions.isRevoking}
          onCancel={() => {
            sessions.dismissFailure();
            dismiss('trigger');
          }}
          onConfirm={() => {
            const done = () => {
              dismiss('heading');
            };

            if (ask.session === undefined) {
              sessions.revokeOthers(done);

              return;
            }

            sessions.revoke(ask.session, done);
          }}
          {...(sessions.failureKey === undefined ? {} : { failureKey: sessions.failureKey })}
        />
      )}
    </SharedUi.Section>
  );
}
