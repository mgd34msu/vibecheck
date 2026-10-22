import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  chmod,
  lstat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import {
  artifactNames,
  commonFiles,
  generateBundle,
  generateNotices,
  packageVersion,
  platforms,
  pluginFiles,
  root,
  run,
  sha256,
} from "./build-release.js";
import type { Platform } from "./build-release.js";

export type Runtime = "bun" | "node";
export const runtimes: Runtime[] = ["bun", "node"];
const toolNames = [
  "project_join",
  "plan_publish",
  "plan_edit",
  "plan_ack",
  "plan_read",
  "work_claim",
  "work_update",
  "project_status",
  "work_history",
].sort();
const manifestSchema = z.object({
  name: z.literal("vibecheck"),
  version: z.string(),
  mcpServers: z.object({
    vibecheck: z.object({
      command: z.literal("bash"),
      args: z.array(z.string()),
      cwd: z.string().optional(),
    }),
  }),
});

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function verifyVersions(directory: string): Promise<string> {
  const version = await packageVersion(directory);
  for (const platform of platforms) {
    const manifest = manifestSchema.parse(
      await json(join(directory, `.${platform}-plugin/plugin.json`)),
    );
    assert.equal(manifest.version, version);
    const catalog = z
      .object({
        name: z.literal("vibecheck"),
        plugins: z
          .array(
            z.object({ name: z.literal("vibecheck"), source: z.unknown() }),
          )
          .length(1),
      })
      .parse(
        await json(
          join(
            directory,
            platform === "codex"
              ? ".agents/plugins/marketplace.json"
              : ".claude-plugin/marketplace.json",
          ),
        ),
      );
    assert.deepEqual(
      catalog.plugins[0]?.source,
      platform === "codex" ? { source: "local", path: "./" } : "./",
    );
    assert.deepEqual(manifest.mcpServers.vibecheck.args, [
      platform === "codex"
        ? "scripts/run-server.sh"
        : "${CLAUDE_PLUGIN_ROOT}/scripts/run-server.sh",
      "--transport",
      "stdio",
    ]);
    assert.equal(
      manifest.mcpServers.vibecheck.cwd,
      platform === "codex" ? "." : undefined,
    );
  }
  const skill = await readFile(
    join(directory, "skills/vibecheck/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /^---\nname: vibecheck\ndescription: .+\n---\n/u);
  return version;
}

export async function exercisePlugin(
  directory: string,
  platform: Platform,
  runtime: Runtime,
  database: string,
  workingDirectory: string,
  expectedVersion: string,
): Promise<void> {
  const manifest = manifestSchema.parse(
    await json(join(directory, `.${platform}-plugin/plugin.json`)),
  );
  const server = manifest.mcpServers.vibecheck;
  const arguments_ = server.args.map((value) =>
    value.replaceAll("${CLAUDE_PLUGIN_ROOT}", directory),
  );
  assert.ok(
    arguments_.every((value) => !value.includes("${")),
    "Unresolved plugin variable",
  );
  const client = new Client({
    name: "vibecheck-release-verifier",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: server.command,
    args: [...arguments_, "--database", database],
    cwd:
      platform === "codex"
        ? resolve(directory, server.cwd ?? ".")
        : workingDirectory,
    env: {
      ...getDefaultEnvironment(),
      VIBECHECK_RUNTIME: runtime,
      PROJECT_BOARD_PROJECTS: "release-test",
    },
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: unknown) => {
    diagnostics += String(chunk);
  });
  const deadline = setTimeout(() => {
    void client.close();
  }, 30_000);
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, expectedVersion);
    const listing = await client.listTools();
    assert.deepEqual(listing.tools.map((tool) => tool.name).sort(), toolNames);
    for (const tool of listing.tools)
      assert.deepEqual(tool.inputSchema.required, ["request"]);
    async function call(
      name: string,
      request: Record<string, unknown>,
    ): Promise<unknown> {
      const result = await client.callTool({
        name,
        arguments: { request: { project_id: "release-test", ...request } },
      });
      assert.notEqual(
        result.isError,
        true,
        `${name}: ${JSON.stringify(result)}`,
      );
      return result.structuredContent;
    }
    const joined = z.object({ session_id: z.string() }).parse(
      await call("project_join", {
        request_id: "join",
        repository: "release-fixture",
        vendor: "verification",
        runtime,
        external_session_id: "release-session",
        model: "no-model-executed",
      }),
    );
    const session = { session_id: joined.session_id };
    await call("plan_publish", {
      ...session,
      request_id: "publish",
      expected_revision: 0,
      tasks: [{ id: "implement", label: "Initial scope" }],
    });
    const plan = z
      .object({ plan_revision: z.number() })
      .parse(await call("plan_read", {}));
    await call("plan_ack", {
      ...session,
      request_id: "ack",
      plan_revision: plan.plan_revision,
    });
    await call("plan_edit", {
      ...session,
      request_id: "edit",
      expected_revision: plan.plan_revision,
      operations: [
        { op: "update", task_id: "implement", label: "Released scope" },
      ],
    });
    const claimed = z
      .object({
        task: z.object({ revision: z.number() }),
        work: z.object({ id: z.string(), revision: z.number() }),
      })
      .parse(
        await call("work_claim", {
          ...session,
          request_id: "claim",
          task_id: "implement",
          expected_revision: 2,
          location: { branch: "release/topic", paths: ["src/example.ts"] },
        }),
      );
    await call("work_update", {
      ...session,
      request_id: "complete",
      updates: [
        {
          work_id: claimed.work.id,
          expected_revision: claimed.work.revision,
          expected_task_revision: claimed.task.revision,
          status: "complete",
        },
      ],
    });
    const status = z
      .object({ tasks: z.record(z.string(), z.object({ status: z.string() })) })
      .parse(await call("project_status", { full: true }));
    assert.equal(status.tasks.implement?.status, "complete");
    const history = z
      .object({ work: z.array(z.object({ id: z.string() })) })
      .parse(await call("work_history", { task_id: "implement" }));
    assert.ok(history.work.some((work) => work.id === claimed.work.id));
    const forbidden = await client.callTool({
      name: "project_status",
      arguments: { request: { project_id: "unlisted" } },
    });
    assert.equal(forbidden.isError, true);
  } catch (error) {
    throw new Error(`${platform}/${runtime} at ${directory}: ${diagnostics}`, {
      cause: error,
    });
  } finally {
    clearTimeout(deadline);
    await client.close();
  }
}

