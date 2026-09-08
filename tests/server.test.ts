import { version } from "../src/version.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import { setTimeout } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { TestContext } from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { Board } from "../src/board.js";
import { CliUsageError, defaultDatabase, parseArgs } from "../src/cli.js";
import { createHttpApp, matchesHost } from "../src/server.js";
import type { Ledger } from "../src/server.js";
import { requestSchemas } from "../src/schemas.js";

const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
const joinResultSchema = z.object({ session_id: z.string() });
const objectSchema = z.record(z.string(), z.unknown());
const cliPath = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts") ? "../src/cli.ts" : "../src/cli.js",
    import.meta.url,
  ),
);

async function temporaryBoard(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "vibecheck-server-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "board.sqlite3");
  return { board: new Board(path), path, directory };
}

async function runningHttp(
  t: TestContext,
  board: Ledger,
  allowedHosts: string[] = [],
) {
  const app = createHttpApp(board, {
    token: "test-secret",
    projects: new Set(["allowed"]),
    allowedHosts,
  });
  t.after(() => app.close());
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const client = new Client({ name: "vibecheck-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer test-secret" } },
    }),
  );
  return { client, url, app };
}

async function call(client: Client, name: string, request: object) {
  const result = await client.callTool({
    name,
    arguments: { request: { project_id: "allowed", ...request } },
  });
  assert.equal(result.isError, false, JSON.stringify(result));
  const content = result.content[0];
  assert.ok(content && content.type === "text");
  assert.equal(content.text, JSON.stringify(result.structuredContent));
  return objectSchema.parse(result.structuredContent);
}

function rawRequest(url: URL, headers: string[]) {
  return new Promise<{
    status: number | undefined;
    body: string;
    challenge: string | undefined;
  }>((resolve, reject) => {
    const outgoing = httpRequest(
      url,
      { method: "POST", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: unknown) => {
          if (Buffer.isBuffer(chunk)) chunks.push(chunk);
          else reject(new Error("Unexpected response chunk"));
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString(),
            challenge: response.headers["www-authenticate"],
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end("{}");
  });
}

test("HTTP exposes the nine typed tools and preserves structured results, validation, and restrictions", async (t) => {
  const { board } = await temporaryBoard(t);
  const { client } = await runningHttp(t, board);
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    Object.keys(requestSchemas).sort(),
  );
  for (const tool of listed.tools) {
    assert.deepEqual(tool.inputSchema.required, ["request"]);
    assert.equal(tool.annotations?.openWorldHint, false);
    assert.equal(
      tool.annotations?.readOnlyHint,
      ["plan_read", "project_status", "work_history"].includes(tool.name),
    );
  }
  const denied = await client.callTool({
    name: "project_status",
    arguments: { request: { project_id: "denied" } },
  });
  assert.equal(denied.isError, true);
  assert.equal(
    errorSchema.parse(denied.structuredContent).error.code,
    "forbidden",
  );
  const missing = await client.callTool({
    name: "project_status",
    arguments: { request: { project_id: "allowed" } },
  });
  assert.equal(
    errorSchema.parse(missing.structuredContent).error.code,
    "not_found",
  );
  const invalid = await client.callTool({
    name: "project_status",
    arguments: { request: { project_id: "allowed", limit: 0 } },
  });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent, undefined);
  const joinRequest = {
    request_id: "join",
    repository: "repo",
    vendor: "openai",
    runtime: "codex",
    external_session_id: "session",
    model: "astra",
  };
  const joined = await call(client, "project_join", joinRequest);
  assert.deepEqual(await call(client, "project_join", joinRequest), joined);
  const session = joinResultSchema.parse(joined).session_id;
  const published = await call(client, "plan_publish", {
    request_id: "publish",
    session_id: session,
    expected_revision: 0,
    tasks: [
      { id: "a", label: "A" },
      { id: "b", label: "B", depends_on: ["a"] },
    ],
  });
  assert.equal(published.plan_revision, 1);
  const historical = await call(client, "plan_read", { revision: 1 });
  assert.deepEqual(historical.task_map, published.task_map);
  const claimed = await call(client, "work_claim", {
    request_id: "claim",
    session_id: session,
    task_id: "a",
    expected_revision: 1,
    location: { branch: "feature", paths: ["src/a.ts"] },
  });
  const work = z
    .object({ id: z.string(), revision: z.number() })
    .parse(claimed.work);
  const updated = await call(client, "work_update", {
    request_id: "update",
    session_id: session,
    updates: [
      {
        work_id: work.id,
        expected_revision: work.revision,
        blocker: null,
        location: { branch: "feature-2" },
      },
    ],
  });
  const updates = z
    .array(
      z.object({
        location: z.object({ branch: z.string(), paths: z.array(z.string()) }),
        blocker: z.null(),
      }),
    )
    .parse(updated.work);
  assert.deepEqual(updates[0]?.location, {
    branch: "feature-2",
    paths: ["src/a.ts"],
  });
  await call(client, "plan_edit", {
    request_id: "edit",
    session_id: session,
    expected_revision: 1,
    operations: [{ op: "update", task_id: "b", label: "B revised" }],
  });
  const comparison = await call(client, "plan_read", {
    revision: 2,
    compare_to: 1,
  });
  assert.equal("task_map" in comparison, false);
  await call(client, "plan_ack", {
    request_id: "ack",
    session_id: session,
    plan_revision: 2,
  });
  const compact = await call(client, "project_status", {});
  assert.equal("task_map" in compact, false);
  const full = await call(client, "project_status", { full: true });
  assert.ok(full.task_map);
  const history = await call(client, "work_history", { path: "src/a.ts" });
  assert.ok(history);
});

