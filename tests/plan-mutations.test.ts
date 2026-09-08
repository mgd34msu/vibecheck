import assert from "node:assert/strict";
import test from "node:test";
import type { Board } from "../src/board.js";
import type { BoardErrorCode } from "../src/errors.js";
import { projectIdSchema } from "../src/schemas.js";
import {
  createLedger,
  join,
  prepare,
  progress,
  PROJECT,
  publish,
  rejectsCode,
  request,
  snapshot,
} from "./helpers.js";

function edit(
  board: Board,
  session: string,
  revision: number,
  operations: unknown[],
  requestId = request(),
) {
  return board.call("plan_edit", {
    project_id: PROJECT,
    request_id: requestId,
    session_id: session,
    expected_revision: revision,
    operations,
  });
}

function add(id: string) {
  return { op: "add", task: { id, label: id.toUpperCase() } };
}

test("atomic plan edits accept forward references and return complete maps without work", async (t) => {
  const { board } = await createLedger(t);
  const session = await join(board);
  const result = await edit(board, session, 0, [
    {
      op: "add",
      task: { id: "b", label: "B", depends_on: ["a"], supersedes: ["a"] },
    },
    add("a"),
  ]);
  assert.equal(result.plan_revision, 1);
  assert.deepEqual(result.task_map, {
    a: { label: "A", depends_on: [] },
    b: { label: "B", depends_on: ["a"], supersedes: ["a"] },
  });
  assert.deepEqual(result.tasks, {
    a: { revision: 1, status: "pending" },
    b: { revision: 1, status: "pending" },
  });
  assert.deepEqual((await snapshot(board)).work, {});
  const delta = await board.call("project_status", {
    project_id: PROJECT,
    since: 0,
  });
  assert.ok("changes" in delta);
  assert.equal(delta.changes.length, 2);
});

test("omitted edit fields preserve cancelled state and lineage while explicit arrays clear them", async (t) => {
  const { board } = await createLedger(t);
  const session = await join(board);
  const first = await edit(board, session, 0, [
    add("a"),
    {
      op: "add",
      task: {
        id: "b",
        label: "B",
        depends_on: ["a"],
        supersedes: ["a"],
        status: "cancelled",
      },
    },
  ]);
  const renamed = await edit(board, session, 1, [
    { op: "update", task_id: "b", label: "Renamed" },
  ]);
  assert.deepEqual(renamed.task_map.b, {
    label: "Renamed",
    depends_on: ["a"],
    supersedes: ["a"],
  });
  assert.equal(renamed.tasks.b?.status, "cancelled");
  assert.deepEqual(renamed.tasks.a, first.tasks.a);
  const cleared = await edit(board, session, 2, [
    { op: "update", task_id: "b", supersedes: [], depends_on: [] },
  ]);
  assert.deepEqual(cleared.task_map.b, { label: "Renamed", depends_on: [] });
  assert.equal(cleared.tasks.b?.revision, 3);
  const historical = await board.call("plan_read", {
    project_id: PROJECT,
    revision: 1,
  });
  assert.ok("task_map" in historical);
  assert.deepEqual(historical.task_map.b?.supersedes, ["a"]);
});

test("full publication preserves omitted status and lineage and never deletes old IDs", async (t) => {
  const { board } = await createLedger(t);
  const session = await join(board);
  const first = await edit(board, session, 0, [
    add("a"),
    {
      op: "add",
      task: { id: "b", label: "B", supersedes: ["a"], status: "cancelled" },
    },
  ]);
  const second = await board.call("plan_publish", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    expected_revision: 1,
    tasks: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
  });
  assert.deepEqual(second.tasks, first.tasks);
  assert.deepEqual(second.task_map, first.task_map);
  assert.equal(second.plan_revision, 2);
  const before = await snapshot(board);
  await rejectsCode(
    board.call("plan_publish", {
      project_id: PROJECT,
      request_id: request(),
      session_id: session,
      expected_revision: 2,
      tasks: [{ id: "b", label: "B" }],
    }),
    "invalid",
  );
  assert.deepEqual(await snapshot(board), before);
});

