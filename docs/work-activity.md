# Work and activity service

The work ledger remains compatible with the original nine MCP tools. Optional task fields are `description`, `acceptance`, `priority`, and `semantic_targets`, whose entries contain exact `workspace_id` and `node_id` references. Targets describe intent. Consumers such as Plat validate and resolve semantic identities. They never become implicit file authorization or automatic implementation evidence.

Human operators are explicitly marked `actor_kind:human`; they can manage plans without appearing as coding agents. Agent sessions preserve their real external identities. Session lifecycle belongs to the activity extension rather than task status.

## HTTP interface

All routes use the existing Host and Origin guards and bearer authentication. The manager token is `PROJECT_BOARD_TOKEN`. Optional `VIBECHECK_OBSERVER_TOKEN` permits read routes and `VIBECHECK_COLLECTOR_TOKEN` permits source, event, artifact, and restricted agent-command ingestion. These tokens authorize access; external session names remain cooperative identity reports. Observer/collector tokens cannot access the unrestricted MCP endpoint.

Routes have prefix `/v1/projects/{project_id}/`. Project allowlists apply throughout.

| Route            | Method        | Behavior                                                                                                                                                                                                     |
| ---------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `setup`          | POST, manager | Register an explicit human operator and stable worktree using repository, workspace_id, root, and optional display_name. Returns operator_id and worktree.                                                   |
| `snapshot`       | GET           | Consistent full current ledger, source capabilities, worktrees, activity sessions, file-associated events, and independent activity/ledger cursors. The bounded file-event projection reports files_limited. |
| `stream`         | GET           | SSE change notifications after committed state, including instance identity and cursors. Durable reads reconcile changes; the feed also observes legacy direct database writers.                             |
| `events`         | GET           | Ordered event pages with since, limit, optional session_id and instance_id. Changed database identity or an invalid cursor requires a fresh snapshot.                                                        |
| `command`        | POST          | Existing `{tool,request}` commands against the path's project. Collector credentials cannot manage plans or create human actors.                                                                             |
| `sources`        | POST          | Source identity, declared capabilities, health and last contact.                                                                                                                                             |
| `worktrees`      | POST, manager | Stable worktree registration. Existing IDs cannot be reassigned to another root or repository.                                                                                                               |
| `activity`       | POST          | Atomic batches of up to 200 events. Stable event IDs deduplicate identical retries and reject changed content.                                                                                               |
| `artifacts`      | POST          | Immutable versioned artifact up to one million text characters, associated with an actual session and optional work record.                                                                                  |
| `artifacts/{id}` | GET           | Retrieve one explicit artifact. IDs do not authorize arbitrary filesystem reads.                                                                                                                             |
| `codex`          | POST, manager | Explicit `{enabled,worktree_id}` configuration for the local Codex collector.                                                                                                                                |
| `prune`          | POST, manager | Retain a specified positive number of days of activity and artifacts. Work records and coordination history are preserved. Snapshots disclose retention.                                                     |

An activity event identifies source, session, worktree, occurred_at, kind, evidence basis, and exact relative paths where known. Optional actor_id, work_id, run_id, lifecycle, operation and artifact_id preserve attribution and detail. The basis is agent_report, host_event, or repository_observation. Repository observations alone do not identify a writer. Session state and last contact never establish verified work completion.

## Storage and recovery

Activity tables have an independently versioned extension marker. Existing ledger schema-v1 history, IDs, revision behavior and cached retry results remain intact. A persistent random instance identity distinguishes replaced databases. Event sequences are durable, duplicate deliveries are idempotent, and late historical events do not overwrite a newer lifecycle report.

The stream is a notification mechanism; consumers reconcile consistent snapshots or event pages and retain omission indicators. Changes from standalone legacy stdio writers are detected from the persisted journal. Service-mode stdio processes use VIBECHECK_SERVICE_URL to route commands through the common service. No state is stored in plugin caches.

## Codex collector

Enable it only for a configured worktree. The collector reads JSONL under CODEX_HOME/sessions or the default user Codex directory, checks the session metadata's exact resolved cwd, and imports only matching sessions. Stable external IDs correlate MCP reports and host records. Incremental offsets are persisted, incomplete trailing records wait for the next read, duplicate replay is harmless, and truncation is reported rather than silently reusing event identities.

When unread history exceeds two chunks, collection follows the latest complete records first and imports older history with a separate persisted cursor. Backfill retains the same byte-offset event identities and cannot overwrite newer lifecycle or model metadata. Source health reports background import and unmatched workspace roots. Normal reads are bounded to 2 MB; an individual record can grow the read to 64 MB, with public artifact text still limited to one million characters. A larger unsupported record reports an error for that source without blocking collection of other session files. Live progress is saved before historical import so an unsupported historical record cannot hold the live cursor back.

The observed format supports model/effort metadata, turn start/finish, user messages, public assistant commentary/final messages, tool requests and results, and explicit patch-request paths. Instructions, private reasoning, encrypted reasoning, and unrelated workspace sessions are excluded. Turn completion means idle, not that the entire conversation ended. The collector advertises its actual capabilities; requested patches are operations and do not claim successful edits or a versioned diff. Other collectors can submit confirmed edit and diff records through the typed ingestion API.

Large available message and tool payloads become separate artifacts. Payloads exceeding one million characters are explicitly labeled truncated. Unsupported host record formats remain unavailable; directory or ingestion failures appear in source health. Disabling the visual agent layer in a consumer does not disable this explicitly configured collector.

Artifact metadata can be paged with GET /v1/projects/:project/artifacts?work_id=:work&after=:id (or session_id). Text is fetched separately by immutable artifact ID. This keeps capability work inspectors useful without opening the live agent layer. Scope checks and test results identify their input digest and reported outcome; the ledger does not independently verify them.
