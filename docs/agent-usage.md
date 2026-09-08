# Agent instructions

Copy this block into the project's `AGENTS.md`. Configure the MCP server first, then supply the shared project ID and repository identity in the task context.

```markdown
## Shared work ledger

Use Vibecheck for work metadata. Keep code, credentials, transcripts, and
large logs out of the board.

- On your first turn, call project_join with the shared project ID, repository,
  actual vendor/runtime session ID, model, and effort. The first join registers
  the project; server startup and working directory do not discover projects.
  Never invent a vendor session ID. If the runtime does not expose it, report
  that limitation. Preserve ancestry with the parent's board session_id.
- Retain your board session_id and the complete task_map from join, plan_publish,
  plan_edit, or plan_read. Task IDs are stable map keys. Plan revision, task
  revision, and work revision are different values; use the revision requested
  by each mutation.
- The root owns and updates the shared plan. Workers use existing task IDs and
  do not publish child plans or graphs. Report missing scope to the root. The
  root can use plan_edit for atomic add/update operations or plan_publish for
  the complete inventory, always with the current plan revision. Preserve prior
  task IDs. Cancel or restore unclaimed pending/cancelled tasks through plan
  status. Supersedes links record lineage without transferring or cancelling work.
- If explicitly assigned to resume coordination in a new root session, join
  first, then rejoin with a new request_id and take_over_from set to the returned
  snapshot.coordinator_session_id. Do not take over merely because you joined.
- Claim an existing task before working on it. For work on the parent's task,
  use parent_work_id and your own session_id. Give the root each delegated
  agent's real identity, parent, task, model, effort, and status. Pass your board
  session/work IDs to children so they can preserve ancestry. Model and effort
  are opaque actual values, not names to normalize or guess.
- Record your repository, checkout, branch, target branch, base commit, and paths
  when known. Use normalized repository-relative paths and full commit SHAs.
- Update at natural boundaries: scope change, blocker, handoff, completion, or
  integration. Batch related updates in work_update. Use returned work and task
  revisions. After a conflict, read current state and reassess.
- Read project_status at natural boundaries with known_plan_revision. It returns
  fresh operational facts; normal use needs no cursor loop. For a status question,
  start with one call. Counts disclose omitted scope. If limited is true and you
  need all current records, request full:true; this includes no work history.
- If your baseline map is lost, request include_map:true or use plan_read.
  A stale known_plan_revision requests a complete replacement map. If map_omitted
  is true, use full:true for all current state or plan_read for definitions alone.
  Never treat an omitted map as an empty plan.
- Call plan_ack only after actually receiving and reviewing the complete map
  for that revision. A fresh status revision or diff alone is not acknowledgment.
  Use plan_read with revision and optional compare_to to recover old definitions
  or inspect changes. Older graphs remain in history.
- Use work_history to recover prior work by task_id, session_id, path, branch, or
  full commit SHA. Its explicit historical pages use after and the returned
  cursor while has_more is true. This is separate from normal current status.
- Reuse request_id only to retry an identical mutation. Changed inputs need a new
  request_id. Retain returned IDs and revisions.
- Mark blocked work with a concrete blocker. Use awaiting_integration with the
  result commit and target branch when integration remains. Once declared, the
  integration requirement survives blockers and handoffs; completion requires
  integration_commit. Release or explicitly hand off work when leaving it.
- Treat the board as the latest self-report, which can be stale. Verify commits
  and outcomes in the repository. Claims do not fence Git writes. blocking_path
  counts dependency nodes through a blocker; it is not a time estimate or schedule.
```
