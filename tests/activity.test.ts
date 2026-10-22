import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
  const operator = await board.call("project_join", {
    project_id: PROJECT,
    request_id: request(),
    repository: "repo",
    vendor: "local",
    runtime: "operator",
    external_session_id: "workspace",
    model: "not-applicable",
    actor_kind: "human",
  });
  const impersonated = await fetch(origin + `/v1/projects/${PROJECT}/command`, {
    method: "POST",
    headers: {
      Authorization: "Bearer collect",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tool: "plan_ack",
      request: {
        project_id: PROJECT,
        session_id: operator.session_id,
        request_id: request(),
        plan_revision: 0,
      },
    }),
  });
  assert.equal(impersonated.status, 403);
  const rejoined = await fetch(origin + `/v1/projects/${PROJECT}/command`, {
    method: "POST",
    headers: {
      Authorization: "Bearer collect",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tool: "project_join",
      request: {
        project_id: PROJECT,
        request_id: request(),
        repository: "repo",
        vendor: "local",
        runtime: "operator",
        external_session_id: "workspace",
        model: "not-applicable",
      },
    }),
  });
  assert.equal(rejoined.status, 403);
  const remote = new RemoteLedger(origin, "manage");
  const result = await remote.call("project_status", { project_id: PROJECT });
  assert.ok("sessions" in result);
  const other = await fetch(origin + "/v1/projects/foreign/snapshot", {
    headers: { Authorization: "Bearer observe" },
  });
  assert.equal(other.status, 403);
});
test("HTTP shutdown closes active observer streams on Bun", async (t) => {
  const { board } = await setup(t);
  const app = createHttpApp(board, { token: "manage" });
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const stream = await fetch(
    `http://127.0.0.1:${address.port}/v1/projects/${PROJECT}/stream`,
    { headers: { Authorization: "Bearer manage" } },
  );
  assert.equal(stream.status, 200);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      app.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("HTTP listener did not close its active stream")),
          2000,
        );
      }),
    ]);
    assert.equal(app.server.listening, false);
  } finally {
    clearTimeout(timer);
    await stream.body?.cancel().catch(() => {});
  }
});
test("managed HTTP service exits when its owner pipe closes", async (t) => {
  const directory = await mkdtemp(pathJoin(tmpdir(), "vibecheck-owner-"));
  const child = spawn(
    process.execPath,
    [
      "src/cli.ts",
      "--transport",
      "streamable-http",
      "--managed",
      "--port",
      "0",
      "--database",
      pathJoin(directory, "work.sqlite3"),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PROJECT_BOARD_TOKEN: "owner-test-token",
        VIBECHECK_SERVICE_URL: undefined,
      },
    },
  );
  t.after(() => child.kill("SIGKILL"));
  const stopped = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  await once(child.stdout, "data", { signal: AbortSignal.timeout(5000) });
  child.stdin.end();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      stopped,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Managed service survived owner EOF")),
          2000,
        );
      }),
    ]);
    assert.deepEqual(result, { code: 0, signal: null });
  } finally {
    clearTimeout(timer);
  }
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
  assert.equal(
    initial.events.length,
    2,
    JSON.stringify((await activity.snapshot(PROJECT)).sources),
  );
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