function inventory(output: string, expected: string[]): void {
  const entries = output.trim().split("\n");
  assert.equal(
    new Set(entries).size,
    entries.length,
    "Duplicate archive entries",
  );
  const files = expected.map((file) => `vibecheck/${file}`);
  for (const entry of entries) {
    const name = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    assert.ok(
      (name === "vibecheck" || name.startsWith("vibecheck/")) &&
        !name.includes("\\") &&
        name
          .split("/")
          .every((part) => part !== "" && part !== "." && part !== ".."),
      `Unsafe archive entry ${entry}`,
    );
    if (entry.endsWith("/"))
      assert.ok(
        files.some((file) => file.startsWith(entry)),
        `Unexpected archive directory ${entry}`,
      );
  }
  assert.deepEqual(
    entries.filter((entry) => !entry.endsWith("/")).sort(),
    files.sort(),
  );
}

async function makeReadOnly(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await makeReadOnly(path);
    else await chmod(path, entry.name === "run-server.sh" ? 0o555 : 0o444);
  }
  await chmod(directory, 0o555);
}

async function makeWritable(directory: string): Promise<void> {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeWritable(join(directory, entry.name));
  }
}

async function compareFiles(directory: string, files: string[]): Promise<void> {
  for (const file of files) {
    const target = join(directory, file);
    assert.ok((await lstat(target)).isFile(), `${file} is not a regular file`);
    assert.deepEqual(
      await readFile(target),
      await readFile(join(root, file)),
      `Archive bytes differ: ${file}`,
    );
  }
}

export async function verifyNativeInstall(
  directory: string,
  platform: Platform,
  temporary: string,
): Promise<void> {
  const sandbox = join(temporary, `${platform}-native`);
  await mkdir(sandbox, { recursive: true });
  const arguments_ = [
    "--die-with-parent",
    "--unshare-net",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--bind",
    temporary,
    temporary,
  ];
  for (const name of [".codex", ".agents", ".claude", ".cache"]) {
    const isolated = join(sandbox, name);
    await mkdir(isolated, { recursive: true });
    arguments_.push("--bind", isolated, join(homedir(), name));
  }
  const userFile = join(sandbox, ".claude.json");
  await writeFile(userFile, "{}\n");
  arguments_.push(
    "--bind",
    userFile,
    join(homedir(), ".claude.json"),
    "--chdir",
    temporary,
  );
  if (platform === "codex") {
    run("bwrap", [
      ...arguments_,
      "codex",
      "plugin",
      "marketplace",
      "add",
      directory,
    ]);
    run("bwrap", [
      ...arguments_,
      "codex",
      "plugin",
      "add",
      "vibecheck@vibecheck",
    ]);
    assert.match(
      run("bwrap", [...arguments_, "codex", "plugin", "list"]),
      /vibecheck/u,
    );
  } else {
    run("bwrap", [...arguments_, "claude", "plugin", "validate", directory]);
    run("bwrap", [
      ...arguments_,
      "claude",
      "plugin",
      "marketplace",
      "add",
      directory,
    ]);
    run("bwrap", [
      ...arguments_,
      "claude",
      "plugin",
      "install",
      "vibecheck@vibecheck",
    ]);
    assert.match(
      run("bwrap", [...arguments_, "claude", "plugin", "list"]),
      /vibecheck/u,
    );
  }
  const manifest = manifestSchema.parse(
    await json(join(directory, `.${platform}-plugin/plugin.json`)),
  );
  const cached = join(
    sandbox,
    platform === "codex" ? ".codex" : ".claude",
    "plugins/cache/vibecheck/vibecheck",
    manifest.version,
  );
  await rm(join(cached, "node_modules"), { recursive: true, force: true });
  await makeReadOnly(cached);
  try {
    for (const runtime of runtimes)
      await exercisePlugin(
        cached,
        platform,
        runtime,
        join(temporary, `${runtime}-cached.sqlite3`),
        temporary,
        manifest.version,
      );
  } finally {
    await makeWritable(cached);
  }
}

