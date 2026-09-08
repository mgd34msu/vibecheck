import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import { Board } from "../src/board.js";
import { BoardError } from "../src/errors.js";
import { planRead, taskMap } from "../src/plans.js";
import {
  planMetadataSchema,
  planPublishSchema,
  planReadDiffResultSchema,
  planReadMapResultSchema,
  planReadSchema,
  projectIdSchema,
  projectJoinSchema,
  taskIdSchema,
  taskRecordSchema,
} from "../src/schemas.js";

async function ledger(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "vibecheck-plans-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const board = new Board(join(directory, "plans.sqlite3"));
  let sequence = 0;
  const requestId = () => `r${sequence++}`;
  return {
    board,
    requestId,
    async join(
      name = "root",
      fields: Partial<z.input<typeof projectJoinSchema>> = {},
    ) {
      const result = await board.call("project_join", {
        project_id: "p",
        request_id: requestId(),
        repository: "repo",
        vendor: "openai",
        runtime: "codex",
        external_session_id: name,
        model: "astra",
        ...fields,
      });
      return result.session_id;
    },
    publish(
      session: string,
      expectedRevision: number,
      tasks: z.input<typeof planPublishSchema>["tasks"],
    ) {
      return board.call("plan_publish", {
        project_id: "p",
        request_id: requestId(),
        session_id: session,
        expected_revision: expectedRevision,
        tasks,
      });
    },
    read(fields: Partial<z.input<typeof planReadSchema>> = {}) {
      return board.call("plan_read", { project_id: "p", ...fields });
    },
  };
}

test("task maps contain only definitions and omit empty or absent supersedes", () => {
  const task = {
    revision: 7,
    created_at: "past",
    updated_at: "present",
    status: "in_progress",
    owner_work_id: "w1",
  };
  const result = taskMap([
    taskRecordSchema.parse({ ...task, id: "a", label: "A", depends_on: [] }),
    taskRecordSchema.parse({
      ...task,
      id: "b",
      label: "B",
      depends_on: ["a"],
      supersedes: [],
    }),
    taskRecordSchema.parse({
      ...task,
      id: "c",
      label: "C",
      depends_on: [],
      supersedes: ["b"],
    }),
  ]);
  assert.deepEqual(result, {
    a: { label: "A", depends_on: [] },
    b: { label: "B", depends_on: ["a"] },
    c: { label: "C", depends_on: [], supersedes: ["b"] },
  });
});

test("revision zero, empty publications, and endpoint validation", async (context) => {
  const l = await ledger(context);
  const session = await l.join();
  const zero = { project_id: "p", plan_revision: 0, task_map: {} };
  assert.deepEqual(await l.read(), zero);
  await l.publish(session, 0, []);
  assert.deepEqual(planReadMapResultSchema.parse(await l.read()).task_map, {});
  await l.publish(session, 1, [{ id: "a", label: "A" }]);
  assert.deepEqual(await l.read({ revision: 0 }), zero);
  assert.deepEqual(
    planReadMapResultSchema.parse(await l.read({ revision: 1 })).task_map,
    {},
  );
  for (const fields of [
    { revision: 3 },
    { compare_to: 3 },
    { revision: -1 },
    { compare_to: true },
  ]) {
    await assert.rejects(
      l.board.call("plan_read", { project_id: "p", ...fields }),
      (error: unknown) =>
        error instanceof BoardError && error.code === "invalid",
    );
  }
  await assert.rejects(
    l.read({ project_id: "missing" }),
    (error: unknown) =>
      error instanceof BoardError && error.code === "not_found",
  );
});

