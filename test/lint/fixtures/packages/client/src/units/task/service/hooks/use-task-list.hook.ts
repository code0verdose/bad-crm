import { TaskApi } from '@units/task';

export const useTaskList = (): unknown => TaskApi.listTasks();