for (const field of ["depends_on", "supersedes"]) {
  for (const edges of [["missing"], ["a"], ["b", "b"]]) {
    test(`${field} rejects missing, self or duplicate references ${JSON.stringify(edges)} atomically`, async (t) => {
      const { board } = await createLedger(t);
      const session = await join(board);
      const before = await snapshot(board);
      await rejectsCode(
        edit(board, session, 0, [
          { op: "add", task: { id: "a", label: "A", [field]: edges } },
          add("b"),
        ]),
        "invalid",
      );
      assert.deepEqual(await snapshot(board), before);
    });
  }
  test(`${field} cycle validation uses the final inventory and rolls back prior additions`, async (t) => {
    const { board } = await createLedger(t);
    const session = await join(board);
    await edit(board, session, 0, [
      add("a"),
      { op: "add", task: { id: "b", label: "B", [field]: ["a"] } },
    ]);
    const before = await snapshot(board);
    await assert.rejects(
      edit(board, session, 1, [
        add("c"),
        { op: "update", task_id: "a", [field]: ["b"] },
      ]),
      /cycle/,
    );
    assert.deepEqual(await snapshot(board), before);
  });
}

test("execution and lineage graphs remain independent", async (t) => {
  const { board } = await createLedger(t);
  const session = await join(board);
  const result = await edit(board, session, 0, [
    { op: "add", task: { id: "a", label: "A", depends_on: ["b"] } },
    { op: "add", task: { id: "b", label: "B", supersedes: ["a"] } },
  ]);
  assert.deepEqual(result.task_map.a?.depends_on, ["b"]);
  assert.deepEqual(result.task_map.b?.supersedes, ["a"]);
});

const invalidEdits: { operations: unknown[]; code: BoardErrorCode }[] = [
  { operations: [add("a")], code: "conflict" },
  {
    operations: [{ op: "update", task_id: "missing", label: "Missing" }],
    code: "not_found",
  },
  {
    operations: [add("b"), { op: "update", task_id: "b", label: "B2" }],
    code: "invalid",
  },
  {
    operations: [{ op: "update", task_id: "a", label: "A2" }, add("a")],
    code: "invalid",
  },
  { operations: [{ op: "update", task_id: "a" }], code: "invalid" },
];
for (const invalid of invalidEdits) {
  test(`edit targets cannot be reused or specified twice ${JSON.stringify(invalid.operations)}`, async (t) => {
    const { board } = await createLedger(t);
    const session = await join(board);
    await edit(board, session, 0, [
      { op: "add", task: { id: "a", label: "A", status: "cancelled" } },
    ]);
    const before = await snapshot(board);
    await rejectsCode(
      edit(board, session, 1, invalid.operations),
      invalid.code,
    );
    assert.deepEqual(await snapshot(board), before);
  });
}

test("exact edit retry replays its original result after newer changes without advancing history", async (t) => {
  const { board } = await createLedger(t);
  const session = await join(board);
  const first = await edit(board, session, 0, [add("a")], "edit-once");
  await edit(board, session, 1, [add("b")]);
  const before = await snapshot(board);
  assert.deepEqual(
    await edit(board, session, 0, [add("a")], "edit-once"),
    first,
  );
  await rejectsCode(edit(board, session, 1, [add("c")]), "conflict");
  await rejectsCode(
    edit(board, session, 0, [add("different")], "edit-once"),
    "conflict",
  );
  assert.deepEqual(await snapshot(board), before);
});

for (const status of ["pending", "cancelled"]) {
  test(`plan cannot reset owned work to ${status}, and split-merge lineage remains passive`, async (t) => {
    const { board } = await createLedger(t);
    const { session, task, work } = await prepare(board);
    const before = await snapshot(board);
    await rejectsCode(
      edit(board, session, 1, [
        add("c"),
        { op: "update", task_id: "a", status },
      ]),
      "conflict",
    );
    assert.deepEqual(await snapshot(board), before);
    const result = await edit(board, session, 1, [
      { op: "add", task: { id: "c", label: "C", supersedes: ["a"] } },
      { op: "add", task: { id: "d", label: "D", supersedes: ["a"] } },
      { op: "add", task: { id: "e", label: "E", supersedes: ["c", "d"] } },
    ]);
    assert.deepEqual(result.tasks.a, {
      revision: task.revision,
      status: "in_progress",
      owner_work_id: work.id,
    });
    assert.deepEqual(Object.keys((await snapshot(board)).work), [work.id]);
    const updated = await edit(board, session, 2, [
      { op: "update", task_id: "b", supersedes: ["c", "d"] },
    ]);
    assert.deepEqual(updated.task_map.b?.supersedes, ["c", "d"]);
    assert.equal(updated.tasks.a?.owner_work_id, work.id);
  });
}

