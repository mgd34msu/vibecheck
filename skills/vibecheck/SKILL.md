---
name: vibecheck
description: Use the Vibecheck MCP ledger to coordinate coding work, report project status, update a shared plan, or recover prior work and plan revisions. Applies when the user asks for Vibecheck or shared work tracking; it does not inspect repository contents or schedule agents.
---

# Vibecheck

Use the plugin's nine MCP tools to maintain a shared work ledger within the user's task. All tools take a nested `request` object. Store metadata and references, not code, credentials, transcripts, or large logs.

## Establish the session

Use the shared project ID and repository identity supplied for the task. On the first turn using this workflow, call `project_join`. The first join registers the project; server startup and working directory do not discover projects.

Report the actual vendor, runtime, external session ID, model, and effort. Never invent a vendor session ID. If the runtime does not expose it, report the limitation. Preserve ancestry with the immediate parent's board `session_id`. Retain your returned `session_id` and complete `snapshot.task_map` when provided.

Only the root coordinator publishes or edits the shared plan. Workers use existing task IDs and report missing scope to the root; they do not create child plans or graphs. If explicitly assigned to resume coordination in a new root session, join first, then rejoin with a new request ID and `take_over_from` set to `snapshot.coordinator_session_id`.

## Record work

Claim a task before working on it. Use `parent_work_id` for a contribution to your parent's task. Pass your board session and work IDs to children so their claims preserve ancestry. Report delegated identities, task, model, effort, and status to the root.

Record known repository, checkout, branch, target branch, base commit, and paths. Paths are normalized repository-relative strings; commits are full SHAs. Update at scope changes, blockers, handoffs, completion, and integration. Batch related updates in `work_update`.

Use returned task and work revisions for mutations; they are distinct from the plan revision. Reuse `request_id` only for an identical retry. After a conflict, read current state and reassess.

Blocked work needs a concrete blocker. Work awaiting integration needs the result commit and target branch. Once declared, the integration requirement survives blockers and handoffs; completion requires `integration_commit`. Changing the result commit or integration destination invalidates prior proof unless the same update supplies the integration reference. Release or explicitly hand off work when leaving it.

## Read current status

Start a status request with one `project_status` call. At natural work boundaries, supply `known_plan_revision` for your baseline. Normal current reads require no cursor loop. Preserve stable task map keys and interpret current operational facts against that map.

Counts disclose normal scope and size omissions. If `limited` is true and complete current state is needed, use `full:true`. Full status returns all current tasks, owners, open contributors, registered sessions, and definitions, not work history.

If the baseline is lost, request `include_map:true` or use `plan_read`. A stale known revision requests a replacement map. If `map_omitted` is true, use `full:true` for complete current state or `plan_read` for definitions. An omitted map is not an empty plan.

## Evolve or recover the plan

The root uses `plan_edit` for atomic add/update operations or `plan_publish` for the complete inventory, with the current plan revision. Preserve prior task IDs. Cancel or restore unclaimed pending/cancelled tasks through plan status. `supersedes` records lineage without cancelling tasks, rewriting dependencies, or transferring ownership.

Use `plan_read` with `revision` to recover complete definitions. Adding `compare_to` returns a diff instead of the map. Call `plan_ack` only after receiving and reviewing the complete map for that revision. Reading a fresh revision number or a diff alone does not justify acknowledgment.

Use `work_history` for recovery by task, session, path, branch, or commit. Follow its explicit historical pages with `after` set to the returned cursor while `has_more` is true. Keep this separate from normal current status.

Treat timestamps and status as the latest report, which can be stale. Verify outcomes in the repository. Claims do not fence Git writes, and `blocking_path` counts task nodes through reported blockers rather than estimating duration.
