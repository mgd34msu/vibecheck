import { z } from "zod";
import type { Transaction } from "./db.js";
import { BoardError } from "./errors.js";
import { taskMap } from "./plans.js";
import {
  cursorSchema,
  planRevisionSchema,
  recordChangeSchema,
  sessionIdSchema,
  projectIdSchema,
  recordRevisionSchema,
  taskStateSchema,
  taskIdSchema,
  sessionRecordSchema,
  locationRecordSchema,
  taskMapSchema,
  workIdSchema,
  workRecordSchema,
  type Cursor,
  type PlanRevision,
  type ProjectId,
  type ProjectStatus,
  type RecordChange,
  type SessionId,
  type SessionRecord,
  type TaskId,
  type TaskRecord,
  type TaskState,
  type WorkHistory,
  type WorkId,
  type WorkRecord,
} from "./schemas.js";
import type { SqlValue } from "./sqlite.js";

export const STATUS_BUDGET = 65_536;

export const operationalTaskSchema = z.strictObject({
  revision: recordRevisionSchema,
  status: taskStateSchema,
  owner_work_id: workIdSchema.optional(),
  available: z.literal(true).optional(),
});
export type OperationalTask = z.infer<typeof operationalTaskSchema>;
const compactSessionSchema = sessionRecordSchema
  .omit({
    id: true,
    created_at: true,
    updated_at: true,
    parent_session_id: true,
    effort: true,
  })
  .extend({
    parent_session_id: sessionIdSchema.optional(),
    effort: z.string().optional(),
  });
export type CompactSession = z.infer<typeof compactSessionSchema>;
const compactLocationSchema = locationRecordSchema
  .omit({
    repository: true,
    checkout: true,
    branch: true,
    target_branch: true,
    base_commit: true,
  })
  .extend({
    repository: z.string().optional(),
    checkout: z.string().optional(),
    branch: z.string().optional(),
    target_branch: z.string().optional(),
    base_commit: z.string().optional(),
    paths: z.array(z.string()).optional(),
  });
export type CompactLocation = z.infer<typeof compactLocationSchema>;
const compactWorkSchema = workRecordSchema
  .omit({
    id: true,
    created_at: true,
    location: true,
    parent_work_id: true,
    predecessor_work_id: true,
    blocker: true,
    commit: true,
    integration_commit: true,
  })
  .extend({
    location: compactLocationSchema.optional(),
    parent_work_id: workIdSchema.optional(),
    predecessor_work_id: workIdSchema.optional(),
    blocker: z.string().optional(),
    commit: z.string().optional(),
    integration_commit: z.string().optional(),
  });
export type CompactWork = z.infer<typeof compactWorkSchema>;
const blockingPathSchema = z.strictObject({
  length: z.number().int().nonnegative(),
  blocked_count: z.number().int().nonnegative(),
  task_ids: z.array(taskIdSchema),
  blocked_task_ids: z.array(taskIdSchema),
});
export type BlockingPath = z.infer<typeof blockingPathSchema>;
const omittedBlockingPathSchema = blockingPathSchema
  .omit({ task_ids: true, blocked_task_ids: true })
  .extend({ omitted: z.literal(true) });