test("HTTP authentication, duplicate headers, Host patterns, and Origin guards", async (t) => {
  const { board } = await temporaryBoard(t);
  const { url } = await runningHttp(t, board, [
    "proxy.example:9000",
    "wild.example:*",
  ]);
  for (const authorization of [
    [],
    ["Authorization", "Bearer wrong"],
    ["Authorization", "Basic test-secret"],
    [
      "Authorization",
      "Bearer test-secret",
      "Authorization",
      "Bearer test-secret",
    ],
  ]) {
    const response = await rawRequest(url, [
      "Host",
      "localhost",
      "Content-Type",
      "application/json",
      ...authorization,
    ]);
    assert.equal(response.status, 401);
    assert.equal(response.challenge, "Bearer");
    assert.equal(response.body.includes("test-secret"), false);
  }
  for (const host of [
    "attacker.example",
    "proxy.example",
    "proxy.example:9001",
    "wild.example",
    "localhost.attacker.example",
    "localhost:80@evil.example",
    "localhost:",
    "localhost:abc",
    "localhost:0",
    "localhost:65536",
    "localhost:80/path",
    "localhost:80?query",
    "localhost:80#fragment",
    "localhost: 80",
    "[::1]:80@evil.example",
    "[::1]:",
    "[::1]:65536",
    "[invalid]:80",
  ]) {
    assert.equal(
      (
        await rawRequest(url, [
          "Host",
          host,
          "Authorization",
          "Bearer test-secret",
          "Content-Type",
          "application/json",
        ])
      ).status,
      421,
    );
  }
  for (const host of [
    "localhost",
    "localhost:1",
    "localhost:65535",
    "127.0.0.1",
    "127.0.0.1:8765",
    "[::1]",
    "[::1]:8765",
    "proxy.example:9000",
    "wild.example:9001",
  ]) {
    const response = await rawRequest(url, [
      "Host",
      host,
      "Authorization",
      "bEaReR test-secret",
      "Content-Type",
      "application/json",
    ]);
    assert.notEqual(response.status, 401);
    assert.notEqual(response.status, 421);
    assert.notEqual(response.status, 500);
  }
  assert.equal(
    (
      await rawRequest(url, [
        "Host",
        "localhost",
        "Authorization",
        "Bearer test-secret",
        "Origin",
        "https://localhost",
        "Content-Type",
        "application/json",
      ])
    ).status,
    403,
  );
  assert.throws(
    () => createHttpApp(board, { token: "secret value" }),
    /no whitespace/,
  );
  assert.equal(matchesHost("[::1]:9000", ["[::1]:*"]), true);
  assert.equal(matchesHost("[::1].evil:9000", ["[::1]:*"]), false);
});

