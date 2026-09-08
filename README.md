# Vibecheck

Vibecheck is a passive MCP work ledger for coding agents. It records a shared task plan, session ancestry, claims, work locations, blockers, and commits in SQLite. Agents report changes through nine tools. The board does not run agents, schedule work, execute Git commands, or verify that reported work happened.

This repository contains the TypeScript implementation, version 1.0.1. The Python implementation is archived separately at [mgd34msu/vibecheck-python](https://github.com/mgd34msu/vibecheck-python).

## Install the plugin

Use a Codex or Claude Code client with native plugin support. Install Bash and either Bun 1.3.14 or later or Node.js 24 or later. The launcher supports Linux, macOS, and Windows through WSL. No Python installation is required.

For Codex, install the tagged marketplace:

```bash
codex plugin marketplace add mgd34msu/vibecheck --ref v1.0.1
codex plugin add vibecheck@vibecheck
```

For Claude Code:

```bash
claude plugin marketplace add mgd34msu/vibecheck@v1.0.1
claude plugin install vibecheck@vibecheck
```

These commands select the v1.0.1 Git tag. Enable the plugin in your client and reload the session if the tools do not appear. The plugin registers its MCP server and supplies a shared [vibecheck skill](skills/vibecheck/SKILL.md). There are no startup hooks that register projects or force the skill to run on every first turn.

Ask the agent to use Vibecheck to report its current work or recover an earlier plan. Supply a stable project ID and repository identity. For a standing project policy, copy [the agent instructions](docs/agent-usage.md) into your project's `AGENTS.md`.

Both native plugins include the same compiled `runtime/vibecheck.mjs` bundle and skill. The launcher selects Bun when available, then Node.js. Set `VIBECHECK_RUNTIME=bun` or `VIBECHECK_RUNTIME=node` to select one explicitly. Plugin startup does not install dependencies or write inside the plugin directory.

The bundle includes its dependency license notices in `runtime/THIRD-PARTY-NOTICES.txt`.

Both native plugins use the same server and skill. Their local stdio processes share the default database, so using both clients on one machine does not create separate boards.

## Build release assets

From a source checkout with locked dependencies installed, run:

```bash
bun run build:release
bun run verify:release
```

The build requires Bun, `zip`, and `tar`. It refreshes the bundled runtime and writes these files in `artifacts/`:

- `vibecheck-codex-plugin-1.0.1.zip`, the Codex plugin bundle.
- `vibecheck-claude-plugin-1.0.1.zip`, the Claude plugin bundle.
- `vibecheck-runtime-1.0.1.tar.gz`, the standalone bundled runtime.
- `SHA256SUMS`, checksums for the release artifacts.

Verify downloaded artifacts against `SHA256SUMS` with your platform's SHA-256 utility. Each plugin archive extracts into a `vibecheck` directory with its native manifest and marketplace catalog. For an extracted Codex archive, register that directory and install:

```bash
codex plugin marketplace add /absolute/path/to/vibecheck
codex plugin add vibecheck@vibecheck
```

For an extracted Claude archive:

```bash
claude plugin marketplace add /absolute/path/to/vibecheck
claude plugin install vibecheck@vibecheck
```

Choose either the GitHub marketplace or the extracted local marketplace for a client. Keep a local marketplace directory available for subsequent plugin management. See [release notes](docs/releases/v1.0.1.md) for publication status.

## Run from source

Install Bun 1.3.14 or later, then run:

```bash
git clone https://github.com/mgd34msu/vibecheck.git
cd vibecheck
bun install --frozen-lockfile
bun src/cli.ts --version
bun src/cli.ts
```

Bun runs the TypeScript source directly. To run compiled JavaScript with Node.js 24 or later, build it first:

```bash
bun run build
node dist/cli.js --version
node dist/cli.js
```

The package name is `@mgd34msu/vibecheck`. It is not published to the npm registry. The package declares both `vibecheck` and `project-board` commands for the same CLI.

## Start a local server

The default transport is stdio. The process waits for an MCP client, so a quiet terminal is expected. Stop it with Ctrl-C when configuring your client.

Use an absolute path to [scripts/run-server.sh](scripts/run-server.sh) as your client's MCP command. Copy [examples/mcp.json](examples/mcp.json) and replace the example paths. Put its command, arguments, and environment into your client's supported MCP configuration format.

All local clients must use the same absolute database path to share a board. Each client may start its own stdio process. Keep SQLite on local disk; use the HTTP server below for clients on different machines. Do not put the database on a network share.

The default database is `$XDG_DATA_HOME/project-board/board.sqlite3`, or `$HOME/.local/share/project-board/board.sqlite3` when `XDG_DATA_HOME` is unset. Set `PROJECT_BOARD_DB` or pass `--database` to choose another file. The existing `PROJECT_BOARD_*` environment variables remain unchanged.

## Start a shared HTTP server

Run the server on the machine that holds the local SQLite file:

```bash
read -rsp 'Board bearer token: ' PROJECT_BOARD_TOKEN
printf '\n'
export PROJECT_BOARD_TOKEN
export PROJECT_BOARD_DB="$HOME/.local/share/project-board/board.sqlite3"
export PROJECT_BOARD_PROJECTS='my-project'
bun src/cli.ts --transport streamable-http --host 127.0.0.1 --port 8765
```

For compiled Node.js, replace `bun src/cli.ts` with `node dist/cli.js` after building.

Connect an MCP client to `http://127.0.0.1:8765/mcp` with the header `Authorization: Bearer <your token>`. The server requires a token even on loopback. For remote clients, provide HTTPS through your existing reverse proxy and pass `--allowed-host` for its public host. Keep the SQLite file on the server's local disk.

`PROJECT_BOARD_PROJECTS` restricts both transports to the listed comma-separated project IDs. Leave it unset to allow all projects. A configured empty list fails startup. The HTTP token grants access to the configured projects; it does not identify individual agents. Local stdio trusts its caller, and session identities are cooperative self-reports.

## Keep data across upgrades

Keep the database outside plugin caches. The default XDG data path and any custom `PROJECT_BOARD_DB` path remain under your control. Plugin replacement or removal does not delete ledger data. The board does not create backups.

Pinned marketplace installations stay tied to the selected release. Select the desired release when upgrading. Remove the Claude plugin with `claude plugin uninstall vibecheck@vibecheck`; remove the Codex plugin with `codex plugin remove vibecheck@vibecheck`.

## Tools

| Tool             | Purpose                                                               |
| ---------------- | --------------------------------------------------------------------- |
| `project_join`   | Register or rejoin a project session with real identity and ancestry. |
| `plan_publish`   | Publish the root's complete task inventory.                           |
| `plan_edit`      | Atomically add or update task definitions, dependencies, and lineage. |
| `plan_read`      | Retrieve a complete plan revision or compare two revisions.           |
| `plan_ack`       | Record a session's review of a complete plan revision.                |
| `work_claim`     | Claim ownership or contribute under a parent's work.                  |
| `work_update`    | Report progress, blockers, integration, release, or handoff.          |
| `project_status` | Read compact current state or explicit complete current state.        |
| `work_history`   | Recover work by task, session, path, branch, or commit.               |

## Record work

Copy [the agent instructions](docs/agent-usage.md) into the project's `AGENTS.md`. Give every agent the same project ID and repository identity. The first `project_join` registers that project. Starting the server does not create projects or infer them from its working directory. The root owns and updates the shared plan. Workers claim existing tasks or contribute under their parent's work.

The following examples show MCP `tools/call` parameters. Replace values such as `REAL_VENDOR_SESSION_ID`, `SESSION_ID`, and `WORK_ID` with real runtime identities and IDs returned by the board. Model and effort strings are opaque metadata; use the actual configured values. Revisions below illustrate a fresh board. Always use returned revisions in real calls.

Join the project and retain the returned `session_id` and complete `task_map` from its `snapshot`. If the map is omitted for size, retrieve it with `plan_read`:

```json
{
  "name": "project_join",
  "arguments": {
    "request": {
      "project_id": "my-project",
      "request_id": "join-1",
      "repository": "https://example.com/team/repository.git",
      "vendor": "ACTUAL_VENDOR",
      "runtime": "ACTUAL_RUNTIME",
      "external_session_id": "REAL_VENDOR_SESSION_ID",
      "model": "ACTUAL_MODEL",
      "effort": "ACTUAL_EFFORT"
    }
  }
}
```

Publish the root's task plan:

```json
{
  "name": "plan_publish",
  "arguments": {
    "request": {
      "project_id": "my-project",
      "request_id": "plan-1",
      "session_id": "SESSION_ID",
      "expected_revision": 0,
      "tasks": [
        { "id": "implement", "label": "Implement the change", "depends_on": [] }
      ]
    }
  }
}
```

Claim the task with its current task revision:

```json
{
  "name": "work_claim",
  "arguments": {
    "request": {
      "project_id": "my-project",
      "request_id": "claim-1",
      "session_id": "SESSION_ID",
      "task_id": "implement",
      "expected_revision": 1,
      "location": {
        "checkout": "/absolute/path/to/checkout",
        "branch": "feature/change",
        "target_branch": "main",
        "paths": ["src/change.ts"]
      }
    }
  }
}
```

Report a blocker using the work and task revisions returned by the claim:

```json
{
  "name": "work_update",
  "arguments": {
    "request": {
      "project_id": "my-project",
      "request_id": "blocked-1",
      "session_id": "SESSION_ID",
      "updates": [
        {
          "work_id": "WORK_ID",
          "expected_revision": 1,
          "expected_task_revision": 2,
          "status": "blocked",
          "blocker": "Waiting for the test fixture"
        }
      ]
    }
  }
}
```

Read the shared status with one call:

```json
{
  "name": "project_status",
  "arguments": { "request": { "project_id": "my-project" } }
}
```

Find the task's work attempts and history:

```json
{
  "name": "work_history",
  "arguments": {
    "request": { "project_id": "my-project", "task_id": "implement" }
  }
}
```

At natural work boundaries, read `project_status` with your `known_plan_revision`. The response contains fresh operational facts keyed by stable task, work, and session IDs. Reuse the shared definition map instead of repeating the graph on every read. Normal status needs no cursor or page assembly.

Normal status includes active, owned pending, and blocked tasks, work awaiting integration, available unowned pending tasks, and tasks with open contributions. Its complete structured JSON response has a 64 KiB UTF-8 budget. Counts disclose the scope and any omissions. If `limited` is true, `full:true` retrieves all current tasks, current owners, open contributors, all registered sessions, and the complete map. Full status includes no work history.

To recover a lost map, request `include_map:true`. A stale `known_plan_revision` sets `map_changed:true` and requests a replacement map automatically. Maps are all-or-omitted. If `map_omitted` is true, follow `full_hint` with `full:true`, or use `plan_read` for the complete definitions alone.

Edit part of the plan atomically without resending its inventory:

```json
{
  "name": "plan_edit",
  "arguments": {
    "request": {
      "project_id": "my-project",
      "request_id": "edit-1",
      "session_id": "SESSION_ID",
      "expected_revision": 1,
      "operations": [
        {
          "op": "update",
          "task_id": "implement",
          "label": "Implement and verify the change"
        },
        {
          "op": "add",
          "task": {
            "id": "review",
            "label": "Review the change",
            "depends_on": ["implement"]
          }
        }
      ]
    }
  }
}
```

Read a complete definition map at a particular revision. Add `compare_to` to request a diff instead of the map:

```json
{
  "name": "plan_read",
  "arguments": { "request": { "project_id": "my-project", "revision": 2 } }
}
```

Only after receiving and reviewing the complete map, acknowledge that revision:

```json
{
  "name": "plan_ack",
  "arguments": {
    "request": {
      "project_id": "my-project",
      "request_id": "ack-2",
      "session_id": "SESSION_ID",
      "plan_revision": 2
    }
  }
}
```

The root can change dependencies during work. Each edit validates the resulting graph and retains older definitions in revision history. Optional `supersedes` links record splits or replacements; they do not transfer work or cancel tasks. Acknowledgments record which complete revision each session has reviewed. Reads never acknowledge automatically.

For field rules, retries, handoffs, advanced cursor reads, and history selectors, see [the protocol reference](docs/protocol.md). Status and timestamps describe the latest report, which may be stale. A successful database claim does not prevent another process from editing or committing the same Git files.

## Validate the checkout

Install the locked dependencies, then run verification:

```bash
bun install --frozen-lockfile
bun run verify
```

The verification command checks formatting, strict types, forbidden assertions, and bundled runtime freshness. It runs the behavior tests under Bun and compiled JavaScript under Node.js, then builds the package. Node.js 24 or later is required for the Node tests. After changing runtime source or dependencies, run `bun run build:release` to refresh the committed bundle before verification.

The release passes 127 tests on Bun 1.3.14, Node.js 24.0.0, and Node.js 26.1.0. A frozen 995-case validation corpus and imported SQLite fixtures check compatibility with the Python implementation, including historical records and saved retry responses. The TypeScript compiler is version 7.0.2. A development-only TypeScript 6 compiler API parses source for the forbidden-type checks.

The implementation derives domain types from input schemas. Boundary validation rejects invalid external data before business logic runs. Authored TypeScript uses no `any`, type assertions, non-null assertions, or compiler suppression comments. SQLite uses the runtime's built-in `bun:sqlite` or `node:sqlite` adapter.

See [release notes](docs/releases/v1.0.1.md) for the release contents and verification status.

The board retains reported metadata, not repository knowledge or conversations. It does not scan the repository to understand code. Session identities and work status are cooperative self-reports; Git commits and actual outcomes require separate verification. Dependencies and `blocking_path` describe the graph without scheduling work or estimating completion time.