export type OmittedBlockingPath = z.infer<typeof omittedBlockingPathSchema>;
const inclusionCountSchema = z.strictObject({
  eligible: z.number().int().nonnegative(),
  included: z.number().int().nonnegative(),
});
export const compactStatusResponseSchema = z.strictObject({
  project_id: projectIdSchema,
  coordinator_session_id: sessionIdSchema,
  plan_revision: planRevisionSchema,
  cursor: cursorSchema,
  map_hint: z.literal("include_map:true"),
  limited: z.boolean(),
  full_hint: z.literal("full:true").optional(),
  counts: z.strictObject({
    total: z.number().int().nonnegative(),
    by_status: z.partialRecord(taskStateSchema, z.number().int().nonnegative()),
    eligible: z.number().int().nonnegative(),
    included: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    work: inclusionCountSchema,
    sessions: inclusionCountSchema.extend({
      total: z.number().int().nonnegative(),
    }),
  }),
  tasks: z.record(z.string(), operationalTaskSchema),
  work: z.record(z.string(), compactWorkSchema),
  sessions: z.record(z.string(), compactSessionSchema),
  dependency_states: z.record(z.string(), taskStateSchema),
  blocking_path: z.union([blockingPathSchema, omittedBlockingPathSchema]),
  map_changed: z.boolean().optional(),
  map_omitted: z.literal(true).optional(),
  task_map: taskMapSchema.optional(),
  repository: z.string().optional(),
});
export type CompactStatusResponse = z.infer<typeof compactStatusResponseSchema>;
export interface ChangeBatch {
  seq: Cursor;
  actor_id: SessionId;
  created_at: string;
  records: RecordChange[];
}
export interface DeltaStatusResponse {
  project_id: ProjectId;
  plan_revision: PlanRevision;
  cursor: Cursor;
  has_more: boolean;
  changes: ChangeBatch[];
}
export interface WorkHistoryResponse {
  project_id: ProjectId;
  work: WorkRecord[];
  sessions: SessionRecord[];
  matched_work_count: number;
  cursor: Cursor;
  has_more: boolean;
  changes: ChangeBatch[];
}

const workRowSchema = z
  .object({ body: z.string() })
  .transform((row) => workRecordSchema.parse(JSON.parse(row.body)));
const batchRowSchema = z
  .object({
    seq: cursorSchema,
    actor_id: sessionIdSchema,
    created_at: z.string(),
    body: z.string(),
  })
  .transform((row): ChangeBatch => ({
    seq: row.seq,
    actor_id: row.actor_id,
    created_at: row.created_at,
    records: z.array(recordChangeSchema).parse(JSON.parse(row.body)),
  }));

function sessionsWithAncestors(
  tx: Transaction,
  ids: Iterable<SessionId>,
): SessionRecord[] {
  const pending = [...ids];
  const sessions = new Map<SessionId, SessionRecord>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || sessions.has(id)) continue;
    const session = tx.getSession(id);
    sessions.set(id, session);
    if (session.parent_session_id !== null)
      pending.push(session.parent_session_id);
  }
  return [...sessions.values()].sort((left, right) =>
    compareIds(left.id, right.id),
  );
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compactSession(session: SessionRecord): CompactSession {
  const {
    id: _id,
    created_at: _created,
    updated_at: _updated,
    parent_session_id,
    effort,
    ...result
  } = session;
  return {
    ...result,
    ...(parent_session_id ? { parent_session_id } : {}),
    ...(effort ? { effort } : {}),
  };
}

function compactWork(work: WorkRecord): CompactWork {
  const {
    id: _id,
    created_at: _created,
    location,
    parent_work_id,
    predecessor_work_id,
    blocker,
    commit,
    integration_commit,
    ...result
  } = work;
  const sparseLocation: CompactLocation = {
    ...(location.repository ? { repository: location.repository } : {}),
    ...(location.checkout ? { checkout: location.checkout } : {}),
    ...(location.branch ? { branch: location.branch } : {}),
    ...(location.target_branch
      ? { target_branch: location.target_branch }
      : {}),
    ...(location.base_commit ? { base_commit: location.base_commit } : {}),
    ...(location.paths.length > 0 ? { paths: location.paths } : {}),
  };
  return {
    ...result,
    ...(Object.keys(sparseLocation).length > 0
      ? { location: sparseLocation }
      : {}),
    ...(parent_work_id ? { parent_work_id } : {}),
    ...(predecessor_work_id ? { predecessor_work_id } : {}),
    ...(blocker ? { blocker } : {}),
    ...(commit ? { commit } : {}),
    ...(integration_commit ? { integration_commit } : {}),
  };
}

type PathState = { id: TaskId; blocked: boolean };
type PathStep = { length: number; parent: PathState | null };
type PathSteps = { clear?: PathStep; blocked?: PathStep };

