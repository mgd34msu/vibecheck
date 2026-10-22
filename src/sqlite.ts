export type SqlValue = string | number | bigint | null | Uint8Array;

export interface SqlConnection {
  exec(sql: string): void;
  all(sql: string, values: SqlValue[]): unknown[];
  run(sql: string, values: SqlValue[]): void;
  close(): void;
}

export async function openSqlite(path: string): Promise<SqlConnection> {
  if (process.versions.bun !== undefined) {
    const { Database } = await import("bun:sqlite");
    const database = new Database(path, { create: true, strict: true });
    return {
      exec: (sql) => database.exec(sql),
      all(sql, values) {
        const statement = database.prepare<unknown, SqlValue[]>(sql);
        try {
          return statement.all(...values);
        } finally {
          statement.finalize();
        }
      },
      run(sql, values) {
        const statement = database.prepare<unknown, SqlValue[]>(sql);
        try {
          statement.run(...values);
        } finally {
          statement.finalize();
        }
      },
      close: () => database.close(),
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(path);
  return {
    exec: (sql) => database.exec(sql),
    all: (sql, values) => database.prepare(sql).all(...values),
    run(sql, values) {
      database.prepare(sql).run(...values);
    },
    close: () => database.close(),
  };
}

export function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code =
    "errcode" in error
      ? error.errcode
      : "errno" in error
        ? error.errno
        : undefined;
  return typeof code === "number" && ((code & 255) === 5 || (code & 255) === 6);
}
