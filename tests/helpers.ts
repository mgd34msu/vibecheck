import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import type { TestContext } from "node:test";
import { Board } from "../src/board.js";
import { BoardError, type BoardErrorCode } from "../src/errors.js";
import type {
  SessionId,
  TaskRecord,
  WorkRecord,
  WorkProgress,
} from "../src/schemas.js";

export const PROJECT = "test";
export const request = () => `r-${randomUUID()}`;

export async function createLedger(t: TestContext) {
  const directory = await mkdtemp(joinPath(tmpdir(), "vibecheck-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = joinPath(directory, "board.sqlite3");
  return { board: new Board(path), path };
}

export async function join(
  board: Board,
  name = "root",
  parentSessionId?: string,
) {
  const result = await board.call("project_join", {
    project_id: PROJECT,
    request_id: request(),
    repository: "repo",
    vendor: "openai",
    runtime: "codex",
    external_session_id: name,
    model: "astra",
    effort: "high",
    ...(parentSessionId === undefined
      ? {}
      : { parent_session_id: parentSessionId }),
  });
  return result.session_id;
}

export function publish(
  board: Board,
  sessionId: string,
  tasks: unknown[] = [
    { id: "a", label: "A" },
    { id: "b", label: "B", depends_on: ["a"] },
  ],
) {
  return board.call("plan_publish", {
    project_id: PROJECT,
    request_id: request(),
    session_id: sessionId,
    expected_revision: 0,
    tasks,
  });
}

export async function snapshot(board: Board) {
  const result = await board.call("project_status", {
    project_id: PROJECT,
    full: true,
  });
  assert.ok("tasks" in result);
  return result;
}

export async function prepare(board: Board) {
  const session = await join(board);
  await publish(board, session);
  const claimed = await board.call("work_claim", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    task_id: "a",
    expected_revision: 1,
    location: { branch: "feature", target_branch: "main", paths: ["src/a.ts"] },
  });
  return { session, task: claimed.task, work: claimed.work };
}

export async function progress(
  board: Board,
  session: SessionId,
  task: TaskRecord,
  work: WorkRecord,
  fields: Partial<Omit<WorkProgress, "work_id" | "expected_revision">>,
) {
  const result = await board.call("work_update", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    updates: [
      {
        work_id: work.id,
        expected_revision: work.revision,
        expected_task_revision: task.revision,
        ...fields,
      },
    ],
  });
  const updated = result.work[0];
  assert.ok(updated);
  return { session, task: result.tasks[0] ?? task, work: updated };
}

export async function rejectsCode(
  operation: Promise<unknown>,
  code: BoardErrorCode,
) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof BoardError);
    assert.equal(error.code, code);
    return true;
  });
}