for (const existing of [false, true])
  test(`Codex collection prioritizes current activity and backfills ${existing ? "an existing" : "a new"} checkpoint`, async (t) => {
    const { board, activity } = await setup(t);
    const directory = await mkdtemp(
      pathJoin(tmpdir(), "vibecheck-codex-history-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const root = pathJoin(directory, "project");
    await mkdir(root);
    const tree = { id: "history-tree", repository: "repo", root };
    await activity.worktree(PROJECT, tree);
    const row = (timestamp: string, type: string, payload: object) =>
      JSON.stringify({ timestamp, type, payload }) + "\n";
    const old = (type: string, payload: object) =>
      row("2026-10-16T12:00:00Z", type, payload);
    const live = (type: string, payload: object) =>
      row("2026-10-22T12:00:00Z", type, payload);
    const file = pathJoin(directory, "session.jsonl");
    await writeFile(
      file,
      old("session_meta", { id: "long-lived", cwd: root }) +
        old("turn_context", { model: "old-model" }) +
        old("event_msg", { type: "task_complete" }) +
        Array.from({ length: 20 }, () =>
          old("response_item", {
            type: "reasoning",
            summary: "PRIVATE".repeat(70_000),
          }),
        ).join("") +
        live("turn_context", { model: "current-model", effort: "high" }) +
        live("event_msg", { type: "task_started", turn_id: "current-turn" }),
    );
    if (existing) {
      const complete = await import("node:fs/promises").then((fs) =>
        fs.readFile(file, "utf8"),
      );
      await writeFile(
        file,
        old("session_meta", { id: "long-lived", cwd: root }) +
          old("turn_context", { model: "old-model" }) +
          old("event_msg", { type: "task_complete" }),
      );
      const prior = new CodexCollector(activity, PROJECT, tree, directory);
      await prior.poll();
      await prior.close();
      await writeFile(file, complete);
    }
    const collector = new CodexCollector(activity, PROJECT, tree, directory);
    await collector.poll();
    const initial = await activity.snapshot(PROJECT);
    assert.equal(
      initial.activity.find((a) => a.run_id === "current-turn")?.state,
      "running",
    );
    assert.ok(
      initial.sources
        .find((s) => s.id === "codex")
        ?.detail?.includes("background"),
    );
    assert.equal(
      Object.values(initial.sessions).find(
        (s) => s.external_session_id === "long-lived",
      )?.model,
      "current-model",
    );
    await collector.close();
    const resumed = new CodexCollector(
      new ActivityStore(board),
      PROJECT,
      tree,
      directory,
    );
    await appendFile(
      file,
      row("2026-10-22T12:00:01Z", "response_item", {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ text: "Current public activity" }],
      }),
    );
    await resumed.poll();
    assert.ok(
      (await activity.events(PROJECT, { limit: 500 })).events.some(
        (e) => e.summary === "Current public activity",
      ),
    );
    for (let i = 0; i < 8; i++) await resumed.poll();
    await appendFile(
      file,
      row("2026-10-22T12:00:02Z", "turn_context", {
        model: "alternate-model",
      }) +
        row("2026-10-22T12:00:03Z", "turn_context", { model: "current-model" }),
    );
    await resumed.poll();
    await resumed.close();
    const final = await activity.snapshot(PROJECT);
    const events = (await activity.events(PROJECT, { limit: 500 })).events;
    assert.equal(events.length, 3); // Old completion, current start and public message, each once.
    assert.equal(JSON.stringify(events).includes("PRIVATE"), false);
    assert.equal(
      final.activity.find((a) => a.run_id === "current-turn")?.state,
      "running",
    );
    assert.equal(
      Object.values(final.sessions).find(
        (s) => s.external_session_id === "long-lived",
      )?.model,
      "current-model",
    );
    assert.equal(
      final.sources.find((s) => s.id === "codex")?.status,
      "connected",
    );
    assert.ok(
      !final.sources
        .find((s) => s.id === "codex")
        ?.detail?.includes("background"),
    );
  });

test("Codex records larger than a chunk are imported without exposing private context", async (t) => {
  const { activity } = await setup(t);
  const directory = await mkdtemp(
    pathJoin(tmpdir(), "vibecheck-codex-large-record-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = pathJoin(directory, "project");
  await mkdir(root);
  const tree = { id: "large-tree", repository: "repo", root };
  await activity.worktree(PROJECT, tree);
  const row = (type: string, payload: object) =>
    JSON.stringify({ timestamp: "2026-10-22T12:00:00Z", type, payload }) + "\n";
  await writeFile(
    pathJoin(directory, "session.jsonl"),
    row("session_meta", { id: "large-session", cwd: root }) +
      row("response_item", {
        type: "message",
        role: "developer",
        content: [{ text: "PRIVATE".repeat(500_000) }],
      }) +
      row("event_msg", { type: "task_started" }),
  );
  const collector = new CodexCollector(activity, PROJECT, tree, directory);
  await collector.poll();
  await collector.poll();
  await collector.close();
  const events = (await activity.events(PROJECT, {})).events;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "turn_started");
  assert.equal(JSON.stringify(events).includes("PRIVATE"), false);
  assert.equal(
    (await activity.snapshot(PROJECT)).sources.find((s) => s.id === "codex")
      ?.status,
    "connected",
  );
});
