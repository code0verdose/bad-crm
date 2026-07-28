import { useLocalStorage } from '@mantine/hooks';

const STORAGE_KEY = 'bc-sidebar-collapsed';

export interface SidebarCollapseControl {
  readonly isCollapsed: boolean;
  readonly toggle: () => void;
}

/**
 * Whether the desktop sidebar is folded to icons.
 *
 * Persisted for the same reason the density is: a user who folds the navigation away has said
 * something about how they work, and asking again on every reload is the product forgetting it.
 * Read synchronously (`getInitialValueInEffect: false`) so the shell does not render wide and then
 * snap narrow.
 */
export const useSidebarCollapse = (): SidebarCollapseControl => {
  const [isCollapsed, setCollapsed] = useLocalStorage<boolean>({
    key: STORAGE_KEY,
    defaultValue: false,
    getInitialValueInEffect: false,
  });

  return {
    isCollapsed,
    toggle: () => {
      setCollapsed((previous) => !previous);
    },
  };
};