test("editing a live definition preserves work but invalidates its old task revision", async (t) => {
  const { board } = await createLedger(t);
  const state = await prepare(board);
  const edited = await edit(board, state.session, 1, [
    { op: "update", task_id: "a", label: "Changed scope" },
  ]);
  assert.equal(edited.tasks.a?.revision, state.task.revision + 1);
  assert.equal(edited.tasks.a?.owner_work_id, state.work.id);
  await rejectsCode(
    progress(board, state.session, state.task, state.work, {
      status: "complete",
    }),
    "conflict",
  );
});

test("plan edits validate the final graph and cancel or restore unclaimed tasks without creating work", async (t) => {
  const { board } = await createLedger(t);
  const session = await join(board);
  await edit(board, session, 0, [
    { op: "add", task: { id: "a", label: "A", depends_on: ["b"] } },
    add("b"),
  ]);
  const cancelled = await edit(board, session, 1, [
    { op: "update", task_id: "b", depends_on: ["a"] },
    { op: "update", task_id: "a", depends_on: [], status: "cancelled" },
  ]);
  assert.equal(cancelled.tasks.a?.status, "cancelled");
  const restored = await edit(board, session, 2, [
    { op: "update", task_id: "a", status: "pending" },
  ]);
  assert.deepEqual(restored.tasks.a, { revision: 3, status: "pending" });
  assert.deepEqual((await snapshot(board)).work, {});
});

test("accumulated edits enforce the 10000-task limit and validate a deep lineage cycle iteratively", async (t) => {
  const { board } = await createLedger(t);
  const session = await join(board);
  const operations = Array.from({ length: 10000 }, (_, index) => ({
    op: "add",
    task: {
      id: `t${index}`,
      label: `T${index}`,
      supersedes: index === 0 ? [] : [`t${index - 1}`],
    },
  }));
  const first = await edit(board, session, 0, operations);
  assert.equal(Object.keys(first.task_map).length, 10000);
  await assert.rejects(edit(board, session, 1, [add("overflow")]), /10000/);
  await assert.rejects(
    edit(board, session, 1, [
      { op: "update", task_id: "t0", supersedes: ["t9999"] },
    ]),
    /cycle/,
  );
  const plan = await board.call("plan_read", { project_id: PROJECT });
  assert.equal(plan.plan_revision, 1);
});

test("acknowledgment is explicit and monotonic, preserves repeated timestamps, and replays old receipts", async (t) => {
  const { board } = await createLedger(t);
  const session = await join(board);
  const ack = (revision: number, requestId = request()) =>
    board.call("plan_ack", {
      project_id: PROJECT,
      request_id: requestId,
      session_id: session,
      plan_revision: revision,
    });
  const zero = await ack(0, "ack-once");
  await publish(board, session);
  await snapshot(board);
  await board.call("plan_read", { project_id: PROJECT });
  await board.call("work_update", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    updates: [],
  });
  await join(board);
  const stored = await board.database.read(
    projectIdSchema.parse(PROJECT),
    (tx) => tx.getSession(session),
  );
  assert.equal(stored.acknowledged_plan_revision, 0);
  assert.equal((await ack(0)).acknowledged_at, zero.acknowledged_at);
  const one = await ack(1);
  assert.equal(one.acknowledged_plan_revision, 1);
  assert.deepEqual(await ack(0, "ack-once"), zero);
  assert.equal((await ack(1)).acknowledged_at, one.acknowledged_at);
  await rejectsCode(ack(0), "conflict");
  await rejectsCode(ack(2), "invalid");
});

test("only the coordinator edits plans while child acknowledgment touches only its own session", async (t) => {
  const { board } = await createLedger(t);
  const root = await join(board);
  const child = await join(board, "child", root);
  await publish(board, root);
  const acknowledged = await board.call("plan_ack", {
    project_id: PROJECT,
    request_id: request(),
    session_id: child,
    plan_revision: 1,
  });
  assert.equal(acknowledged.session_id, child);
  const stored = await board.database.read(
    projectIdSchema.parse(PROJECT),
    (tx) => tx.getSession(root),
  );
  assert.equal(stored.acknowledged_plan_revision, undefined);
  const before = await snapshot(board);
  await rejectsCode(edit(board, child, 1, [add("c")]), "forbidden");
  assert.deepEqual(await snapshot(board), before);
});

