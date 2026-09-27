import { Button, Combobox, Group, Switch, Text, VisuallyHidden, useCombobox } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { IconSelector } from '@tabler/icons-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { type ProjectSwitcher as ProjectSwitcherState } from '@units/project/service/hooks/use-project-switcher.hook.js';

import { ProjectSwitcherOption } from './project-switcher-option.component.js';

/**
 * `Mod+Alt+P`, matched on the **physical** key: on macOS `⌥P` types «π» and on a Russian layout the
 * P key types «з», so matching the character would make the shortcut work for only some of the
 * people it is meant for. Not `Mod+K` — that is the global search (`ux-architecture.md`) — and not
 * `Mod+Shift+P`, which Firefox keeps for a private window and a page cannot take back.
 */
export const PROJECT_SWITCHER_HOTKEY = 'mod+alt+P';

/** Wide enough for a key, a two-word Russian name and the archive mark on one line. */
const DROPDOWN_WIDTH = 320;

export interface ProjectSwitcherProps {
  readonly switcher: ProjectSwitcherState;
}

/**
 * The project switcher in the header (STORY-014-06) — a Mantine `Combobox` with the search inside
 * the dropdown.
 *
 * **Keyboard and screen reader** (acceptances 4 and 10). The trigger is a real button that opens on
 * Enter, Space and the shortcut; focus moves into the search field, arrows walk the options —
 * the field carries `aria-activedescendant`, set by `Combobox.Search` — Enter chooses, Escape
 * closes, and on close focus returns to the trigger (`focusTarget`; a choice of another project
 * returns it at once instead, so the route announcer can move it on to the new page). The count of what was found is
 * announced in a polite status region rather than being left for the reader to discover.
 *
 * Rendering only: which projects, which are recent, where a choice leads — all of it is the hook's.
 */
export function ProjectSwitcher({ switcher }: ProjectSwitcherProps) {
  const { t } = useTranslation();
  /**
   * The dropdown is closing because another project was chosen. Mantine's `focusTarget()` moves
   * focus a tick later (`setTimeout(…, 0)`), after the route announcer has put it on the heading of
   * the page the choice opened — and would take it back. So a choice that leaves hands focus to the
   * trigger at once, before the navigation commits, and the deferred return is skipped.
   */
  const leaving = useRef(false);
  const combobox = useCombobox({
    onDropdownOpen: () => {
      switcher.open();
      combobox.focusSearchInput();
    },
    onDropdownClose: () => {
      switcher.close();
      combobox.resetSelectedOption();
      if (leaving.current) {
        leaving.current = false;

        return;
      }
      combobox.focusTarget();
    },
  });

  // Mantine's default ignored tags (`INPUT`, `TEXTAREA`, `SELECT`, and `contenteditable`): inside a
  // field the chord is typing — `Ctrl+Alt` is AltGr on Windows, and a layout with a character on
  // AltGr+P would lose it to the switcher. From a field, Tab out first, or use the trigger.
  useHotkeys([[PROJECT_SWITCHER_HOTKEY, () => combobox.openDropdown(), { usePhysicalKeys: true }]]);

  const { current, recent, results } = switcher;
  const found = recent.length + results.length;

  return (
    <Combobox
      // The trigger lives in the fixed header and cannot be scrolled away from its dropdown, so the
      // «hide when the reference is detached» check has nothing to protect here — and without a
      // layout engine it reads every reference as detached and hides an open list.
      hideDetached={false}
      onOptionSubmit={(projectId) => {
        // Focus first: the trigger holds it until the new page's announcer, when the page's name
        // changed, moves it on. Escape and the project already open take the deferred return.
        combobox.targetRef.current?.focus();
        leaving.current = switcher.select(projectId);
        combobox.closeDropdown();
      }}
      position="bottom-start"
      store={combobox}
      width={DROPDOWN_WIDTH}
    >
      <Combobox.Target withAriaAttributes={false}>
        <Button
          aria-expanded={combobox.dropdownOpened}
          aria-haspopup="listbox"
          aria-keyshortcuts="Control+Alt+P Meta+Alt+P"
          aria-label={
            current === null
              ? t('nav.projectSwitcher.trigger')
              : t('nav.projectSwitcher.triggerCurrent', { key: current.key, name: current.name })
          }
          color="neutral"
          onClick={() => combobox.toggleDropdown()}
          rightSection={<IconSelector aria-hidden size={16} stroke={1.5} />}
          title={t('nav.projectSwitcher.shortcut')}
          variant="subtle"
        >
          {current === null ? (
            t('nav.projectSwitcher.placeholder')
          ) : (
            // One line of text, «KEY · Name»: the trigger is a label for where you are, and the key
            // leads because it is what tells two similarly named projects apart.
            <Text size="sm" truncate>
              {current.key} · {current.name}
            </Text>
          )}
        </Button>
      </Combobox.Target>

      <Combobox.Dropdown>
        <Combobox.Search
          aria-label={t('nav.projectSwitcher.search')}
          onChange={(event) => switcher.setTyped(event.currentTarget.value)}
          placeholder={t('nav.projectSwitcher.search')}
          value={switcher.typed}
        />
        <Group px="xs" py="xs">
          <Switch
            checked={switcher.archived}
            label={t('nav.projectSwitcher.archived')}
            onChange={(event) => switcher.setArchived(event.currentTarget.checked)}
            size="xs"
          />
        </Group>

        <VisuallyHidden aria-live="polite" role="status">
          {switcher.status === 'success' ? t('nav.projectSwitcher.found', { count: found }) : ''}
        </VisuallyHidden>

        <Combobox.Options aria-label={t('nav.projectSwitcher.all')}>
          {switcher.status === 'pending' && (
            <Combobox.Empty>{t('nav.projectSwitcher.loading')}</Combobox.Empty>
          )}
          {switcher.status === 'error' && (
            <Combobox.Empty>
              <Text size="sm">{t('nav.projectSwitcher.failed')}</Text>
              <Button mt="xs" onClick={switcher.retry} size="xs" variant="light">
                {t('nav.projectSwitcher.retry')}
              </Button>
            </Combobox.Empty>
          )}
          {switcher.status === 'success' && found === 0 && (
            <Combobox.Empty>{t('nav.projectSwitcher.empty')}</Combobox.Empty>
          )}
          {recent.length > 0 && (
            <Combobox.Group label={t('nav.projectSwitcher.recent')}>
              {recent.map((option) => (
                <Combobox.Option
                  active={option.id === current?.id}
                  key={option.id}
                  value={option.id}
                >
                  <ProjectSwitcherOption option={option} />
                </Combobox.Option>
              ))}
            </Combobox.Group>
          )}
          {results.length > 0 && (
            <Combobox.Group label={t('nav.projectSwitcher.all')}>
              {results.map((option) => (
                <Combobox.Option
                  active={option.id === current?.id}
                  key={option.id}
                  value={option.id}
                >
                  <ProjectSwitcherOption option={option} />
                </Combobox.Option>
              ))}
            </Combobox.Group>
          )}
        </Combobox.Options>

        {switcher.hasMore && (
          <Combobox.Footer>
            <Text c="var(--bc-text-muted)" size="sm">
              {t('nav.projectSwitcher.more')}
            </Text>
          </Combobox.Footer>
        )}
      </Combobox.Dropdown>
    </Combobox>
  );
}
