import { TasksRedesign } from "../redesign/tasks/TasksRedesign";

export function TasksPage({
  taskId,
  onNew,
}: {
  taskId?: string;
  onNew: (path: string) => void;
}) {
  return <TasksRedesign taskId={taskId} onNew={onNew} />;
}
