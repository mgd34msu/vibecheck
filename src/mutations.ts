import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Transaction } from "./db.js";
import { BoardError } from "./errors.js";
import { taskMap } from "./plans.js";
import {
  normalizeLocation,
  planRevisionSchema,
  sessionIdSchema,
  workIdSchema,
  type Location,
  type LocationRecord,
  type PlanAck,
  type PlanEdit,
  type PlanPublish,
  type ProjectJoin,
  type ProjectRecord,
  type SessionId,
  type TaskFields,
  type TaskId,
  type TaskRecord,
  type TaskState,
  type WorkClaim,
  type WorkFields,
  type WorkId,
  type WorkRecord,
  type WorkState,
  type WorkUpdate,
} from "./schemas.js";

function expectRevision(
  record: { id: string; revision: number },
  expected: number | null | undefined,
): void {
  if (expected !== record.revision) {
    throw new BoardError(
      "conflict",
      "Expected revision does not match the current record",
      {
        id: record.id,
        expected: expected ?? null,
        actual: record.revision,
      },
    );
  }
}

function newWork(
  taskId: TaskId,
  sessionId: SessionId,
  location: LocationRecord,
  parentWorkId: WorkId | null = null,
  predecessorWorkId: WorkId | null = null,
): WorkFields {
  return {
    task_id: taskId,
    session_id: sessionId,
    parent_work_id: parentWorkId,
    predecessor_work_id: predecessorWorkId,
    role: parentWorkId === null ? "owner" : "contributor",
    status: "in_progress",
    location,
    blocker: null,
    commit: null,
    integration_commit: null,
    integration_required: false,
  };
}

const priorRequirementSchema = z.object({ required: z.literal(1) });

function integrationRequired(tx: Transaction, initial: WorkRecord): boolean {
  const visited = new Set<WorkId>();
  let work: WorkRecord | undefined = initial;
  while (work !== undefined) {
    if (work.integration_required !== undefined)
      return work.integration_required;
    if (work.status === "awaiting_integration") return true;
    if (visited.has(work.id)) {
      throw new BoardError(
        "conflict",
        "Work predecessor history contains a cycle",
      );
    }
    visited.add(work.id);
    const priorRequirement = tx.queryRows(
      priorRequirementSchema,
      `SELECT 1 AS required FROM changes AS change, json_each(change.body) AS item
       WHERE change.project_id = ?
         AND json_extract(item.value, '$.kind') = 'work'
         AND json_extract(item.value, '$.id') = ?
         AND (json_extract(item.value, '$.record.status') = 'awaiting_integration'
              OR json_extract(item.value, '$.record.integration_required') = 1)
       LIMIT 1`,
      [tx.projectId, work.id],
    );
    if (priorRequirement.length > 0) return true;
    work =
      work.predecessor_work_id === null
        ? undefined
        : tx.getWork(work.predecessor_work_id);
    if (work !== undefined && work.status !== "released") return false;
  }
  return false;
}

function terminalWork(status: WorkState): boolean {
  return (
    status === "complete" ||
    status === "cancelled" ||
    status === "released" ||
    status === "abandoned"
  );
}

