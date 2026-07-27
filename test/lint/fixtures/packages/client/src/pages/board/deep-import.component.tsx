import { useTaskList } from '@units/task/service/hooks/use-task-list.hook';

export function DeepImport() {
  return <div>{String(useTaskList())}</div>;
}