test("historical definitions and original metadata survive work and takeover", async (context) => {
  const l = await ledger(context);
  const original = await l.join();
  const published = await l.publish(original, 0, [
    { id: "a", label: "A" },
    { id: "b", label: "B", depends_on: ["a"] },
  ]);
  const initial = planReadMapResultSchema.parse(await l.read());
  assert.deepEqual(initial.task_map, {
    a: { label: "A", depends_on: [] },
    b: { label: "B", depends_on: ["a"] },
  });
  const publication = await l.board.database.read(
    projectIdSchema.parse("p"),
    (tx) =>
      tx.queryRows(
        planMetadataSchema,
        "SELECT actor_id, created_at FROM changes WHERE seq = ?",
        [published.cursor],
      ),
  );
  assert.deepEqual(initial.metadata, publication[0]);
  const claimed = await l.board.call("work_claim", {
    project_id: "p",
    request_id: l.requestId(),
    session_id: original,
    task_id: "a",
    expected_revision: 1,
  });
  const successor = await l.join("successor", { take_over_from: original });
  assert.deepEqual(await l.read(), initial);
  await l.publish(successor, 1, [
    { id: "a", label: "Renamed" },
    { id: "b", label: "B", depends_on: [] },
  ]);
  const taskRevision = await l.board.database.read(
    projectIdSchema.parse("p"),
    (tx) => tx.getTask(taskIdSchema.parse("a")).revision,
  );
  await l.board.call("work_update", {
    project_id: "p",
    request_id: l.requestId(),
    session_id: successor,
    updates: [
      {
        work_id: claimed.work.id,
        expected_revision: claimed.work.revision,
        expected_task_revision: taskRevision,
        status: "complete",
      },
    ],
  });
  assert.deepEqual(await l.read({ revision: 1 }), initial);
  const current = planReadMapResultSchema.parse(await l.read());
  assert.deepEqual(current.task_map, {
    a: { label: "Renamed", depends_on: [] },
    b: { label: "B", depends_on: [] },
  });
  assert.equal(current.metadata?.actor_id, successor);
  assert.deepEqual(await l.read({ revision: 2 }), current);
});

test("plan diffs are directional and contain no duplicated maps", async (context) => {
  const l = await ledger(context);
  const session = await l.join();
  await l.publish(session, 0, [{ id: "a", label: "A" }]);
  await l.publish(session, 1, [
    { id: "a", label: "Updated" },
    { id: "b", label: "B" },
  ]);
  const diff = planReadDiffResultSchema.parse(await l.read({ compare_to: 1 }));
  assert.equal(diff.plan_revision, 2);
  assert.equal(diff.compare_to, 1);
  assert.deepEqual(diff.added, { b: { label: "B", depends_on: [] } });
  assert.deepEqual(diff.changed, {
    a: {
      before: { label: "A", depends_on: [] },
      after: { label: "Updated", depends_on: [] },
    },
  });
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(
    Object.keys(diff).sort(),
    [
      "project_id",
      "plan_revision",
      "compare_to",
      "added",
      "changed",
      "removed",
      "metadata",
    ].sort(),
  );
  const reverse = planReadDiffResultSchema.parse(
    await l.read({ revision: 1, compare_to: 2 }),
  );
  assert.deepEqual(reverse.added, {});
  assert.deepEqual(reverse.removed, ["b"]);
  assert.deepEqual(reverse.changed, {
    a: {
      before: { label: "Updated", depends_on: [] },
      after: { label: "A", depends_on: [] },
    },
  });
  const zero = planReadDiffResultSchema.parse(
    await l.read({ revision: 0, compare_to: 2 }),
  );
  assert.deepEqual(zero.added, {});
  assert.deepEqual(zero.changed, {});
  assert.deepEqual(zero.removed, ["a", "b"]);
  assert.equal(Object.hasOwn(zero, "metadata"), false);
  for (const revision of [0, 1, 2]) {
    const equal = planReadDiffResultSchema.parse(
      await l.read({ revision, compare_to: revision }),
    );
    assert.deepEqual(equal.added, {});
    assert.deepEqual(equal.changed, {});
    assert.deepEqual(equal.removed, []);
  }
});

