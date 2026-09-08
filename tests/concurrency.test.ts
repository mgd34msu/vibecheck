import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Board } from "../src/board.js";
import { BoardError } from "../src/errors.js";
import type { ToolName } from "../src/schemas.js";
import { createLedger, join, publish, snapshot } from "./helpers.js";

const childResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("success"),
    id: z.string(),
    cursor: z.number().int(),
    plan_revision: z.number().int(),
  }),
  z.object({ kind: z.literal("error"), code: z.string() }),
]);

async function processes(
  t: TestContext,
  path: string,
  requests: { tool: ToolName; payload: unknown }[],
) {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const workerPath = fileURLToPath(
    new URL(`./fixtures/race-worker.${extension}`, import.meta.url),
  );
  const children = requests.map(({ tool, payload }) => {
    const child = spawn(process.execPath, [workerPath], {
      env: {
        ...process.env,
        VIBECHECK_DB_PATH: path,
        VIBECHECK_TOOL: tool,
        VIBECHECK_REQUEST: JSON.stringify(payload),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    let output = "";
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    let readyResolve: (() => void) | undefined;
    let readyReject: ((reason: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const result = new Promise<z.infer<typeof childResultSchema>>(
      (resolve, reject) => {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          output += chunk;
          if (output.startsWith("ready\n")) readyResolve?.();
        });
        child.once("error", (error) => {
          readyReject?.(error);
          reject(error);
        });
        child.once("close", (code) => {
          try {
            assert.equal(code, 0, stderr);
            assert.ok(output.startsWith("ready\n"), output);
            resolve(
              childResultSchema.parse(
                JSON.parse(output.slice("ready\n".length)),
              ),
            );
          } catch (error) {
            readyReject?.(
              error instanceof Error ? error : new Error(String(error)),
            );
            reject(error);
          }
        });
      },
    );
    return { child, ready, result };
  });
  const results = Promise.all(children.map((child) => child.result));
  await Promise.all(children.map((child) => child.ready));
  for (const { child } of children) child.stdin.end("go\n");
  return results;
}

function joinPayload(name: string) {
  return {
    project_id: "test",
    request_id: `join-${name}`,
    repository: "repo",
    vendor: "openai",
    runtime: "codex",
    external_session_id: name,
    model: "gpt-6-astra",
  };
}

test(
  "independent processes compete for one task with exactly one owner",
  { timeout: 40_000 },
  async (t) => {
    const { board, path } = await createLedger(t);
    const coordinator = await join(board, "worker-0");
    const workers = [coordinator];
    for (let index = 1; index < 4; index++)
      workers.push(await join(board, `worker-${index}`));
    await publish(board, coordinator, [{ id: "only", label: "Only task" }]);
    const outcomes = await processes(
      t,
      path,
      workers.map((session) => ({
        tool: "work_claim",
        payload: {
          project_id: "test",
          request_id: `claim-${session}`,
          session_id: session,
          task_id: "only",
          expected_revision: 1,
        },
      })),
    );
    const successes = outcomes.filter((outcome) => outcome.kind === "success");
    assert.equal(successes.length, 1, JSON.stringify(outcomes));
    assert.deepEqual(
      outcomes
        .filter((outcome) => outcome.kind === "error")
        .map((outcome) => outcome.code),
      ["conflict", "conflict", "conflict"],
    );
    const winner = successes[0];
    assert.ok(winner);
    const result = await snapshot(board);
    assert.equal(Object.keys(result.work).length, 1);
    assert.equal(result.tasks.only?.owner_work_id, winner.id);
    assert.equal(result.tasks.only?.revision, 2);
  },
);

test(
  "eight independent processes initialize the same empty database",
  { timeout: 40_000 },
  async (t) => {
    const { board, path } = await createLedger(t);
    const outcomes = await processes(
      t,
      path,
      Array.from({ length: 8 }, (_, index) => ({
        tool: "project_join",
        payload: joinPayload(`process-${index}`),
      })),
    );
    assert.ok(
      outcomes.every((outcome) => outcome.kind === "success"),
      JSON.stringify(outcomes),
    );
    const sessions = outcomes.flatMap((outcome) =>
      outcome.kind === "success" ? [outcome.id] : [],
    );
    assert.equal(new Set(sessions).size, 8);
    const result = await snapshot(board);
    assert.equal(Object.keys(result.sessions).length, 8);
    assert.ok(sessions.includes(result.coordinator_session_id));
    const delta = await board.call("project_status", {
      project_id: "test",
      since: 0,
    });
    assert.ok("changes" in delta);
    assert.equal(delta.changes.length, 8);
    assert.deepEqual(
      new Set(
        delta.changes.flatMap((batch) =>
          batch.records
            .filter((record) => record.kind === "session")
            .map((record) => record.id),
        ),
      ),
      new Set(sessions),
    );
  },
);

for (let round = 0; round < 10; round++) {
  test(`simultaneous first open and join round ${round}`, async (t) => {
    const { board, path } = await createLedger(t);
    const sessions = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        new Board(path).call("project_join", joinPayload(`worker-${index}`)),
      ),
    );
    assert.equal(
      new Set(sessions.map((session) => session.session_id)).size,
      8,
    );
    const result = await snapshot(board);
    assert.ok(
      sessions.some(
        (session) => session.session_id === result.coordinator_session_id,
      ),
    );
    const delta = await board.call("project_status", {
      project_id: "test",
      since: 0,
    });
    assert.ok("changes" in delta);
    assert.deepEqual(
      new Set(
        delta.changes.flatMap((batch) =>
          batch.records
            .filter((record) => record.kind === "session")
            .map((record) => record.id),
        ),
      ),
      new Set(sessions.map((session) => session.session_id)),
    );
  });
}

test("concurrent identical retry produces one work record and one change batch", async (t) => {
  const { board, path } = await createLedger(t);
  const session = await join(board);
  await publish(board, session, [{ id: "only", label: "Only task" }]);
  const before = await snapshot(board);
  const payload = {
    project_id: "test",
    request_id: "same-request",
    session_id: session,
    task_id: "only",
    expected_revision: 1,
  };
  const outcomes = await Promise.all(
    Array.from({ length: 8 }, () =>
      new Board(path).call("work_claim", payload),
    ),
  );
  const first = outcomes[0];
  assert.ok(first);
  for (const outcome of outcomes) assert.deepEqual(outcome, first);
  assert.equal(Object.keys((await snapshot(board)).work).length, 1);
  const delta = await board.call("project_status", {
    project_id: "test",
    since: before.cursor,
  });
  assert.ok("changes" in delta);
  assert.equal(delta.changes.length, 1);
  assert.equal(delta.changes[0]?.seq, first.cursor);
});

test("concurrent request id reuse with different payloads conflicts", async (t) => {
  const { board, path } = await createLedger(t);
  const session = await join(board);
  await publish(board, session, [{ id: "only", label: "Only task" }]);
  const outcomes = await Promise.allSettled(
    ["branch-a", "branch-b"].map((branch) =>
      new Board(path).call("work_claim", {
        project_id: "test",
        request_id: "reused",
        session_id: session,
        task_id: "only",
        expected_revision: 1,
        location: { branch },
      }),
    ),
  );
  assert.equal(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      assert.ok(outcome.reason instanceof BoardError);
      assert.equal(outcome.reason.code, "conflict");
    }
  }
  assert.equal(Object.keys((await snapshot(board)).work).length, 1);
});