test("unexpected backend errors are sanitized", async (t) => {
  const broken: Ledger = {
    call: async () => {
      throw new Error("secret /private/database.sqlite3");
    },
  };
  const { client } = await runningHttp(t, broken);
  const result = await client.callTool({
    name: "project_status",
    arguments: { request: { project_id: "allowed" } },
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: { code: "internal", message: "Internal server error." },
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("CLI defaults and environment match the database and project contract", () => {
  const options = parseArgs([], { XDG_DATA_HOME: "/tmp/data" });
  assert.equal(options.database, "/tmp/data/project-board/board.sqlite3");
  assert.equal(options.transport, "stdio");
  assert.equal(options.host, "127.0.0.1");
  assert.equal(options.port, 8765);
  assert.equal(options.projects, undefined);
  assert.equal(
    defaultDatabase({ PROJECT_BOARD_DB: "/tmp/override.db" }),
    "/tmp/override.db",
  );
  const configured = parseArgs(
    [
      "--transport",
      "streamable-http",
      "--port",
      "8766",
      "--database",
      "/tmp/cli.db",
      "--allowed-host",
      "proxy:9000",
      "--allowed-host",
      "other:*",
    ],
    {
      PROJECT_BOARD_DB: "/tmp/environment.db",
      PROJECT_BOARD_PROJECTS: "alpha, beta",
      PROJECT_BOARD_TOKEN: "secret",
    },
  );
  assert.equal(configured.database, "/tmp/cli.db");
  assert.equal(configured.port, 8766);
  assert.deepEqual(configured.projects, new Set(["alpha", "beta"]));
  assert.deepEqual(configured.allowedHosts, ["proxy:9000", "other:*"]);
  for (const arguments_ of [
    ["--transport", "streamable-http"],
    ["--port", "0"],
    ["--port", "65536"],
    ["--port", "12.5"],
    ["--host", ""],
    ["--allowed-host", "https://bad"],
    ["--unknown"],
  ]) {
    assert.throws(() => parseArgs(arguments_, {}), CliUsageError);
  }
  for (const projects of ["", " ", "alpha,", "bad project"])
    assert.throws(
      () => parseArgs([], { PROJECT_BOARD_PROJECTS: projects }),
      CliUsageError,
    );
  assert.throws(
    () =>
      parseArgs(["--transport", "streamable-http"], {
        PROJECT_BOARD_TOKEN: "sensitive secret",
      }),
    (error: unknown) =>
      error instanceof CliUsageError &&
      !error.message.includes("sensitive secret"),
  );
});

test("real stdio CLI serves MCP and preserves the allowlist", async (t) => {
  const { path } = await temporaryBoard(t);
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "--database", path],
    env: { PROJECT_BOARD_PROJECTS: "allowed" },
    stderr: "pipe",
  });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 9);
  await call(client, "project_join", {
    request_id: "join",
    repository: "repo",
    vendor: "openai",
    runtime: "codex",
    external_session_id: "stdio",
    model: "astra",
  });
  const denied = await client.callTool({
    name: "project_status",
    arguments: { request: { project_id: "other" } },
  });
  assert.equal(
    errorSchema.parse(denied.structuredContent).error.code,
    "forbidden",
  );
});

function runCli(
  arguments_: string[],
  environment: NodeJS.ProcessEnv = {},
  entryPath = cliPath,
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [entryPath, ...arguments_], {
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end();
    },
  );
}

test("CLI version, bad configuration, and stdin EOF terminate cleanly", async (t) => {
  const { path } = await temporaryBoard(t);
  assert.deepEqual(await runCli(["--version"]), {
    code: 0,
    stdout: `vibecheck ${version}\n`,
    stderr: "",
  });
  const invalid = await runCli(["--transport", "streamable-http"], {
    PROJECT_BOARD_TOKEN: "sensitive secret",
  });
  assert.equal(invalid.code, 2);
  assert.equal(invalid.stdout, "");
  assert.equal(invalid.stderr.includes("sensitive secret"), false);
  const ended = await runCli(["--database", path]);
  assert.equal(ended.code, 0);
  assert.equal(ended.stdout, "");
});

