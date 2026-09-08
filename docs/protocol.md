# Protocol reference

The server exposes exactly nine MCP tools. Every tool has one typed `request` argument. MCP calls wrap fields as `{"name":"project_status","arguments":{"request":{"project_id":"my-project"}}}`. The TypeScript boundary is `await new Board(databasePath).call(toolName, request)`, where `request` contains the request fields directly. Input schemas validate external values and supply the inferred domain types.

## Common fields

Every request includes `project_id`. Mutations also include `request_id`; all mutations except `project_join` include a board `session_id`. Unknown fields are rejected. Identifiers use letters, digits, `_`, `.`, `:`, `@`, `/`, and `-`, with an alphanumeric first character and a maximum of 200 characters. Text fields are nonempty and at most 500 characters.

Server-owned document metadata includes `id`, `revision`, `created_at`, and `updated_at`. A revision describes one document. `plan_revision` describes the plan definition. A cursor describes the project's change stream. These values are not interchangeable.

A successful mutation returns its result, a cursor, the current `plan_revision`, and `map_hint:"include_map:true"`. Repeating identical input with the same request ID returns the cached result without another write. Reusing that ID with different input conflicts. Join retries are scoped by vendor, runtime, and external session ID; other mutation retries are scoped by board session. Failed calls roll back, including all entries in a batch update.

MCP marks failed tool results with `isError: true`. Board errors include text JSON and a structured `error` with `code`, `message`, and optional `details`. Board error codes are `invalid`, `not_found`, `conflict`, and `forbidden`. SDK-level validation may return a text-only error with no structured content. Unexpected backend errors return a structured `internal` error with the message `Internal server error.` and no exception details.

## project_join

Required fields are `project_id`, `request_id`, `repository`, `vendor`, `runtime`, `external_session_id`, and `model`. Optional fields are `effort`, `parent_session_id`, and `take_over_from`.

The first session creates the project and becomes its coordinator. It has no parent. The repository identity remains fixed. A session is unique within its project by vendor, runtime, and external session ID. Rejoining returns the same board session and can refresh model and effort. Identity and ancestry remain fixed. A parent must already exist in the same project.

A root session can explicitly take over coordination by naming the current coordinator in `take_over_from`. Joining by itself does not replace an existing coordinator. The result includes `session_id` and a compact `snapshot` after the join is stored. Join requests the complete definition map, subject to the status budget. The first join registers the project; server startup does not discover projects from its working directory.

## plan_publish

Required fields are the common mutation fields, `expected_revision`, and `tasks`. `expected_revision` must equal the current `plan_revision`, initially zero. Only the coordinator can publish.

Each task has `id`, `label`, optional `depends_on`, a list of task IDs, optional `status`, either `pending` or `cancelled`, and optional `supersedes`, a list of prior task IDs. The submitted plan is complete: prior task IDs cannot be omitted. IDs must be unique, dependencies must exist, and the graph must have no self-edges or cycles. There can be at most 10,000 tasks and 1,000 dependencies per task.

New tasks have no owner and can start pending or cancelled, with pending as the default. The coordinator can cancel or restore unclaimed pending or cancelled tasks through the plan, without creating work records. Omitting `status` preserves an existing task's state. Republishing the same status is allowed; actual state changes require an unclaimed pending or cancelled task. Definition edits preserve ownership. The result includes `plan_revision`, the complete `task_map`, and keyed operational `tasks` with task revisions, states, and owners. Each successful publication advances the plan revision once, including an unchanged publication. Dependencies record the plan; the board does not schedule or launch agents.

## plan_edit

Required fields are the common mutation fields, `expected_revision`, and `operations`, a nonempty list of at most 10,000 operations. Only the coordinator can edit. The revision must match the current plan revision.

An add operation is `{"op":"add","task":{"id":"new-task","label":"New task","depends_on":[]}}`. It requires a new task ID and accepts the same definition fields as publication. An update is `{"op":"update","task_id":"existing-task","label":"Revised label"}`. It requires an existing ID and at least one provided non-null definition field. A task can be targeted only once per edit.

The server validates the complete resulting inventory before storing changes. Same-batch forward references are valid. Dependency and `supersedes` graphs are validated separately; each rejects missing, duplicate, self, and cyclic references. Existing task state and ownership rules still apply. Failure rolls back the entire edit. Success advances `plan_revision` once and returns the same definition and operational maps as publication.

`supersedes` records lineage. Several successors naming one old task describe a split; one successor naming several old tasks describes a merge. Active and completed tasks can be referenced. Links do not change status, rewrite dependencies, or transfer work. Omitted links preserve existing values; an explicit empty list clears them. Prior definitions and links remain in history.

## plan_ack