test(
  "cancellation racing a claim commits exactly one complete transaction",
  { timeout: 40_000 },
  async (t) => {
    const { board, path } = await createLedger(t);
    const coordinator = await join(board);
    const worker = await join(board, "worker", coordinator);
    const before = await publish(board, coordinator, [
      { id: "only", label: "Only task" },
    ]);
    const outcomes = await processes(t, path, [
      {
        tool: "plan_edit",
        payload: {
          project_id: "test",
          request_id: "cancel-race",
          session_id: coordinator,
          expected_revision: 1,
          operations: [
            {
              op: "add",
              task: { id: "marker", label: "Cancellation committed" },
            },
            {
              op: "update",
              task_id: "only",
              status: "cancelled",
              label: "Cancelled task",
            },
          ],
        },
      },
      {
        tool: "work_claim",
        payload: {
          project_id: "test",
          request_id: "claim-race",
          session_id: worker,
          task_id: "only",
          expected_revision: 1,
        },
      },
    ]);
    assert.equal(
      outcomes.filter((outcome) => outcome.kind === "success").length,
      1,
      JSON.stringify(outcomes),
    );
    assert.deepEqual(
      outcomes
        .filter((outcome) => outcome.kind === "error")
        .map((outcome) => outcome.code),
      ["conflict"],
    );
    const cancellation = outcomes[0];
    const claim = outcomes[1];
    assert.ok(cancellation);
    assert.ok(claim);
    const result = await snapshot(board);
    const task = result.tasks.only;
    assert.ok(task);
    assert.equal(task.revision, 2);
    const delta = await board.call("project_status", {
      project_id: "test",
      since: before.cursor,
    });
    assert.ok("changes" in delta);
    assert.equal(delta.changes.length, 1);
    if (cancellation.kind === "success") {
      assert.equal(result.plan_revision, 2);
      assert.equal(task.status, "cancelled");
      assert.ok(!("owner_work_id" in task));
      assert.deepEqual(Object.keys(result.work), []);
      assert.deepEqual(result.task_map?.marker, {
        label: "Cancellation committed",
        depends_on: [],
      });
      assert.equal(result.task_map?.only?.label, "Cancelled task");
      assert.equal(delta.cursor, cancellation.cursor);
      assert.equal(claim.kind, "error");
    } else {
      assert.ok(claim.kind === "success");
      assert.equal(result.plan_revision, 1);
      assert.equal(task.status, "in_progress");
      assert.equal(task.owner_work_id, claim.id);
      assert.deepEqual(Object.keys(result.work), [claim.id]);
      assert.deepEqual(Object.keys(result.tasks), ["only"]);
      assert.deepEqual(result.task_map, {
        only: { label: "Only task", depends_on: [] },
      });
      assert.equal(delta.cursor, claim.cursor);
      assert.ok(
        delta.changes.every((batch) =>
          batch.records.every(
            (record) => record.kind !== "task" || record.id !== "marker",
          ),
        ),
      );
    }
  },
);

