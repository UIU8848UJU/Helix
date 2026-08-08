// Task id validation. The `job-` prefix is the current shared contract
// (SSH-derived); a browser-mcp id scheme can extend this later.

const taskIdPattern = /^job-[A-Za-z0-9._-]+$/;

export function assertTaskId(taskId: string): string {
  if (!taskIdPattern.test(taskId)) {
    throw new Error(`Invalid Helix task id: ${taskId}`);
  }
  return taskId;
}

export function taskDirectory(taskId: string, root: string): string {
  return `${root}/${assertTaskId(taskId)}`;
}