export function blockingPath(
  tasks: ReadonlyMap<TaskId, TaskRecord>,
  blocked: ReadonlySet<TaskId>,
): BlockingPath {
  const unresolved = new Set(
    [...tasks.values()]
      .filter((task) => task.status !== "complete" || blocked.has(task.id))
      .map((task) => task.id),
  );
  const children = new Map<TaskId, TaskId[]>();
  const degree = new Map<TaskId, number>();
  const steps = new Map<TaskId, PathSteps>();
  for (const id of unresolved) {
    degree.set(id, 0);
    steps.set(
      id,
      blocked.has(id)
        ? { blocked: { length: 1, parent: null } }
        : { clear: { length: 1, parent: null } },
    );
  }
  for (const task of tasks.values()) {
    if (!unresolved.has(task.id)) continue;
    for (const dependency of task.depends_on) {
      if (
        !unresolved.has(dependency) ||
        tasks.get(dependency)?.status === "complete"
      )
        continue;
      const dependents = children.get(dependency) ?? [];
      dependents.push(task.id);
      children.set(dependency, dependents);
      degree.set(task.id, (degree.get(task.id) ?? 0) + 1);
    }
  }
  const queue = [...tasks.keys()].filter((id) => degree.get(id) === 0);
  let best: PathState | null = null;
  let bestLength = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    if (id === undefined) continue;
    const current = steps.get(id);
    if (current === undefined) continue;
    if (
      current.blocked &&
      (current.blocked.length > bestLength ||
        (current.blocked.length === bestLength &&
          best !== null &&
          id < best.id))
    ) {
      best = { id, blocked: true };
      bestLength = current.blocked.length;
    }
    for (const child of children.get(id) ?? []) {
      const next = steps.get(child);
      if (next === undefined) continue;
      for (const state of [false, true]) {
        const previous = state ? current.blocked : current.clear;
        if (previous === undefined) continue;
        const nextState = state || blocked.has(child);
        const existing = nextState ? next.blocked : next.clear;
        const length = previous.length + 1;
        const winsTie =
          existing?.parent != null &&
          (id < existing.parent.id ||
            (id === existing.parent.id && !state && existing.parent.blocked));
        if (
          existing === undefined ||
          length > existing.length ||
          (length === existing.length && winsTie)
        ) {
          const candidate = { length, parent: { id, blocked: state } };
          if (nextState) next.blocked = candidate;
          else next.clear = candidate;
        }
      }
      const remaining = (degree.get(child) ?? 0) - 1;
      degree.set(child, remaining);
      if (remaining === 0) queue.push(child);
    }
  }
  const path: TaskId[] = [];
  while (best !== null) {
    path.push(best.id);
    const previous: PathSteps | undefined = steps.get(best.id);
    best = (best.blocked ? previous?.blocked : previous?.clear)?.parent ?? null;
  }
  path.reverse();
  const blockers = path.filter((id) => blocked.has(id));
  return {
    length: path.length,
    blocked_count: blockers.length,
    task_ids: path,
    blocked_task_ids: blockers,
  };
}

