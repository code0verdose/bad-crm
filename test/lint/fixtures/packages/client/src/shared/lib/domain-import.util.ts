import { TaskService } from '@units/task';

export const overdueCount = (): unknown => TaskService.useTaskList();
