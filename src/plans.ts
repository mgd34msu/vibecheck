import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Transaction } from "./db.js";
import { BoardError } from "./errors.js";
import {
  cursorSchema,
  planMetadataSchema,
  taskIdSchema,
  taskRecordSchema,
  type PlanRead,
  type PlanReadResult,
  type PlanRevision,
  type TaskMap,
  type TaskRecord,
} from "./schemas.js";

export type { TaskMap } from "./schemas.js";

export function taskMap(tasks: Iterable<TaskRecord>): TaskMap {
  return Object.fromEntries(
    Array.from(tasks, (task) => [
      task.id,
      {
        label: task.label,
        depends_on: task.depends_on,
        ...(task.supersedes?.length ? { supersedes: task.supersedes } : {}),
      },
    ]),
  );
}

const publicationSchema = planMetadataSchema.extend({
  seq: cursorSchema,
});
const historicalTaskSchema = z.object({ record: z.string() });

function revision(
  tx: Transaction,
  requested: PlanRevision,
  current: PlanRevision,
) {
  if (requested === 0) return { definitions: taskMap([]) };

  const [publication] = tx.queryRows(
    publicationSchema,
    `
    SELECT change.seq, change.actor_id, change.created_at
    FROM changes AS change
    WHERE change.project_id = ? AND EXISTS (
      SELECT 1 FROM json_each(change.body) AS item
      WHERE json_extract(item.value, '$.kind') = 'project'
        AND json_extract(item.value, '$.id') = ?
        AND json_extract(item.value, '$.record.plan_revision') = ?
    )
    ORDER BY change.seq LIMIT 1
  `,
    [tx.projectId, tx.projectId, requested],
  );
  if (publication === undefined) {
    throw new BoardError("not_found", "Plan revision history was not found", {
      plan_revision: requested,
    });
  }
  const metadata = {
    actor_id: publication.actor_id,
    created_at: publication.created_at,
  };
  if (requested === current)
    return { definitions: taskMap(tx.allTasks()), metadata };

  const rows = tx.queryRows(
    historicalTaskSchema,
    `
    WITH versions AS (
      SELECT json_extract(item.value, '$.record') AS record,
             json_extract(item.value, '$.id') AS task_id,
             ROW_NUMBER() OVER (
               PARTITION BY json_extract(item.value, '$.id')
               ORDER BY change.seq DESC
             ) AS position
      FROM changes AS change, json_each(change.body) AS item
      WHERE change.project_id = ? AND change.seq <= ?
        AND json_extract(item.value, '$.kind') = 'task'
    )
    SELECT record FROM versions WHERE position = 1 ORDER BY task_id
  `,
    [tx.projectId, publication.seq],
  );
  return {
    definitions: taskMap(
      rows.map((row) => taskRecordSchema.parse(JSON.parse(row.record))),
    ),
    metadata,
  };
}

export function planRead(tx: Transaction, request: PlanRead): PlanReadResult {
  const project = tx.getProject(tx.projectId);
  const requested = request.revision ?? project.plan_revision;
  for (const endpoint of [requested, request.compare_to]) {
    if (endpoint != null && endpoint > project.plan_revision) {
      throw new BoardError(
        "invalid",
        "Plan revision exceeds the current plan revision",
        {
          requested: endpoint,
          current: project.plan_revision,
        },
      );
    }
  }
  const { definitions, metadata } = revision(
    tx,
    requested,
    project.plan_revision,
  );
  const result = {
    project_id: tx.projectId,
    plan_revision: requested,
    ...(metadata === undefined ? {} : { metadata }),
  };
  if (request.compare_to == null) return { ...result, task_map: definitions };

  const before =
    request.compare_to === requested
      ? definitions
      : revision(tx, request.compare_to, project.plan_revision).definitions;
  const beforeEntries = new Map(Object.entries(before));
  const afterEntries = new Map(Object.entries(definitions));
  const added = new Map<string, TaskMap[string]>();
  const changed = new Map<
    string,
    { before: TaskMap[string]; after: TaskMap[string] }
  >();
  for (const [id, after] of Array.from(afterEntries).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const prior = beforeEntries.get(id);
    if (prior === undefined) added.set(id, after);
    else if (!isDeepStrictEqual(prior, after))
      changed.set(id, { before: prior, after });
  }
  return {
    ...result,
    compare_to: request.compare_to,
    added: Object.fromEntries(added),
    changed: Object.fromEntries(changed),
    removed: Array.from(beforeEntries.keys())
      .filter((id) => !afterEntries.has(id))
      .sort()
      .map((id) => taskIdSchema.parse(id)),
  };
}