function jsonSize(value: object | string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

type StatusEntry =
  | { collection: "tasks"; key: TaskId; value: OperationalTask }
  | { collection: "work"; key: WorkId; value: CompactWork }
  | { collection: "sessions"; key: SessionId; value: CompactSession }
  | { collection: "dependency_states"; key: TaskId; value: TaskState };

function admitUnit(
  response: CompactStatusResponse,
  entries: Iterable<StatusEntry>,
  size: number,
  budget: number | null,
  sizes: Map<string, number>,
): number {
  const additions: StatusEntry[] = [];
  const seen = new Set<string>();
  const populated = new Set<StatusEntry["collection"]>();
  let extra = 0;
  for (const entry of entries) {
    const cacheKey = JSON.stringify([entry.collection, entry.key]);
    if (
      Object.hasOwn(response[entry.collection], entry.key) ||
      seen.has(cacheKey)
    )
      continue;
    let entrySize = sizes.get(cacheKey);
    if (entrySize === undefined) {
      entrySize = jsonSize(entry.key) + 1 + jsonSize(entry.value);
      sizes.set(cacheKey, entrySize);
    }
    extra +=
      entrySize +
      Number(sizes.has(entry.collection) || populated.has(entry.collection));
    if (budget !== null && size + extra > budget) return size;
    seen.add(cacheKey);
    populated.add(entry.collection);
    additions.push(entry);
  }
  for (const entry of additions) {
    sizes.set(entry.collection, 0);
    switch (entry.collection) {
      case "tasks":
        response.tasks[entry.key] = entry.value;
        break;
      case "work":
        response.work[entry.key] = entry.value;
        break;
      case "sessions":
        response.sessions[entry.key] = entry.value;
        break;
      case "dependency_states":
        response.dependency_states[entry.key] = entry.value;
        break;
    }
  }
  return size + extra;
}

export function compactStatus(
  tx: Transaction,
  request: ProjectStatus,
): CompactStatusResponse {
  const project = tx.getProject(tx.projectId);
  if (
    request.known_plan_revision != null &&
    request.known_plan_revision > project.plan_revision
  ) {
    throw new BoardError(
      "invalid",
      "Known plan revision is above the current revision",
    );
  }
  const tasks = new Map(tx.allTasks().map((task) => [task.id, task]));
  const contributors = tx.queryRows(
    workRowSchema,
    `
    SELECT body FROM records WHERE project_id = ? AND kind = 'work'
      AND json_extract(body, '$.role') = 'contributor'
      AND json_extract(body, '$.status') NOT IN ('complete', 'cancelled', 'released', 'abandoned')
    ORDER BY id`,
    [tx.projectId],
  );
  const contributorTasks = new Set(contributors.map((work) => work.task_id));
  const blocked = new Set(
    [...tasks.values()]
      .filter((task) => task.status === "blocked")
      .map((task) => task.id),
  );
  for (const work of contributors)
    if (work.status === "blocked") blocked.add(work.task_id);
  const available = new Set(
    [...tasks.values()]
      .filter(
        (task) =>
          task.status === "pending" &&
          !task.owner_work_id &&
          task.depends_on.every((id) => tasks.get(id)?.status === "complete"),
      )
      .map((task) => task.id),
  );
  let eligible = new Set(
    [...tasks.values()]
      .filter(
        (task) =>
          ["in_progress", "blocked", "awaiting_integration"].includes(
            task.status,
          ) ||
          (task.status === "pending" && task.owner_work_id) ||
          available.has(task.id) ||
          contributorTasks.has(task.id),
      )
      .map((task) => task.id),
  );
  if (request.full) eligible = new Set(tasks.keys());
  else if (request.task_ids != null) {
    eligible = new Set();
    const pending = [...request.task_ids];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined || eligible.has(id)) continue;
      const task = tasks.get(id);
      if (task === undefined)
        throw new BoardError("not_found", `Task '${id}' does not exist`);
      eligible.add(id);
      pending.push(...task.depends_on);
    }
  }
  const ownerIds: WorkId[] = [];
  for (const id of eligible) {
    const owner = tasks.get(id)?.owner_work_id;
    if (owner) ownerIds.push(owner);
  }
  const eligibleWork = tx.queryRows(
    workRowSchema,
    `
    SELECT body FROM records WHERE project_id = ? AND kind = 'work'
      AND id IN (SELECT value FROM json_each(?)) ORDER BY id`,
    [tx.projectId, JSON.stringify(ownerIds)],
  );
  for (const work of contributors)
    if (eligible.has(work.task_id)) eligibleWork.push(work);
  const byTask = new Map<TaskId, WorkRecord[]>();
  for (const work of eligibleWork) {
    const records = byTask.get(work.task_id) ?? [];
    records.push(work);
    byTask.set(work.task_id, records);
  }
  const sessionIds = new Set(eligibleWork.map((work) => work.session_id));
  sessionIds.add(project.coordinator_session_id);
  const sessions = request.full
    ? tx.allSessions()
    : sessionsWithAncestors(tx, sessionIds);
  const sessionRecords = new Map(
    sessions.map((session) => [session.id, compactSession(session)]),
  );
  const sessionTotal =
    tx.queryRows(
      z.object({ count: z.number().int().nonnegative() }),
      "SELECT COUNT(*) AS count FROM records WHERE project_id = ? AND kind = 'session'",
      [tx.projectId],
    )[0]?.count ?? 0;
  const byStatus: Partial<Record<TaskState, number>> = {};
  for (const task of tasks.values())
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
  const path = blockingPath(tasks, blocked);
  const mapRequested =
    request.full ||
    request.include_map ||
    (request.known_plan_revision != null &&
      request.known_plan_revision !== project.plan_revision);
  const response: CompactStatusResponse = {
    project_id: tx.projectId,
    coordinator_session_id: project.coordinator_session_id,
    plan_revision: project.plan_revision,
    cursor: tx.cursor(),
    map_hint: "include_map:true",
    limited: true,
    full_hint: "full:true",
    counts: {
      total: tasks.size,
      by_status: byStatus,
      eligible: eligible.size,
      included: eligible.size,
      available: available.size,
      waiting: [...tasks.values()].filter(
        (task) =>
          task.status === "pending" &&
          !task.owner_work_id &&
          !available.has(task.id),
      ).length,
      work: { eligible: eligibleWork.length, included: eligibleWork.length },
      sessions: {
        total: sessionTotal,
        eligible: sessions.length,
        included: sessions.length,
      },
    },
    tasks: {},
    work: {},
    sessions: {},
    dependency_states: {},
    blocking_path: {
      length: path.length,
      blocked_count: path.blocked_count,
      omitted: true,
    },
  };
  if (request.known_plan_revision != null)
    response.map_changed =
      request.known_plan_revision !== project.plan_revision;
  if (mapRequested) response.map_omitted = true;
  if (request.full) response.repository = project.repository;
  const budget = request.full ? null : STATUS_BUDGET;
  let size = jsonSize(response);
  const pathExtra = jsonSize(path) - jsonSize(response.blocking_path);
  let pathIncluded =
    Boolean(request.full) || jsonSize(path) <= STATUS_BUDGET / 4;
  if (pathIncluded) {
    response.blocking_path = path;
    size += pathExtra;
  }
  function* sessionEntries(ids: Iterable<SessionId>): Generator<StatusEntry> {
    const pending = [...ids];
    const seen = new Set<SessionId>();
    while (pending.length > 0) {
      const id = pending.pop();
      if (
        id === undefined ||
        seen.has(id) ||
        Object.hasOwn(response.sessions, id)
      )
        continue;
      seen.add(id);
      const session = sessionRecords.get(id);
      if (session === undefined)
        throw new BoardError("not_found", `Session '${id}' does not exist`);
      yield { collection: "sessions", key: id, value: session };
      if (session.parent_session_id) pending.push(session.parent_session_id);
    }
  }
  function* taskEntries(id: TaskId): Generator<StatusEntry> {
    const task = tasks.get(id);
    if (task === undefined)
      throw new BoardError("not_found", `Task '${id}' does not exist`);
    const operational: OperationalTask = {
      revision: task.revision,
      status: task.status,
    };
    if (task.owner_work_id) operational.owner_work_id = task.owner_work_id;
    if (available.has(id)) operational.available = true;
    yield { collection: "tasks", key: id, value: operational };
    for (const work of byTask.get(id) ?? [])
      yield { collection: "work", key: work.id, value: compactWork(work) };
    for (const dependency of task.depends_on) {
      const prerequisite = tasks.get(dependency);
      if (prerequisite === undefined)
        throw new BoardError(
          "not_found",
          `Task '${dependency}' does not exist`,
        );
      yield {
        collection: "dependency_states",
        key: dependency,
        value: prerequisite.status,
      };
    }
    yield* sessionEntries(
      (byTask.get(id) ?? []).map((work) => work.session_id),
    );
  }
  const sizes = new Map<string, number>();
  size = admitUnit(
    response,
    sessionEntries([project.coordinator_session_id]),
    size,
    budget,
    sizes,
  );
  function priority(id: TaskId): number {
    if (blocked.has(id)) return 0;
    const task = tasks.get(id);
    if (task?.status === "awaiting_integration") return 1;
    if (task?.status === "in_progress") return 2;
    if (contributorTasks.has(id) || task?.owner_work_id) return 3;
    return available.has(id) ? 4 : 5;
  }
  const ordered = [...eligible].sort(
    (left, right) =>
      priority(left) - priority(right) || compareIds(left, right),
  );
  for (const id of ordered)
    size = admitUnit(response, taskEntries(id), size, budget, sizes);
  if (request.full)
    size = admitUnit(
      response,
      sessionEntries(sessionRecords.keys()),
      size,
      budget,
      sizes,
    );
  if (!pathIncluded && size + pathExtra <= STATUS_BUDGET) {
    response.blocking_path = path;
    size += pathExtra;
    pathIncluded = true;
  }
  if (mapRequested) {
    const mapping = taskMap(tasks.values());
    const extra = jsonSize("task_map") + 1 + jsonSize(mapping) + 1;
    if (budget === null || size + extra <= budget) {
      response.task_map = mapping;
      delete response.map_omitted;
    }
  }
  response.counts.included = Object.keys(response.tasks).length;
  response.counts.work.included = Object.keys(response.work).length;
  response.counts.sessions.included = Object.keys(response.sessions).length;
  response.limited =
    response.counts.included < eligible.size ||
    response.counts.sessions.included < sessions.length ||
    !pathIncluded ||
    Boolean(response.map_omitted);
  if (!response.limited) delete response.full_hint;
  return response;
}

