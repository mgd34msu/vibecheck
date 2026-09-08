import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import test from "node:test";
import { z } from "zod";
import { openSqlite } from "../src/sqlite.js";
import {
  jsonValueSchema,
  projectJoinSchema,
  sessionIdSchema,
  taskRecordSchema,
  workClaimSchema,
  workRecordSchema,
} from "../src/schemas.js";
import {
  createLedger,
  progress,
  PROJECT,
  request,
  snapshot,
} from "./helpers.js";

const fixtureSchema = z.object({
  claim_request: workClaimSchema,
  claim_response: jsonValueSchema,
  join_request: projectJoinSchema,
  join_response: jsonValueSchema,
  session_id: sessionIdSchema,
  root_id: sessionIdSchema,
  child_id: sessionIdSchema,
  task: taskRecordSchema,
  work: workRecordSchema,
  history: jsonValueSchema,
  snapshot: jsonValueSchema,
  plan: jsonValueSchema,
});

async function fixture(path: string) {
  const directory = joinPath(process.cwd(), "tests", "fixtures");
  const connection = await openSqlite(path);
  try {
    connection.exec(
      await readFile(joinPath(directory, "python-legacy.sql"), "utf8"),
    );
  } finally {
    connection.close();
  }
  return fixtureSchema.parse(
    JSON.parse(
      await readFile(joinPath(directory, "python-legacy.json"), "utf8"),
    ),
  );
}

test("Python schema-v1 snapshots, historical identities, maps and request receipts remain compatible", async (t) => {
  const { board, path } = await createLedger(t);
  const expected = await fixture(path);
  assert.deepEqual(await snapshot(board), expected.snapshot);
  assert.deepEqual(
    await board.call("work_history", { project_id: PROJECT, task_id: "a" }),
    expected.history,
  );
  assert.deepEqual(
    await board.call("plan_read", { project_id: PROJECT, revision: 1 }),
    expected.plan,
  );
  assert.deepEqual(
    await board.call("work_claim", expected.claim_request),
    expected.claim_response,
  );
  assert.deepEqual(
    await board.call("project_join", expected.join_request),
    expected.join_response,
  );
  assert.deepEqual(await snapshot(board), expected.snapshot);
});

test("legacy handoff chain infers integration requirement without rewriting immutable events", async (t) => {
  const { board, path } = await createLedger(t);
  const expected = await fixture(path);
  const connection = await openSqlite(path);
  const before = connection.all(
    "SELECT seq,body FROM changes ORDER BY seq",
    [],
  );
  try {
    await assert.rejects(
      progress(board, expected.session_id, expected.task, expected.work, {
        status: "complete",
      }),
      /integration commit/,
    );
    assert.deepEqual(
      connection.all("SELECT seq,body FROM changes ORDER BY seq", []),
      before,
    );
    const next = await progress(
      board,
      expected.session_id,
      expected.task,
      expected.work,
      { status: "blocked", blocker: "review" },
    );
    assert.equal(next.work.integration_required, true);
    assert.deepEqual(
      connection.all("SELECT seq,body FROM changes ORDER BY seq LIMIT ?", [
        before.length,
      ]),
      before,
    );
    const done = await progress(board, next.session, next.task, next.work, {
      status: "complete",
      integration_commit: "b".repeat(40),
    });
    assert.equal(done.task.status, "complete");
  } finally {
    connection.close();
  }
});

test("legacy replacement starts a fresh attempt without abandoned integration requirements", async (t) => {
  const { board, path } = await createLedger(t);
  const expected = await fixture(path);
  const claimed = await board.call("work_claim", {
    project_id: PROJECT,
    request_id: request(),
    session_id: expected.session_id,
    task_id: "a",
    expected_revision: expected.task.revision,
    replace_work_id: expected.work.id,
  });
  const done = await progress(
    board,
    expected.session_id,
    claimed.task,
    claimed.work,
    { status: "complete" },
  );
  assert.equal(done.work.integration_required, false);
  assert.equal(done.task.status, "complete");
});

test("schema character limits count Unicode characters and retry digests preserve explicit nulls", async (t) => {
  const { board } = await createLedger(t);
  const input = {
    project_id: PROJECT,
    request_id: "unicode-join",
    repository: "repo",
    vendor: "openai",
    runtime: "codex",
    external_session_id: "unicode",
    model: "🦊".repeat(500),
  };
  assert.equal(projectJoinSchema.parse(input).model, input.model);
  const first = await board.call("project_join", input);
  assert.deepEqual(await board.call("project_join", input), first);
  await assert.rejects(
    board.call("project_join", { ...input, effort: null }),
    /request/,
  );
  await assert.rejects(
    board.call("project_join", {
      ...input,
      request_id: request(),
      model: "🦊".repeat(501),
    }),
  );
});