Required fields are the common mutation fields and `plan_revision`. The revision must exist in the project and cannot decrease from the session's prior acknowledgment. The session records `acknowledged_plan_revision` and `acknowledged_at`. Repeating the same revision preserves its acknowledgment timestamp.

Acknowledgment records a session's reported review of a complete plan map. It does not advance the plan revision. Joins, reads, and other writes do not acknowledge automatically.

## plan_read

Required field `project_id` selects the project. Optional `revision` defaults to the current revision. Revision zero is the empty plan. A read returns `project_id`, `plan_revision`, the complete `task_map`, and publication `metadata` with `actor_id` and `created_at`. Revision zero has no publication metadata. Historical definitions reflect the original publication of that revision, not later work or coordinator changes.

Optional `compare_to` requests a diff from that revision to `revision`. The response contains added tasks, changed definitions with before/after values, and removed task IDs instead of repeating complete maps. Both revisions must exist within the project; reversed comparisons are valid. This explicit definition read has no status budget or pagination.

`task_map` uses stable caller-supplied task IDs as keys. Each value has `label`, `depends_on`, and nonempty `supersedes` when present. Operational task revisions are separate from definitions and plan revisions.

## work_claim

Required fields are the common mutation fields, `task_id`, and `expected_revision`, which is the current task revision. Optional fields are `location`, `replace_work_id`, and `parent_work_id`.

A normal claim creates an `in_progress` owner work record and sets the task's owner and state atomically. The owner slot must be empty, and the task must be nonterminal. `replace_work_id` explicitly replaces the current owner, marks the prior attempt `abandoned`, and links the new attempt through `predecessor_work_id`. The supplied ID must match the current owner.

`parent_work_id` creates a contributor under open work on the same task owned by the caller's immediate parent session. A contributor does not replace the task owner or change task state. Replacement and contribution cannot be combined. The result includes `task` and `work`.

A location can contain nullable `repository`, `checkout`, `branch`, `target_branch`, and `base_commit`, plus `paths`. Paths are unique normalized repository-relative strings, without absolute paths, backslashes, empty components, `.` components, or `..` components. Commits are full 40- or 64-character hexadecimal SHAs. Unknown facts can remain absent or null.

## work_update

Required fields are the common mutation fields. `updates` is a list of at most 100 changes. An empty list is valid. Every change requires `work_id` and its current `expected_revision`. Owner changes that affect the task also require `expected_task_revision`.

Only the record's session or coordinator can update it. An obsolete owner cannot update its prior attempt. Work states are `pending`, `in_progress`, `blocked`, `awaiting_integration`, `complete`, and `cancelled`, plus the server-assigned `released` and `abandoned` states. Complete, cancelled, released, and abandoned attempts are immutable.

Each change uses one action:

| Action                  | Fields and result                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `progress`, the default | Updates provided `status`, `location`, `blocker`, `commit`, or `integration_commit` fields. Omitted fields retain their values. Explicit null clears nullable fields. Location merges provided fields; a provided `paths` list replaces the prior list. |
| `release`               | Marks the attempt released. For an owner, clears the owner slot and returns the task to pending. A contributor release affects only that contribution.                                                                                                  |
| `handoff`               | Requires `handoff_to`, an existing session ID. Releases the owner attempt and creates a successor owner with inherited facts and status. Contributors cannot hand off.                                                                                  |

Release and handoff cannot include progress fields. A blocked state requires a blocker. Awaiting integration requires a result `commit` and `target_branch`. Entering that state sets the server-owned `integration_required` flag. The flag persists through later progress, blockers, releases, and handoffs. A replacement claim starts a fresh attempt. Completing any work with that flag requires `integration_commit`. Changing the result commit, target branch, or effective repository clears prior integration proof unless the same update explicitly supplies `integration_commit`. The effective repository is `location.repository` when set, otherwise the project repository. Owner state changes update both work and task; contributor changes affect only their work record. The result includes changed `tasks` and changed or newly created `work` records.

## project_status

Normal status takes `project_id`, with optional `known_plan_revision` and `include_map`. It returns fresh current facts in one consistent read transaction. It does not depend on which prior work updates the reader remembers.

The response includes `project_id`, `coordinator_session_id`, `plan_revision`, `cursor`, `map_hint`, `limited`, `counts`, and keyed `tasks`, `work`, and `sessions`. Dictionary keys are record IDs. Optional absent values are omitted; meaningful false and zero values remain. Task values contain operational revisions, states, owners when present, and `available:true` when derived ready. Work preserves update revisions, state, references, location, blockers, commits, integration requirements, and update timestamps. Sessions preserve identity, ancestry, model, effort, freshness, and acknowledgment facts.