test(
  "concurrent plan editors reject stale revision and retain both edits after rebase",
  { timeout: 40_000 },
  async (t) => {
    const { board, path } = await createLedger(t);
    const coordinator = await join(board);
    const before = await publish(board, coordinator, [
      { id: "base", label: "Base task" },
    ]);
    const additions = ["left", "right"];
    const outcomes = await processes(
      t,
      path,
      additions.map((id) => ({
        tool: "plan_edit",
        payload: {
          project_id: "test",
          request_id: `edit-${id}`,
          session_id: coordinator,
          expected_revision: 1,
          operations: [
            { op: "add", task: { id, label: id, depends_on: ["base"] } },
          ],
        },
      })),
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.kind === "success").length,
      1,
      JSON.stringify(outcomes),
    );
    assert.deepEqual(
      outcomes
        .filter((outcome) => outcome.kind === "error")
        .map((outcome) => outcome.code),
      ["conflict"],
    );
    const winnerId =
      additions[outcomes.findIndex((outcome) => outcome.kind === "success")];
    const loserId =
      additions[outcomes.findIndex((outcome) => outcome.kind === "error")];
    assert.ok(winnerId);
    assert.ok(loserId);
    const raced = await snapshot(board);
    assert.equal(raced.plan_revision, 2);
    assert.deepEqual(
      new Set(Object.keys(raced.tasks)),
      new Set(["base", winnerId]),
    );
    assert.equal(raced.tasks.base?.revision, 1);
    assert.equal(raced.tasks[winnerId]?.revision, 1);
    const initialDelta = await board.call("project_status", {
      project_id: "test",
      since: before.cursor,
    });
    assert.ok("changes" in initialDelta);
    assert.equal(initialDelta.changes.length, 1);
    assert.ok(
      initialDelta.changes.every((batch) =>
        batch.records.every(
          (record) => record.kind !== "task" || record.id !== loserId,
        ),
      ),
    );
    const rebased = await new Board(path).call("plan_edit", {
      project_id: "test",
      request_id: `edit-${loserId}`,
      session_id: coordinator,
      expected_revision: raced.plan_revision,
      operations: [
        {
          op: "add",
          task: { id: loserId, label: loserId, depends_on: ["base"] },
        },
      ],
    });
    assert.equal(rebased.plan_revision, 3);
    const final = await snapshot(board);
    assert.deepEqual(final.task_map, {
      base: { label: "Base task", depends_on: [] },
      left: { label: "left", depends_on: ["base"] },
      right: { label: "right", depends_on: ["base"] },
    });
    for (const task of Object.values(final.tasks))
      assert.equal(task.revision, 1);
    const delta = await board.call("project_status", {
      project_id: "test",
      since: before.cursor,
    });
    assert.ok("changes" in delta);
    assert.deepEqual(
      delta.changes.map((batch) => batch.seq),
      [raced.cursor, rebased.cursor],
    );
    assert.deepEqual(
      delta.changes.map((batch) =>
        batch.records
          .filter((record) => record.kind === "task")
          .map((record) => record.id),
      ),
      [[winnerId], [loserId]],
    );
  },
);
