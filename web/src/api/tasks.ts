// Poll one server-owned task with a bounded schedule and cancellable waits.
import { ApiError } from "./client.ts";
import type { ApiClient } from "./client.ts";
import type { TaskResult } from "./types.ts";
export class TaskFailure extends ApiError {
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(503, code, message);
    this.name = "TaskFailure";
    this.retryable = retryable;
  }
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Task cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
export async function pollTask(
  client: ApiClient,
  id: string,
  signal: AbortSignal,
): Promise<TaskResult> {
  for (let attempt = 0; attempt < 16; attempt++) {
    if (signal.aborted) throw new DOMException("Task cancelled", "AbortError");
    const task = await client.getTask(id, signal);
    if (task.id !== id)
      throw new ApiError(
        409,
        "unexpected_task",
        "The service returned a different task. Please retry.",
      );
    if (
      (task.status === "succeeded" || task.status === "warning") &&
      task.result
    )
      return task.result;
    if (task.status === "failed")
      throw new TaskFailure(
        task.error?.code ?? "task_failed",
        task.error?.message ?? "The background check failed. Please try again.",
        task.error?.retryable ?? false,
      );
    await wait(Math.min(5000, 700 * (attempt + 1)), signal);
  }
  throw new ApiError(
    408,
    "task_pending",
    "The check is still pending. Retry to resume the same task.",
  );
}