test("HTTP CLI starts authenticated service and closes on SIGTERM", async (t) => {
  const { path } = await temporaryBoard(t);
  const reservation = createHttpServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "--database",
      path,
      "--transport",
      "streamable-http",
      "--port",
      String(address.port),
    ],
    {
      env: {
        PROJECT_BOARD_TOKEN: "test-secret",
        PROJECT_BOARD_PROJECTS: "allowed",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  const stopped = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await stopped;
  });
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const deadline = Date.now() + 10000;
  while (true) {
    assert.equal(child.exitCode, null, stderr);
    try {
      const response = await fetch(url);
      assert.equal(response.status, 401);
      await response.text();
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await setTimeout(20);
    }
  }
  const client = new Client({ name: "http-cli-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer test-secret" } },
    }),
  );
  await call(client, "project_join", {
    request_id: "join",
    repository: "repo",
    vendor: "openai",
    runtime: "codex",
    external_session_id: "http",
    model: "astra",
  });
  await client.close();
  child.kill("SIGTERM");
  const timeout = new AbortController();
  try {
    const result = await Promise.race([
      stopped,
      setTimeout(5000, undefined, { signal: timeout.signal }).then(() => {
        throw new Error("HTTP CLI did not exit after SIGTERM");
      }),
    ]);
    assert.deepEqual(result, { code: 0, signal: null });
  } finally {
    timeout.abort();
  }
  assert.equal(stdout, "");
  assert.equal(stderr.includes("test-secret"), false);
});

test("installed command symlinks run the CLI entry point", async (t) => {
  const { directory } = await temporaryBoard(t);
  const executable = join(directory, "vibecheck");
  await symlink(cliPath, executable);
  assert.deepEqual(await runCli(["--version"], {}, executable), {
    code: 0,
    stdout: `vibecheck ${version}\n`,
    stderr: "",
  });
});

test("2025 HTTP requests preserve JSON responses without retaining sessions", async (t) => {
  const { board } = await temporaryBoard(t);
  const { url } = await runningHttp(t, board);
  const headers = {
    Authorization: "Bearer test-secret",
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2025-11-25",
  };
  const initialized = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "legacy-test", version: "1.0.0" },
      },
    }),
  });
  assert.equal(initialized.status, 200);
  assert.match(
    initialized.headers.get("content-type") ?? "",
    /^application\/json/,
  );
  assert.equal(initialized.headers.get("mcp-session-id"), null);
  const initialization = z
    .object({ result: z.object({ protocolVersion: z.string() }) })
    .parse(await initialized.json());
  assert.equal(initialization.result.protocolVersion, "2025-11-25");
  const listed = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  assert.equal(listed.status, 200);
  assert.match(listed.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(
    z
      .object({
        result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
      })
      .parse(await listed.json()).result.tools.length,
    9,
  );
  const called = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "project_join",
        arguments: {
          request: {
            project_id: "allowed",
            request_id: "legacy-join",
            repository: "repo",
            vendor: "openai",
            runtime: "codex",
            external_session_id: "legacy",
            model: "astra",
          },
        },
      },
    }),
  });
  assert.equal(called.status, 200);
  assert.match(called.headers.get("content-type") ?? "", /^application\/json/);
  const result = z
    .object({
      result: z.object({
        isError: z.boolean(),
        structuredContent: joinResultSchema,
      }),
    })
    .parse(await called.json());
  assert.equal(result.result.isError, false);
  assert.ok(result.result.structuredContent.session_id);
  for (const method of ["GET", "DELETE"]) {
    const response = await fetch(url, { method, headers });
    assert.equal(response.status, 405);
    await response.text();
  }
});

test("2026 HTTP discovery and tool calls return JSON", async (t) => {
  const { board } = await temporaryBoard(t);
  const { url } = await runningHttp(t, board);
  const headers = {
    Authorization: "Bearer test-secret",
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2026-07-28",
  };
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": {
      name: "modern-test",
      version: "1.0.0",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  for (const [id, method, params] of [
    [1, "server/discover", { _meta: meta }],
    [2, "tools/list", { _meta: meta }],
    [
      3,
      "tools/call",
      {
        _meta: meta,
        name: "project_join",
        arguments: {
          request: {
            project_id: "allowed",
            request_id: "modern-join",
            repository: "repo",
            vendor: "openai",
            runtime: "codex",
            external_session_id: "modern",
            model: "astra",
          },
        },
      },
    ],
  ] satisfies [number, string, object][]) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        "MCP-Method": method,
        ...(method === "tools/call" ? { "MCP-Name": "project_join" } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") ?? "",
      /^application\/json/,
    );
    const message = objectSchema.parse(await response.json());
    assert.equal(message.id, id);
    assert.ok(message.result, JSON.stringify(message));
    assert.equal(message.error, undefined);
  }
});
