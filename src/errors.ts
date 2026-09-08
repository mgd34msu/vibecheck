export type BoardErrorCode = "invalid" | "conflict" | "forbidden" | "not_found";

export interface ValidationIssue {
  field: (string | number)[];
  message: string;
  type: string;
}

export type BoardErrorDetails =
  | ValidationIssue[]
  | { id: string; expected: number | null; actual: number }
  | { task_id: string }
  | { task_ids: string[] }
  | { plan_revision: number }
  | { requested: number; current: number };

export interface BoardErrorResponse {
  code: BoardErrorCode;
  message: string;
  details?: BoardErrorDetails;
}

export class BoardError extends Error {
  readonly code: BoardErrorCode;
  readonly details: BoardErrorDetails | undefined;

  constructor(
    code: BoardErrorCode,
    message: string,
    details?: BoardErrorDetails,
  ) {
    super(message);
    this.name = "BoardError";
    this.code = code;
    this.details = details;
  }

  asDict(): BoardErrorResponse {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }

  toJSON(): BoardErrorResponse {
    return this.asDict();
  }
}
