import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { ActivityStore } from "../src/activity.js";
import { createHttpApp } from "../src/server.js";
import { RemoteLedger } from "../src/remote.js";
import { CodexCollector } from "../src/codex-collector.js";
import { createLedger, join, PROJECT, request, publish } from "./helpers.js";

async function setup(t: Parameters<typeof createLedger>[0]) {
  const { board, path } = await createLedger(t);
  const session = await join(board);
  const activity = new ActivityStore(board);
  await activity.initialize();
  await activity.worktree(PROJECT, {
    id: "tree",
    repository: "repo",
    root: "/project",
  });
  await activity.source(PROJECT, {
    id: "host",
    name: "Host",
    capabilities: ["identity", "lifecycle", "files"],
  });
  const event = {
    id: "event-1",
    session_id: session,
    source_id: "host",
    worktree_id: "tree",
    occurred_at: "2026-10-21T10:00:00Z",
    kind: "file_edit",
    basis: "host_event",
    paths: ["src/a.ts"],
    summary: "Edited A",
  };
  return { board, path, session, activity, event };
}
test("activity extension preserves semantic targets and plan definition history", async (t) => {
  const { board, session } = await setup(t);
  const published = await board.call("plan_publish", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    expected_revision: 0,
    tasks: [
      {
        id: "a",
        label: "A",
        semantic_targets: [
          { workspace_id: "workspace", node_id: "model:capability" },
        ],
        description: "Intent",
        acceptance: ["It works"],
        priority: "high",
      },
    ],
  });
  assert.equal(
    published.task_map.a?.semantic_targets?.[0]?.node_id,
    "model:capability",
  );
  await board.call("plan_edit", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    expected_revision: 1,
    operations: [{ op: "update", task_id: "a", description: "Changed" }],
  });
  const original = await board.call("plan_read", {
    project_id: PROJECT,
    revision: 1,
  });
  assert.ok("task_map" in original);
  assert.equal(original.task_map.a?.description, "Intent");
});
test("activity batches deduplicate, reject changed IDs, and roll back atomically", async (t) => {
  const { activity, event } = await setup(t);
  const first = await activity.ingest(PROJECT, { events: [event] });
  assert.equal(first.inserted, 1);
  assert.equal(
    (await activity.ingest(PROJECT, { events: [event] })).inserted,
    0,
  );
  await assert.rejects(
    activity.ingest(PROJECT, { events: [{ ...event, summary: "Different" }] }),
    /reused/,
  );
  await assert.rejects(
    activity.ingest(PROJECT, {
      events: [
        { ...event, id: "new" },
        { ...event, id: "bad", session_id: "missing" },
      ],
    }),
  );
  assert.equal((await activity.events(PROJECT, {})).events.length, 1);
});
test("late events retain history without overwriting current lifecycle", async (t) => {
  const { activity, event } = await setup(t);
  await activity.ingest(PROJECT, {
    events: [
      {
        ...event,
        id: "new",
        state: "waiting",
        kind: "session_state",
        occurred_at: "2026-10-21T11:00:00Z",
      },
      event,
    ],
  });
  const snapshot = await activity.snapshot(PROJECT);
  assert.equal(snapshot.activity[0]?.state, "waiting");
  assert.equal(snapshot.files.length, 2);
  const page = await activity.events(PROJECT, { limit: 1 });
  assert.equal(page.has_more, true);
  const next = await activity.events(PROJECT, { since: page.cursor });
  assert.equal(next.events.length, 1);
  await assert.rejects(
    activity.events(PROJECT, { instance_id: "replaced-database" }),
    /reset/,
  );
});
test("paths, worktree identities and project boundaries are enforced", async (t) => {
  const { activity, event } = await setup(t);
  await assert.rejects(
    activity.ingest(PROJECT, { events: [{ ...event, paths: ["../escape"] }] }),
  );
  await assert.rejects(
    activity.worktree(PROJECT, {
      id: "tree",
      repository: "repo",
      root: "/another",
    }),
    /reassigned/,
  );
  await assert.rejects(
    activity.worktree(PROJECT, {
      id: "other",
      repository: "different",
      root: "/project",
    }),
    /repository/,
  );
  await assert.rejects(activity.ingest("foreign", { events: [event] }));
});
test("work completion does not create session lifecycle and artifacts retain their version", async (t) => {
  const { board, session, activity } = await setup(t);
  await publish(board, session);
  const claimed = await board.call("work_claim", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    task_id: "a",
    expected_revision: 1,
  });
  await board.call("work_update", {
    project_id: PROJECT,
    request_id: request(),
    session_id: session,
    updates: [
      {
        work_id: claimed.work.id,
        expected_revision: 1,
        expected_task_revision: claimed.task.revision,
        status: "complete",
      },
    ],
  });
  assert.deepEqual((await activity.snapshot(PROJECT)).activity, []);
  const artifact = {
    id: "diff-1",
    session_id: session,
    work_id: claimed.work.id,
    kind: "diff",
    title: "Versioned diff",
    text: "-old\n+new",
    base_version: "abc",
    result_version: "def",
  };
  await activity.artifact(PROJECT, artifact);
  await activity.artifact(PROJECT, artifact);
  await activity.artifact(PROJECT, { ...artifact, id: "diff-2" });
  const first = await activity.artifacts(PROJECT, {
    work_id: claimed.work.id,
    limit: 1,
  });
  assert.equal(first.has_more, true);
  assert.equal(first.artifacts[0]?.id, "diff-1");
  assert.equal("text" in (first.artifacts[0] ?? {}), false);
  const second = await activity.artifacts(PROJECT, {
    work_id: claimed.work.id,
    after: first.cursor,
    limit: 1,
  });
  assert.equal(second.has_more, false);
  assert.equal(second.artifacts[0]?.id, "diff-2");
  await assert.rejects(
    activity.artifact(PROJECT, { ...artifact, text: "Changed" }),
    /immutable/,
  );
  assert.equal(
    (await activity.getArtifact(PROJECT, "diff-1")).base_version,
    "abc",
  );
});
test("observer, collector and manager credentials use distinct HTTP permissions", async (t) => {
  const { board } = await setup(t);
  const app = createHttpApp(board, {
    token: "manage",
    observerToken: "observe",
    collectorToken: "collect",
    projects: new Set([PROJECT]),
  });
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const get = await fetch(origin + `/v1/projects/${PROJECT}/snapshot`, {
    headers: { Authorization: "Bearer observe" },
  });
  assert.equal(get.status, 200);
  const denied = await fetch(origin + `/v1/projects/${PROJECT}/setup`, {
    method: "POST",
    headers: {
      Authorization: "Bearer observe",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(denied.status, 403);
  const collector = await fetch(origin + `/v1/projects/${PROJECT}/command`, {
    method: "POST",
    headers: {
      Authorization: "Bearer collect",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tool: "plan_publish",
      request: { project_id: PROJECT },
    }),
  });
  assert.equal(collector.status, 403);
  const remote = new RemoteLedger(origin, "manage");
  const result = await remote.call("project_status", { project_id: PROJECT });
  assert.ok("sessions" in result);
  const other = await fetch(origin + "/v1/projects/foreign/snapshot", {
    headers: { Authorization: "Bearer observe" },
  });
  assert.equal(other.status, 403);
});
test("Codex collector follows complete records, filters workspace and reasoning, and resumes without duplicates", async (t) => {
  const { board, path, activity } = await setup(t);
  const directory = await mkdtemp(pathJoin(tmpdir(), "vibecheck-codex-"));
  const root = pathJoin(directory, "project");
  await mkdir(root);
  const tree = { id: "codex-tree", repository: "repo", root };
  await activity.worktree(PROJECT, tree);
  const row = (type: string, payload: object) =>
    JSON.stringify({ timestamp: "2026-10-21T12:00:00Z", type, payload }) + "\n";
  const file = pathJoin(directory, "session.jsonl");
  await writeFile(
    file,
    row("session_meta", { id: "actual-session", cwd: root }) +
      row("turn_context", { model: "actual-model", effort: "high" }) +
      row("response_item", { type: "reasoning", summary: "DO NOT EXPOSE" }) +
      row("response_item", {
        type: "message",
        role: "developer",
        content: [{ text: "PRIVATE INSTRUCTIONS" }],
      }) +
      row("response_item", {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ text: "Working on A" }],
      }) +
      row("event_msg", { type: "task_started", turn_id: "real-turn" }),
  );
  await writeFile(
    pathJoin(directory, "foreign.jsonl"),
    row("session_meta", { id: "foreign-session", cwd: "/elsewhere" }) +
      row("event_msg", { type: "task_started" }),
  );
  const collector = new CodexCollector(activity, PROJECT, tree, directory);
  await collector.poll();
  const initial = await activity.events(PROJECT, {});
  assert.equal(initial.events.length, 2);
  assert.equal(JSON.stringify(initial).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(initial).includes("DO NOT EXPOSE"), false);
  await appendFile(
    file,
    '{"timestamp":"2026-10-21T12:00:01Z","type":"event_msg","payload":',
  );
  await collector.poll();
  assert.equal((await activity.events(PROJECT, {})).events.length, 2);
  await appendFile(file, '{"type":"task_complete"}}\n');
  await collector.poll();
  assert.equal((await activity.events(PROJECT, {})).events.length, 3);
  await collector.close();
  const reopened = new ActivityStore(board);
  await reopened.initialize();
  const next = new CodexCollector(reopened, PROJECT, tree, directory);
  await next.poll();
  await next.close();
  assert.equal((await activity.events(PROJECT, {})).events.length, 3);
  assert.ok(path);
});