export async function verifyRelease(
  outputDirectory = join(root, "artifacts"),
  native = false,
): Promise<void> {
  const version = await verifyVersions(root);
  assert.equal(
    sha256(await readFile(join(root, "runtime/vibecheck.mjs"))),
    sha256(await generateBundle()),
    "Committed runtime is stale; run bun run build:release",
  );
  assert.equal(
    await readFile(join(root, "runtime/THIRD-PARTY-NOTICES.txt"), "utf8"),
    await generateNotices(),
    "Bundled dependency notices are stale; run bun run build:release",
  );
  const lines = (await readFile(join(outputDirectory, "SHA256SUMS"), "utf8"))
    .trim()
    .split("\n");
  const checksums = lines.map((line) => {
    const parts = /^(?<digest>[0-9a-f]{64})  (?<name>[A-Za-z0-9_.-]+)$/u.exec(
      line,
    )?.groups;
    return z.object({ digest: z.string(), name: z.string() }).parse(parts);
  });
  assert.deepEqual(
    checksums.map((entry) => entry.name).sort(),
    artifactNames(version),
  );
  for (const entry of checksums)
    assert.equal(
      sha256(await readFile(join(outputDirectory, entry.name))),
      entry.digest,
      entry.name,
    );
  const temporary = await mkdtemp(join(tmpdir(), "vibecheck release spaces "));
  const readOnly: string[] = [];
  try {
    for (const platform of platforms) {
      const archive = join(
        outputDirectory,
        `vibecheck-${platform}-plugin-${version}.zip`,
      );
      const files = pluginFiles(platform);
      inventory(run("unzip", ["-Z1", archive]), files);
      const rows = run("unzip", ["-Z", "-l", archive])
        .split("\n")
        .filter((line) => /^[bcdlps-][rwxstST-]{9} /u.test(line));
      assert.equal(
        rows.length,
        files.length,
        "ZIP entry metadata is incomplete",
      );
      for (const row of rows) {
        assert.equal(
          row.slice(0, 10),
          row.endsWith("/scripts/run-server.sh") ? "-rwxr-xr-x" : "-rw-r--r--",
          "Unexpected ZIP entry type or permissions",
        );
        assert.ok(
          row.includes("00-Jan-01 00:00"),
          "ZIP timestamp differs from the release epoch",
        );
      }
      const extracted = join(temporary, platform);
      await mkdir(extracted);
      run("unzip", ["-q", archive, "-d", extracted]);
      const plugin = join(extracted, "vibecheck");
      await compareFiles(plugin, files);
      await makeReadOnly(plugin);
      readOnly.push(plugin);
      for (const runtime of runtimes) {
        await exercisePlugin(
          root,
          platform,
          runtime,
          join(temporary, `${platform}-${runtime}-source.db`),
          temporary,
          version,
        );
        await exercisePlugin(
          plugin,
          platform,
          runtime,
          join(temporary, `${platform}-${runtime}-archive.db`),
          temporary,
          version,
        );
      }
      if (native) {
        await verifyNativeInstall(
          root,
          platform,
          join(temporary, `${platform}-source-install`),
        );
        await verifyNativeInstall(
          plugin,
          platform,
          join(temporary, `${platform}-archive-install`),
        );
      }
    }
    const archive = join(
      outputDirectory,
      `vibecheck-runtime-${version}.tar.gz`,
    );
    inventory(run("tar", ["-tzf", archive]), commonFiles);
    for (const row of run("tar", ["-tvzf", archive]).trim().split("\n"))
      assert.match(
        row,
        /^[-d][rwx-]{9} /u,
        "Tar contains a link or special file",
      );
    const extracted = join(temporary, "standalone");
    await mkdir(extracted);
    run("tar", ["-xzf", archive, "-C", extracted]);
    const runtimeRoot = join(extracted, "vibecheck");
    await compareFiles(runtimeRoot, commonFiles);
    await makeReadOnly(runtimeRoot);
    readOnly.push(runtimeRoot);
    for (const runtime of runtimes)
      assert.equal(
        run(
          runtime,
          [join(runtimeRoot, "runtime/vibecheck.mjs"), "--version"],
          temporary,
        ).trim(),
        `vibecheck ${version}`,
      );
  } finally {
    for (const directory of readOnly) await makeWritable(directory);
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const arguments_ = process.argv.slice(2);
  assert.ok(
    arguments_.every((argument) => argument === "--native"),
    "Usage: bun scripts/verify-release.ts [--native]",
  );
  await verifyRelease(undefined, arguments_.includes("--native"));
  process.stdout.write(
    "Verified release checksums, bundled bytes, source and extracted plugin MCP lifecycles on Bun and Node.\n",
  );
}