Normal eligible tasks are active, owned pending, blocked, awaiting integration, available unowned pending tasks whose direct prerequisites are complete, and tasks with open contributions. The response includes their current owner work, open contributions, referenced sessions, ancestors, and coordinator. `dependency_states` gives direct prerequisite states without repeating baseline definitions. Readiness is descriptive; claims are not scheduled or gated by it.

Counts cover all task states, eligible and included tasks, available and waiting tasks, eligible and included current work, and total, eligible, and included sessions. Waiting means unowned pending tasks with incomplete prerequisites; owned pending tasks remain in the visible work scope. Normal omission of terminal or waiting tasks is scope selection, not a size limitation. Counts still disclose that scope.

The normal response has a hard budget of 65,536 bytes of compact UTF-8 JSON, including metadata. Blocked and active work take priority over available tasks. Each admitted unit retains its complete work locations, path arrays, and session ancestry. When a unit cannot fit, counts disclose the omission and the response sets `limited:true` and `full_hint:"full:true"`. No partial work context is presented as complete.

`blocking_path` describes one longest unresolved dependency path through a reported blocker, including contributor blockers. Length counts task nodes, not elapsed time or estimated duration. If the path itself is oversized, its length and blocked count remain with `omitted:true`.

`include_map:true` requests the entire current `task_map`. A stale `known_plan_revision` sets `map_changed:true` and also requests a complete replacement map. A known revision newer than current is invalid. The map is included only as a whole when it fits; otherwise `map_omitted:true`, `limited:true`, and the full hint are returned. Missing map data does not mean an empty plan.

`full:true` bypasses the budget and returns all current tasks, current owner work, open contributors, all registered sessions, the complete definition map, and repository identity. Work history remains separate. Full status requires no cursor or page assembly.

Optional `task_ids` selects requested tasks and all transitive dependencies, including terminal tasks, with their current context. The list contains between 1 and 1,000 IDs. This option cannot combine with `full`.

### Explicit archival deltas

`since` retains the advanced delta interface and cannot combine with `task_ids` or snapshot options. Normal agent status reads do not require it. A delta contains `project_id`, `plan_revision`, `cursor`, `has_more`, and `changes`. Each batch contains `seq`, `actor_id`, `created_at`, and `records`, a list of `{kind,id,record}` entries. Work batches capture work sessions, event actors, and their ancestors. An unchanged captured session entry carries `context:true`.

A batch is never split. `limit` defaults to 100 batches and ranges from 1 to 1,000. A cursor above the project's high-water mark is invalid. The next cursor is the last returned sequence, or the supplied `since` if no changes exist. Delta `plan_revision` reflects the plan at that returned cursor. Archival consumers apply batches in order and continue while `has_more` is true.

## work_history

Required fields are `project_id` and at least one selector: `task_id`, `session_id`, `path`, `branch`, or `commit`. Multiple selectors combine with AND. A path selector matches exact path membership. A commit matches a result, integration, or base commit. Selectors also match previous document versions, so later scope edits do not hide prior work.

The result contains `work`, `sessions`, `changes`, `matched_work_count`, `cursor`, and `has_more`. Current work summaries include only work IDs in the returned event page. Current sessions cover that work, the page's event actors, and their ancestors. `matched_work_count` counts all matching work across pages. Each historical batch includes matching work and captured context for its sessions, the actor, and their ancestors, preserving model and effort at that event. Unmodified captured sessions carry `context:true`. Session-only batches are excluded. `after` defaults to zero. `limit` defaults to 100 and ranges from 1 to 1,000. Pagination returns complete event batches and filters unrelated records out of matching batches. An empty final page has empty work, sessions, and changes, while retaining the total matched count and supplied cursor.

## Transport and trust

`bun src/cli.ts` and compiled `node dist/cli.js` start the same server. The package declares `vibecheck` and `project-board` as CLI aliases. Bun requires version 1.3.14 or later; Node.js requires version 24 or later. The CLI supports `--version`, `--transport stdio|streamable-http`, `--database`, `--host`, `--port`, and repeatable `--allowed-host`. Stdio is the default. HTTP defaults to `127.0.0.1:8765` with the MCP endpoint at `/mcp`. `--allowed-host` adds accepted public Host values for a proxy deployment.

`PROJECT_BOARD_DB` selects the SQLite file unless `--database` overrides it. The default uses the XDG data directory. `PROJECT_BOARD_TOKEN` is required for HTTP bearer authentication and must contain no whitespace. Optional `PROJECT_BOARD_PROJECTS` restricts both transports to a comma-separated project allowlist. Unset means unrestricted; an empty configured list is invalid.

SQLite transactions make claims and batch updates atomic, with revision checks for competing writers. SQLite uses WAL and bounded retries for lock acquisition on local disk. These controls cover ledger records. They do not lock checkouts, prevent Git writes, verify commits, or establish an agent's identity. Reported state and `last_seen_at` can be stale; reads do not prove that a session is still working.