test("plan reads stay project scoped and read only without changing event shapes", async (context) => {
  const l = await ledger(context);
  const session = await l.join();
  await l.publish(session, 0, [{ id: "shared", label: "Original" }]);
  const other = await l.join("root", { project_id: "other" });
  await l.board.call("plan_publish", {
    project_id: "other",
    request_id: l.requestId(),
    session_id: other,
    expected_revision: 0,
    tasks: [{ id: "shared", label: "Foreign" }],
  });
  await l.publish(session, 1, [{ id: "shared", label: "Later" }]);
  await l.board.database.read(projectIdSchema.parse("p"), (tx) => {
    const rows = tx.queryRows(
      z.object({ body: z.string() }),
      "SELECT body FROM changes WHERE project_id = ?",
      [tx.projectId],
    );
    for (const row of rows) {
      for (const change of z
        .array(z.record(z.string(), z.unknown()))
        .parse(JSON.parse(row.body))) {
        assert.equal(
          Object.keys(change).every((key) =>
            ["id", "kind", "record", "context"].includes(key),
          ),
          true,
        );
      }
    }
    const countSchema = z.object({ count: z.number() });
    const before = tx.queryRows(
      countSchema,
      "SELECT total_changes() AS count",
      [],
    );
    const cursor = tx.cursor();
    assert.deepEqual(
      tx.queryRows(
        z.object({ query_only: z.number() }),
        "PRAGMA query_only",
        [],
      ),
      [{ query_only: 1 }],
    );
    const result = planReadMapResultSchema.parse(
      planRead(tx, planReadSchema.parse({ project_id: "p", revision: 1 })),
    );
    assert.deepEqual(result.task_map, {
      shared: { label: "Original", depends_on: [] },
    });
    assert.deepEqual(
      tx.queryRows(countSchema, "SELECT total_changes() AS count", []),
      before,
    );
    assert.equal(tx.cursor(), cursor);
    assert.throws(() => tx.execute("DELETE FROM changes", []), /readonly/i);
  });
});

test("legacy tasks without supersedes need no plan snapshots or migration", async (context) => {
  const l = await ledger(context);
  const session = await l.join("legacy");
  await l.publish(session, 0, [{ id: "a", label: "Original" }]);
  await l.publish(session, 1, [{ id: "a", label: "Later" }]);
  await l.board.database.write(projectIdSchema.parse("p"), (tx) => {
    tx.execute(
      "UPDATE records SET body = json_remove(body, '$.supersedes') WHERE project_id = ? AND kind = 'task'",
      [tx.projectId],
    );
    tx.execute(
      `UPDATE changes SET body = (
      SELECT json_group_array(json(CASE WHEN json_extract(item.value, '$.kind') = 'task'
        THEN json_remove(item.value, '$.record.supersedes') ELSE item.value END))
      FROM json_each(changes.body) AS item
    ) WHERE project_id = ?`,
      [tx.projectId],
    );
  });
  assert.deepEqual(
    planReadMapResultSchema.parse(await l.read({ revision: 1 })).task_map,
    { a: { label: "Original", depends_on: [] } },
  );
  assert.deepEqual(planReadMapResultSchema.parse(await l.read()).task_map, {
    a: { label: "Later", depends_on: [] },
  });
  assert.deepEqual(await l.read({ revision: 0 }), {
    project_id: "p",
    plan_revision: 0,
    task_map: {},
  });
  await l.board.database.read(projectIdSchema.parse("p"), (tx) => {
    assert.deepEqual(
      tx.queryRows(
        z.object({ user_version: z.number() }),
        "PRAGMA user_version",
        [],
      ),
      [{ user_version: 1 }],
    );
    assert.deepEqual(
      tx.queryRows(
        z.object({ name: z.string() }),
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%snapshot%'",
        [],
      ),
      [],
    );
  });
});