export function projectStatus(
  tx: Transaction,
  request: ProjectStatus,
): CompactStatusResponse | DeltaStatusResponse {
  if (request.since == null) return compactStatus(tx, request);
  const project = tx.getProject(tx.projectId);
  if (request.since > tx.cursor())
    throw new BoardError(
      "invalid",
      "Cursor is above this project's latest change",
    );
  const limit = request.limit ?? 100;
  const rows = tx.queryRows(
    batchRowSchema,
    `SELECT seq, actor_id, created_at, body FROM changes
    WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    [tx.projectId, request.since, limit + 1],
  );
  const changes = rows.slice(0, limit);
  const cursor = changes.at(-1)?.seq ?? request.since;
  const hasMore = rows.length > limit;
  let planRevision = project.plan_revision;
  if (hasMore) {
    const version = tx.queryRows(
      z.object({ plan_revision: planRevisionSchema }),
      `
      SELECT json_extract(entry.value, '$.record.plan_revision') AS plan_revision
      FROM changes AS change, json_each(change.body) AS entry
      WHERE change.project_id = ? AND change.seq <= ? AND json_extract(entry.value, '$.kind') = 'project'
      ORDER BY change.seq DESC LIMIT 1`,
      [tx.projectId, cursor],
    )[0];
    if (version === undefined)
      throw new BoardError(
        "not_found",
        "Project history does not exist at this cursor",
      );
    planRevision = version.plan_revision;
  }
  return {
    project_id: tx.projectId,
    plan_revision: planRevision,
    cursor,
    has_more: hasMore,
    changes,
  };
}

function historyBatch(
  batch: ChangeBatch,
  matchedIds: ReadonlySet<WorkId>,
): ChangeBatch {
  const sessions = new Map<SessionId, SessionRecord>();
  const pending = new Set<SessionId>([batch.actor_id]);
  for (const entry of batch.records) {
    if (entry.kind === "session") sessions.set(entry.id, entry.record);
    if (entry.kind === "work" && matchedIds.has(entry.id))
      pending.add(entry.record.session_id);
  }
  const included = new Set<SessionId>();
  for (const id of pending) {
    if (included.has(id)) continue;
    included.add(id);
    const parent = sessions.get(id)?.parent_session_id;
    if (parent) pending.add(parent);
  }
  return {
    ...batch,
    records: batch.records.filter(
      (entry) =>
        (entry.kind === "work" && matchedIds.has(entry.id)) ||
        (entry.kind === "session" && included.has(entry.id)),
    ),
  };
}

export function workHistory(
  tx: Transaction,
  request: WorkHistory,
): WorkHistoryResponse {
  tx.getProject(tx.projectId);
  const conditions: string[] = [];
  const values: SqlValue[] = [tx.projectId, tx.projectId];
  for (const field of ["task_id", "session_id"] satisfies (
    "task_id" | "session_id"
  )[]) {
    const value = request[field];
    if (value != null) {
      conditions.push(`json_extract(document, '$.${field}') = ?`);
      values.push(value);
    }
  }
  if (request.path != null) {
    conditions.push(
      "EXISTS (SELECT 1 FROM json_each(document, '$.location.paths') WHERE value = ?)",
    );
    values.push(request.path);
  }
  if (request.branch != null) {
    conditions.push("json_extract(document, '$.location.branch') = ?");
    values.push(request.branch);
  }
  if (request.commit != null) {
    conditions.push(
      "(json_extract(document, '$.commit') = ? OR json_extract(document, '$.integration_commit') = ? OR json_extract(document, '$.location.base_commit') = ?)",
    );
    values.push(request.commit, request.commit, request.commit);
  }
  const matched = tx.queryRows(
    z.object({ id: workIdSchema }),
    `
    WITH versions AS (
      SELECT id, body AS document FROM records WHERE project_id = ? AND kind = 'work'
      UNION ALL
      SELECT json_extract(entry.value, '$.id'), json_extract(entry.value, '$.record')
      FROM changes AS change, json_each(change.body) AS entry
      WHERE change.project_id = ? AND json_extract(entry.value, '$.kind') = 'work'
    ) SELECT DISTINCT id FROM versions WHERE ${conditions.join(" AND ")} ORDER BY id`,
    values,
  );
  const matchedIds = new Set(matched.map((row) => row.id));
  const after = request.after ?? cursorSchema.parse(0);
  const limit = request.limit ?? 100;
  const batches =
    matched.length === 0
      ? []
      : tx.queryRows(
          batchRowSchema,
          `
    SELECT change.seq, change.actor_id, change.created_at, change.body FROM changes AS change
    WHERE change.project_id = ? AND change.seq > ? AND EXISTS (
      SELECT 1 FROM json_each(change.body) AS entry
      WHERE json_extract(entry.value, '$.kind') = 'work'
        AND json_extract(entry.value, '$.id') IN (SELECT value FROM json_each(?))
    ) ORDER BY change.seq LIMIT ?`,
          [tx.projectId, after, JSON.stringify([...matchedIds]), limit + 1],
        );
  const changes = batches
    .slice(0, limit)
    .map((batch) => historyBatch(batch, matchedIds));
  const pageIds = new Set<WorkId>();
  for (const batch of changes)
    for (const entry of batch.records)
      if (entry.kind === "work") pageIds.add(entry.id);
  const work = tx.queryRows(
    workRowSchema,
    `SELECT body FROM records WHERE project_id = ? AND kind = 'work'
    AND id IN (SELECT value FROM json_each(?)) ORDER BY id`,
    [tx.projectId, JSON.stringify([...pageIds].sort(compareIds))],
  );
  const sessionIds = new Set(work.map((record) => record.session_id));
  for (const batch of changes) sessionIds.add(batch.actor_id);
  return {
    project_id: tx.projectId,
    work,
    sessions: sessionsWithAncestors(tx, sessionIds),
    matched_work_count: matchedIds.size,
    cursor: changes.at(-1)?.seq ?? after,
    has_more: batches.length > limit,
    changes,
  };
}