test("split and merge lineage preserves completed work and prior definition maps", async (t) => {
  const { board } = await createLedger(t);
  const state = await prepare(board);
  await progress(board, state.session, state.task, state.work, {
    status: "complete",
  });
  const split = await edit(board, state.session, 1, [
    { op: "add", task: { id: "left", label: "Left", supersedes: ["a"] } },
    { op: "add", task: { id: "right", label: "Right", supersedes: ["a"] } },
    {
      op: "add",
      task: { id: "merged", label: "Merged", supersedes: ["left", "right"] },
    },
  ]);
  assert.equal(split.tasks.a?.status, "complete");
  assert.equal(split.tasks.a?.owner_work_id, state.work.id);
  for (const id of ["left", "right", "merged"])
    assert.equal(split.tasks[id]?.owner_work_id, undefined);
  await edit(board, state.session, 2, [
    { op: "update", task_id: "merged", supersedes: [] },
  ]);
  const historical = await board.call("plan_read", {
    project_id: PROJECT,
    revision: 2,
  });
  assert.ok("task_map" in historical);
  assert.deepEqual(historical.task_map, split.task_map);
  const current = await board.call("plan_read", { project_id: PROJECT });
  assert.ok("task_map" in current);
  assert.equal(current.task_map.merged?.supersedes, undefined);
  const history = await board.call("work_history", {
    project_id: PROJECT,
    branch: "feature",
  });
  assert.equal(history.work[0]?.id, state.work.id);
  assert.equal(history.work[0]?.task_id, "a");
  assert.equal(history.work[0]?.status, "complete");
  const before = await snapshot(board);
  await rejectsCode(edit(board, state.session, 3, [add("a")]), "conflict");
  assert.deepEqual(await snapshot(board), before);
});

test("late dependency edits extend contributor blocking paths without transferring ownership", async (t) => {
  const { board } = await createLedger(t);
  const root = await join(board);
  const child = await join(board, "child", root);
  await publish(board, root, [
    { id: "a", label: "A" },
    { id: "b", label: "B", depends_on: ["a"] },
    { id: "c", label: "C", depends_on: ["b"] },
  ]);
  const owner = await board.call("work_claim", {
    project_id: PROJECT,
    request_id: request(),
    session_id: root,
    task_id: "a",
    expected_revision: 1,
  });
  const contribution = await board.call("work_claim", {
    project_id: PROJECT,
    request_id: request(),
    session_id: child,
    task_id: "a",
    expected_revision: owner.task.revision,
    parent_work_id: owner.work.id,
  });
  const blocked = await progress(board, child, owner.task, contribution.work, {
    status: "blocked",
    blocker: "Await fixture",
  });
  const before = await snapshot(board);
  assert.ok("task_ids" in before.blocking_path);
  assert.deepEqual(before.blocking_path.task_ids, ["a", "b", "c"]);
  await edit(board, root, 1, [
    { op: "add", task: { id: "d", label: "D", depends_on: ["c"] } },
  ]);
  const after = await board.call("project_status", {
    project_id: PROJECT,
    known_plan_revision: 1,
  });
  assert.ok("tasks" in after);
  assert.deepEqual(after.blocking_path, {
    length: 4,
    blocked_count: 1,
    task_ids: ["a", "b", "c", "d"],
    blocked_task_ids: ["a"],
  });
  assert.deepEqual(after.task_map?.d?.depends_on, ["c"]);
  assert.deepEqual(after.tasks.a, before.tasks.a);
  assert.equal(after.tasks.a?.owner_work_id, owner.work.id);
  assert.equal(after.work[contribution.work.id]?.status, "blocked");
  await progress(board, child, owner.task, blocked.work, {
    status: "complete",
  });
  const unblocked = await snapshot(board);
  assert.equal(unblocked.blocking_path.length, 0);
  assert.equal(unblocked.tasks.a?.owner_work_id, owner.work.id);
});