test("status-only publications produce no definition changes", async (context) => {
  const l = await ledger(context);
  const session = await l.join();
  await l.publish(session, 0, [{ id: "a", label: "A" }]);
  await l.publish(session, 1, [{ id: "a", label: "A", status: "cancelled" }]);
  const diff = planReadDiffResultSchema.parse(await l.read({ compare_to: 1 }));
  assert.equal(diff.plan_revision, 2);
  assert.deepEqual(diff.added, {});
  assert.deepEqual(diff.changed, {});
  assert.deepEqual(diff.removed, []);
});

test("current revision uses live tasks while past revisions stop at publication", async (context) => {
  const l = await ledger(context);
  const session = await l.join();
  await l.publish(session, 0, [{ id: "a", label: "Published" }]);
  const published = planReadMapResultSchema.parse(await l.read());
  await l.board.database.write(projectIdSchema.parse("p"), (tx) => {
    tx.actorId = session;
    const task = tx.getTask(taskIdSchema.parse("a"));
    tx.putTask(task.id, { ...task, label: "Live" });
    tx.flush();
  });
  const current = planReadMapResultSchema.parse(
    await l.read({ revision: null, compare_to: null }),
  );
  assert.deepEqual(current.task_map, { a: { label: "Live", depends_on: [] } });
  assert.deepEqual(current.metadata, published.metadata);
  await l.publish(session, 1, [{ id: "a", label: "Next publication" }]);
  assert.deepEqual(await l.read({ revision: 1 }), published);
});

test("plan edits preserve unchanged tasks and supersedes in history", async (context) => {
  const l = await ledger(context);
  const session = await l.join();
  await l.publish(session, 0, [
    { id: "a", label: "A" },
    { id: "b", label: "B", depends_on: ["a"] },
  ]);
  const first = await l.read();
  await l.board.call("plan_edit", {
    project_id: "p",
    request_id: l.requestId(),
    session_id: session,
    expected_revision: 1,
    operations: [
      { op: "update", task_id: "a", label: "Old A", status: "cancelled" },
      { op: "add", task: { id: "c", label: "C", supersedes: ["a"] } },
      { op: "update", task_id: "b", depends_on: ["c"] },
    ],
  });
  const second = planReadMapResultSchema.parse(await l.read());
  assert.deepEqual(second.task_map, {
    a: { label: "Old A", depends_on: [] },
    b: { label: "B", depends_on: ["c"] },
    c: { label: "C", depends_on: [], supersedes: ["a"] },
  });
  await l.board.call("plan_edit", {
    project_id: "p",
    request_id: l.requestId(),
    session_id: session,
    expected_revision: 2,
    operations: [{ op: "update", task_id: "c", supersedes: [] }],
  });
  assert.deepEqual(await l.read({ revision: 1 }), first);
  assert.deepEqual(await l.read({ revision: 2 }), second);
  const diff = planReadDiffResultSchema.parse(await l.read({ compare_to: 2 }));
  assert.deepEqual(diff.added, {});
  assert.deepEqual(diff.changed, {
    c: {
      before: { label: "C", depends_on: [], supersedes: ["a"] },
      after: { label: "C", depends_on: [] },
    },
  });
  assert.deepEqual(diff.removed, []);
});

test("missing publication history reports not_found for both endpoints", async (context) => {
  const l = await ledger(context);
  const session = await l.join();
  await l.publish(session, 0, [{ id: "a", label: "A" }]);
  await l.publish(session, 1, [{ id: "a", label: "Later" }]);
  await l.board.database.write(projectIdSchema.parse("p"), (tx) => {
    tx.execute(
      `DELETE FROM changes WHERE project_id = ? AND EXISTS (
      SELECT 1 FROM json_each(changes.body) AS item
      WHERE json_extract(item.value, '$.kind') = 'project'
        AND json_extract(item.value, '$.record.plan_revision') = 1
    )`,
      [tx.projectId],
    );
  });
  for (const fields of [{ revision: 1 }, { compare_to: 1 }]) {
    await assert.rejects(
      l.read(fields),
      (error: unknown) =>
        error instanceof BoardError &&
        error.code === "not_found" &&
        error.message === "Plan revision history was not found",
    );
  }
});
