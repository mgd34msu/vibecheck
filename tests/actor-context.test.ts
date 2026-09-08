import assert from "node:assert/strict";
import test from "node:test";
import { projectIdSchema, taskIdSchema } from "../src/schemas.js";
import { createLedger, join, PROJECT, publish, request } from "./helpers.js";

test("same-timestamp corrections retain the actor's historical identity without a heartbeat write", async (t) => {
  const { board } = await createLedger(t);
  const projectId = projectIdSchema.parse(PROJECT);
  const originalToISOString = Date.prototype.toISOString;
  let timestamp = "2026-09-08T12:00:00.000Z";
  Date.prototype.toISOString = () => timestamp;
  try {
    const coordinator = await join(board, "coordinator");
    const worker = await join(board, "unrelated-worker");
    await publish(board, coordinator, [{ id: "task", label: "Task" }]);
    const claimed = await board.call("work_claim", {
      project_id: PROJECT,
      request_id: request(),
      session_id: worker,
      task_id: "task",
      expected_revision: 1,
    });
    const actorBefore = await board.database.read(projectId, (tx) =>
      tx.getSession(coordinator),
    );
    const corrected = await board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: coordinator,
      updates: [
        {
          work_id: claimed.work.id,
          expected_revision: claimed.work.revision,
          location: { branch: "corrected" },
        },
      ],
    });
    const delta = await board.call("project_status", {
      project_id: PROJECT,
      since: claimed.cursor,
    });
    assert.ok("changes" in delta);
    assert.equal(delta.changes.length, 1);
    const batch = delta.changes[0];
    assert.ok(batch);
    assert.equal(batch.seq, corrected.cursor);
    assert.equal(batch.actor_id, coordinator);
    const actorContext = batch.records
      .filter((entry) => entry.kind === "session")
      .find((entry) => entry.id === coordinator);
    assert.ok(
      actorContext,
      "the correcting coordinator must be captured even when its heartbeat is unchanged",
    );
    assert.equal(actorContext.context, true);
    assert.deepEqual(actorContext.record, actorBefore);
    assert.deepEqual(
      await board.database.read(projectId, (tx) => tx.getSession(coordinator)),
      actorBefore,
    );
    const unchanged = await board.call("work_update", {
      project_id: PROJECT,
      request_id: request(),
      session_id: coordinator,
      updates: [],
    });
    assert.equal(
      unchanged.cursor,
      corrected.cursor,
      "context alone must not create a change batch",
    );

    timestamp = "2026-09-08T12:00:01.000Z";
    await board.call("project_join", {
      project_id: PROJECT,
      request_id: request(),
      repository: "repo",
      vendor: "openai",
      runtime: "codex",
      external_session_id: "coordinator",
      model: "refreshed-model",
      effort: "low",
    });
    const history = await board.call("work_history", {
      project_id: PROJECT,
      task_id: "task",
    });
    const historicalBatch = history.changes.find(
      (entry) => entry.seq === corrected.cursor,
    );
    assert.ok(historicalBatch);
    const historicalActor = historicalBatch.records
      .filter((entry) => entry.kind === "session")
      .find((entry) => entry.id === coordinator);
    assert.deepEqual(historicalActor, actorContext);
    assert.equal(historicalActor?.record.model, "astra");
    assert.equal(historicalActor?.record.effort, "high");
    const currentActor = history.sessions.find(
      (entry) => entry.id === coordinator,
    );
    assert.equal(currentActor?.model, "refreshed-model");
    assert.equal(currentActor?.effort, "low");
    const laterDelta = await board.call("project_status", {
      project_id: PROJECT,
      since: claimed.cursor,
    });
    assert.ok("changes" in laterDelta);
    assert.deepEqual(
      laterDelta.changes.find((entry) => entry.seq === corrected.cursor),
      batch,
    );
  } finally {
    Date.prototype.toISOString = originalToISOString;
  }
});

test("a changed batch captures an unchanged actor and all ancestors, but an empty flush stays empty", async (t) => {
  const { board } = await createLedger(t);
  const projectId = projectIdSchema.parse(PROJECT);
  const root = await join(board, "root");
  const middle = await join(board, "middle", root);
  const actor = await join(board, "actor", middle);
  await publish(board, root, [{ id: "task", label: "Task" }]);
  const prior = await board.database.read(projectId, (tx) => ({
    cursor: tx.cursor(),
    sessions: [
      tx.getSession(root),
      tx.getSession(middle),
      tx.getSession(actor),
    ],
  }));
  const cursor = await board.database.write(projectId, (tx) => {
    tx.actorId = actor;
    const taskId = taskIdSchema.parse("task");
    tx.putTask(taskId, { ...tx.getTask(taskId), label: "Changed" });
    return tx.flush();
  });
  const delta = await board.call("project_status", {
    project_id: PROJECT,
    since: prior.cursor,
  });
  assert.ok("changes" in delta);
  const batch = delta.changes[0];
  assert.ok(batch);
  assert.equal(batch.seq, cursor);
  const contexts = batch.records.filter((entry) => entry.kind === "session");
  assert.equal(contexts.length, 3);
  for (const session of prior.sessions) {
    const context = contexts.find((entry) => entry.id === session.id);
    assert.ok(context);
    assert.equal(context.context, true);
    assert.deepEqual(context.record, session);
    assert.deepEqual(
      await board.database.read(projectId, (tx) => tx.getSession(session.id)),
      session,
    );
  }
  assert.equal(
    await board.database.write(projectId, (tx) => {
      tx.actorId = actor;
      return tx.flush();
    }),
    cursor,
  );
  const noChanges = await board.call("project_status", {
    project_id: PROJECT,
    since: cursor,
  });
  assert.ok("changes" in noChanges);
  assert.deepEqual(noChanges.changes, []);
});