function openWorkStatus(status: WorkState): TaskState {
  switch (status) {
    case "complete":
    case "cancelled":
    case "released":
    case "abandoned":
      throw new BoardError("conflict", "Terminal work records cannot change");
    case "pending":
    case "in_progress":
    case "blocked":
    case "awaiting_integration":
      return status;
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

export function projectJoin(tx: Transaction, request: ProjectJoin) {
  const project = tx.findProject(tx.projectId);
  if (project !== undefined && project.repository !== request.repository) {
    throw new BoardError("conflict", "The project repository cannot change");
  }
  const parentId = request.parent_session_id ?? null;
  if (parentId !== null) tx.getSession(parentId);
  const session = tx
    .allSessions()
    .find(
      (entry) =>
        entry.vendor === request.vendor &&
        entry.runtime === request.runtime &&
        entry.external_session_id === request.external_session_id,
    );
  if (session !== undefined && session.parent_session_id !== parentId) {
    throw new BoardError("conflict", "A session's parent cannot change");
  }
  if (project === undefined && parentId !== null) {
    throw new BoardError("invalid", "The first session must be a root session");
  }
  if (request.take_over_from != null) {
    if (
      project === undefined ||
      project.coordinator_session_id !== request.take_over_from
    ) {
      throw new BoardError(
        "conflict",
        "Coordinator takeover does not match the current coordinator",
      );
    }
    if (parentId !== null) {
      throw new BoardError(
        "forbidden",
        "Only a root session can become coordinator",
      );
    }
  }
  const sessionId =
    session?.id ??
    sessionIdSchema.parse(`s_${randomUUID().replaceAll("-", "")}`);
  tx.actorId = sessionId;
  tx.putSession(sessionId, {
    ...session,
    vendor: request.vendor,
    runtime: request.runtime,
    external_session_id: request.external_session_id,
    parent_session_id: parentId,
    model: request.model,
    effort: request.effort ?? null,
    last_seen_at: tx.now,
  });
  if (project === undefined) {
    tx.putProject(tx.projectId, {
      repository: request.repository,
      coordinator_session_id: sessionId,
      plan_revision: planRevisionSchema.parse(0),
    });
  } else if (
    request.take_over_from != null &&
    project.coordinator_session_id !== sessionId
  ) {
    tx.putProject(tx.projectId, {
      ...project,
      coordinator_session_id: sessionId,
    });
  }
  return { session_id: sessionId };
}

function planContext(tx: Transaction, request: PlanPublish | PlanEdit) {
  const project = tx.getProject(tx.projectId);
  tx.getSession(request.session_id);
  if (project.coordinator_session_id !== request.session_id) {
    throw new BoardError(
      "forbidden",
      "Only the coordinator can change the plan",
    );
  }
  if (request.expected_revision !== project.plan_revision) {
    throw new BoardError(
      "conflict",
      "Expected plan_revision does not match the current record",
      {
        id: project.id,
        expected: request.expected_revision,
        actual: project.plan_revision,
      },
    );
  }
  return {
    project,
    previous: new Map(tx.allTasks().map((task) => [task.id, task])),
  };
}

function mergeTask(old: TaskRecord, fields: Partial<TaskFields>): TaskFields {
  const status = fields.status ?? old.status;
  if (
    status !== old.status &&
    (old.owner_work_id !== null ||
      (old.status !== "pending" && old.status !== "cancelled"))
  ) {
    throw new BoardError(
      "conflict",
      "Only unclaimed pending or cancelled tasks can change state in a plan",
    );
  }
  return { ...old, ...fields };
}

function validateTaskGraph(
  tasks: Map<TaskId, TaskFields>,
  field: "depends_on" | "supersedes",
): void {
  interface Node {
    remaining: number;
    dependents: Node[];
  }
  const nodes = new Map<TaskId, Node>();
  for (const [taskId, task] of tasks) {
    nodes.set(taskId, {
      remaining: (task[field] ?? []).length,
      dependents: [],
    });
  }
  for (const [taskId, node] of nodes) {
    const edges = tasks.get(taskId)?.[field] ?? [];
    if (new Set(edges).size !== edges.length) {
      throw new BoardError(
        "invalid",
        `Task ${field} references must be unique`,
        { task_id: taskId },
      );
    }
    for (const dependency of edges) {
      if (dependency === taskId) {
        throw new BoardError(
          "invalid",
          `Task ${field} cannot reference itself`,
          { task_id: taskId },
        );
      }
      const dependencyNode = nodes.get(dependency);
      if (dependencyNode === undefined) {
        throw new BoardError("invalid", `Unknown task in ${field}`, {
          task_id: dependency,
        });
      }
      dependencyNode.dependents.push(node);
    }
  }
  const ready = [...nodes.values()].filter((node) => node.remaining === 0);
  let visited = 0;
  for (const node of ready) {
    visited += 1;
    for (const dependent of node.dependents) {
      dependent.remaining -= 1;
      if (dependent.remaining === 0) ready.push(dependent);
    }
  }
  if (visited !== tasks.size) {
    throw new BoardError("invalid", `Task ${field} references contain a cycle`);
  }
}

function savePlan(
  tx: Transaction,
  project: ProjectRecord,
  previous: Map<TaskId, TaskRecord>,
  tasks: Map<TaskId, TaskFields>,
) {
  if (tasks.size > 10_000)
    throw new BoardError(
      "invalid",
      "A plan cannot contain more than 10000 tasks",
    );
  validateTaskGraph(tasks, "depends_on");
  validateTaskGraph(tasks, "supersedes");
  const records: TaskRecord[] = [];
  for (const [taskId, fields] of [...tasks].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const old = previous.get(taskId);
    const record =
      old !== undefined && isDeepStrictEqual(fields, old)
        ? old
        : tx.putTask(taskId, fields);
    records.push(record);
  }
  const operational = Object.fromEntries(
    records.map((record) => [
      record.id,
      {
        revision: record.revision,
        status: record.status,
        ...(record.owner_work_id === null
          ? {}
          : { owner_work_id: record.owner_work_id }),
      },
    ]),
  );
  const updated = tx.putProject(tx.projectId, {
    ...project,
    plan_revision: planRevisionSchema.parse(project.plan_revision + 1),
  });
  return {
    plan_revision: updated.plan_revision,
    task_map: taskMap(records),
    tasks: operational,
  };
}

export function planPublish(tx: Transaction, request: PlanPublish) {
  const { project, previous } = planContext(tx, request);
  const ids = new Set(request.tasks.map((task) => task.id));
  if (ids.size !== request.tasks.length)
    throw new BoardError("invalid", "Task IDs must be unique");
  const omitted = [...previous.keys()].filter((id) => !ids.has(id)).sort();
  if (omitted.length > 0) {
    throw new BoardError("invalid", "Existing tasks cannot be omitted", {
      task_ids: omitted,
    });
  }
  const tasks = new Map<TaskId, TaskFields>();
  for (const definition of request.tasks) {
    const fields = {
      label: definition.label,
      depends_on: definition.depends_on ?? [],
      ...(definition.status === undefined ? {} : { status: definition.status }),
      ...(definition.supersedes === undefined
        ? {}
        : { supersedes: definition.supersedes }),
    };
    const old = previous.get(definition.id);
    tasks.set(
      definition.id,
      old === undefined
        ? { status: "pending", owner_work_id: null, supersedes: [], ...fields }
        : mergeTask(old, fields),
    );
  }
  return savePlan(tx, project, previous, tasks);
}

export function planEdit(tx: Transaction, request: PlanEdit) {
  const { project, previous } = planContext(tx, request);
  const tasks = new Map<TaskId, TaskFields>(previous);
  const touched = new Set<TaskId>();
  for (const operation of request.operations) {
    const taskId =
      operation.op === "add" ? operation.task.id : operation.task_id;
    if (touched.has(taskId)) {
      throw new BoardError(
        "invalid",
        "A task may appear only once in a plan edit",
        { task_id: taskId },
      );
    }
    touched.add(taskId);
    if (operation.op === "add") {
      if (previous.has(taskId)) {
        throw new BoardError("conflict", "A task ID cannot be reused", {
          task_id: taskId,
        });
      }
      tasks.set(taskId, {
        label: operation.task.label,
        depends_on: operation.task.depends_on ?? [],
        status: operation.task.status ?? "pending",
        supersedes: operation.task.supersedes ?? [],
        owner_work_id: null,
      });
    } else {
      const old = previous.get(taskId);
      if (old === undefined) {
        throw new BoardError("not_found", "Cannot update an unknown task", {
          task_id: taskId,
        });
      }
      tasks.set(
        taskId,
        mergeTask(old, {
          ...(operation.label === undefined ? {} : { label: operation.label }),
          ...(operation.depends_on === undefined
            ? {}
            : { depends_on: operation.depends_on }),
          ...(operation.status === undefined
            ? {}
            : { status: operation.status }),
          ...(operation.supersedes === undefined
            ? {}
            : { supersedes: operation.supersedes }),
        }),
      );
    }
  }
  return savePlan(tx, project, previous, tasks);
}

export function planAck(tx: Transaction, request: PlanAck) {
  const project = tx.getProject(tx.projectId);
  const session = tx.getSession(request.session_id);
  if (request.plan_revision > project.plan_revision) {
    throw new BoardError(
      "invalid",
      "Cannot acknowledge a future plan revision",
    );
  }
  if (
    session.acknowledged_plan_revision !== undefined &&
    request.plan_revision < session.acknowledged_plan_revision
  ) {
    throw new BoardError(
      "conflict",
      "A plan acknowledgment cannot move backwards",
    );
  }
  const acknowledgedAt =
    request.plan_revision === session.acknowledged_plan_revision
      ? session.acknowledged_at
      : tx.now;
  if (acknowledgedAt === undefined)
    throw new Error("Stored acknowledgment has no timestamp");
  if (request.plan_revision !== session.acknowledged_plan_revision) {
    tx.putSession(session.id, {
      ...session,
      acknowledged_plan_revision: request.plan_revision,
      acknowledged_at: acknowledgedAt,
    });
  }
  return {
    plan_revision: project.plan_revision,
    session_id: session.id,
    acknowledged_plan_revision: request.plan_revision,
    acknowledged_at: acknowledgedAt,
  };
}

export function workClaim(tx: Transaction, request: WorkClaim) {
  tx.getProject(tx.projectId);
  const session = tx.getSession(request.session_id);
  let task = tx.getTask(request.task_id);
  expectRevision(task, request.expected_revision);
  if (task.status === "complete" || task.status === "cancelled") {
    throw new BoardError("conflict", "A terminal task cannot be claimed");
  }
  const parentId = request.parent_work_id ?? null;
  const predecessorId = request.replace_work_id ?? null;
  if (parentId !== null) {
    const parent = tx.getWork(parentId);
    if (parent.task_id !== task.id) {
      throw new BoardError(
        "invalid",
        "Contributor and parent work must belong to the same task",
      );
    }
    if (parent.session_id !== session.parent_session_id) {
      throw new BoardError(
        "forbidden",
        "Contributor work must be delegated by the session's immediate parent",
      );
    }
    if (terminalWork(parent.status)) {
      throw new BoardError(
        "conflict",
        "Contributor work requires an open parent work record",
      );
    }
  } else if (predecessorId !== null) {
    if (task.owner_work_id !== predecessorId) {
      throw new BoardError(
        "conflict",
        "Replacement does not match the task's current owner",
      );
    }
    const previous = tx.getWork(predecessorId);
    if (terminalWork(previous.status))
      throw new BoardError("conflict", "Terminal work cannot be replaced");
    tx.putWork(previous.id, {
      ...previous,
      status: "abandoned",
      integration_required: integrationRequired(tx, previous),
    });
  } else if (task.owner_work_id !== null) {
    throw new BoardError("conflict", "The task already has an owner");
  }
  const workId = workIdSchema.parse(`w_${randomUUID().replaceAll("-", "")}`);
  const work = tx.putWork(
    workId,
    newWork(
      task.id,
      request.session_id,
      normalizeLocation(request.location),
      parentId,
      predecessorId,
    ),
  );
  if (parentId === null) {
    task = tx.putTask(task.id, {
      ...task,
      owner_work_id: workId,
      status: "in_progress",
    });
  }
  return { task, work };
}

function validateWorkState(work: WorkRecord): void {
  if (work.status === "blocked" && !work.blocker) {
    throw new BoardError("invalid", "Blocked work requires a blocker");
  }
  if (
    work.status === "awaiting_integration" &&
    (!work.commit || !work.location.target_branch)
  ) {
    throw new BoardError(
      "invalid",
      "Work awaiting integration requires a commit and target branch",
    );
  }
  if (
    work.status === "complete" &&
    work.integration_required &&
    !work.integration_commit
  ) {
    throw new BoardError(
      "invalid",
      "Completing work awaiting integration requires an integration commit",
    );
  }
}

function mergeLocation(old: LocationRecord, patch: Location): LocationRecord {
  return {
    repository:
      patch.repository === undefined ? old.repository : patch.repository,
    checkout: patch.checkout === undefined ? old.checkout : patch.checkout,
    branch: patch.branch === undefined ? old.branch : patch.branch,
    target_branch:
      patch.target_branch === undefined
        ? old.target_branch
        : patch.target_branch,
    base_commit:
      patch.base_commit === undefined ? old.base_commit : patch.base_commit,
    paths: patch.paths === undefined ? old.paths : patch.paths,
  };
}

export function workUpdate(tx: Transaction, request: WorkUpdate) {
  const project = tx.getProject(tx.projectId);
  tx.getSession(request.session_id);
  const updates = request.updates ?? [];
  if (
    new Set(updates.map((change) => change.work_id)).size !== updates.length
  ) {
    throw new BoardError(
      "invalid",
      "A work record may appear only once in an update batch",
    );
  }
  const changedTasks = new Map<TaskId, TaskRecord>();
  const changedWork = new Map<WorkId, WorkRecord>();
  for (const change of updates) {
    const old = tx.getWork(change.work_id);
    if (
      old.session_id !== request.session_id &&
      project.coordinator_session_id !== request.session_id
    ) {
      throw new BoardError(
        "forbidden",
        "Only the work's session or the coordinator can update it",
      );
    }
    expectRevision(old, change.expected_revision);
    const oldStatus = openWorkStatus(old.status);
    let task = tx.getTask(old.task_id);
    const owner = old.role === "owner";
    if (owner && task.owner_work_id !== old.id) {
      throw new BoardError(
        "conflict",
        "The work record is no longer the task's owner",
      );
    }
    if (change.expected_task_revision != null)
      expectRevision(task, change.expected_task_revision);
    let updated: WorkRecord = {
      ...old,
      integration_required: integrationRequired(tx, old),
    };
    if (change.action === undefined || change.action === "progress") {
      const status = change.status ?? oldStatus;
      updated = {
        ...updated,
        status,
        ...(change.blocker === undefined ? {} : { blocker: change.blocker }),
        ...(change.commit === undefined ? {} : { commit: change.commit }),
        ...(change.integration_commit === undefined
          ? {}
          : { integration_commit: change.integration_commit }),
      };
      if (change.location !== undefined) {
        updated.location =
          change.location === null
            ? normalizeLocation()
            : mergeLocation(old.location, change.location);
      }
      if (
        change.integration_commit === undefined &&
        (updated.commit !== old.commit ||
          updated.location.target_branch !== old.location.target_branch ||
          (updated.location.repository ?? project.repository) !==
            (old.location.repository ?? project.repository))
      ) {
        updated.integration_commit = null;
      }
      updated.integration_required =
        updated.integration_required === true ||
        status === "awaiting_integration";
      validateWorkState(updated);
      if (owner && status !== task.status) {
        expectRevision(task, change.expected_task_revision);
        task = tx.putTask(task.id, { ...task, status });
        changedTasks.set(task.id, task);
      }
    } else if (change.action === "release") {
      updated.status = "released";
      if (owner) {
        expectRevision(task, change.expected_task_revision);
        task = tx.putTask(task.id, {
          ...task,
          status: "pending",
          owner_work_id: null,
        });
        changedTasks.set(task.id, task);
      }
    } else if (change.action === "handoff") {
      if (!owner)
        throw new BoardError(
          "invalid",
          "Contributor work cannot be handed off",
        );
      expectRevision(task, change.expected_task_revision);
      tx.getSession(change.handoff_to);
      updated.status = "released";
      const successor = tx.putWork(
        workIdSchema.parse(`w_${randomUUID().replaceAll("-", "")}`),
        {
          ...newWork(
            task.id,
            change.handoff_to,
            { ...old.location },
            null,
            old.id,
          ),
          status: old.status,
          blocker: old.blocker,
          commit: old.commit,
          integration_commit: old.integration_commit,
          integration_required: updated.integration_required,
        },
      );
      changedWork.set(successor.id, successor);
      task = tx.putTask(task.id, { ...task, owner_work_id: successor.id });
      changedTasks.set(task.id, task);
    }
    if (!isDeepStrictEqual(updated, old)) {
      updated = tx.putWork(old.id, updated);
      changedWork.set(updated.id, updated);
    }
  }
  return { tasks: [...changedTasks.values()], work: [...changedWork.values()] };
}

export type ProjectJoinResponse = ReturnType<typeof projectJoin>;
export type PlanPublishResponse = ReturnType<typeof planPublish>;
export type PlanEditResponse = ReturnType<typeof planEdit>;
export type PlanAckResponse = ReturnType<typeof planAck>;
export type WorkClaimResponse = ReturnType<typeof workClaim>;
export type WorkUpdateResponse = ReturnType<typeof workUpdate>;
