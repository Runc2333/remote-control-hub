export const CANDIDATE_QUERY_PARAMETER = "rch-update-candidate";
export const UPDATE_FAILURE_STORAGE_KEY = "rch-update-failure";

export type UpdateFailureDetail = {
  code: string;
  column?: number;
  line?: number;
  message: string;
  name: string;
  occurredAt: string;
  phase: string;
  releaseId?: string;
  resourceUrl?: string;
  stack?: string;
  source?: string;
  userAgent?: string;
  url?: string;
  version?: string;
  workerVersion?: string;
};

type UpdateFailureContext = {
  code: string;
  phase: string;
  releaseId?: string;
  resourceUrl?: string;
  userAgent?: string;
  version?: string;
  workerVersion?: string;
};

export const createUpdateFailure = (
  error: unknown,
  context: UpdateFailureContext,
): UpdateFailureDetail => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : context.code;
  return {
    ...context,
    message,
    name: error instanceof Error ? error.name : typeof error,
    occurredAt: new Date().toISOString(),
    ...(error instanceof Error && error.stack !== undefined
      ? { stack: error.stack }
      : {}),
  };
};

export const parseUpdateFailure = (value: unknown): UpdateFailureDetail => {
  const detail =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const optionalString = (key: string): string | undefined =>
    typeof detail[key] === "string" ? detail[key] : undefined;
  const optionalNumber = (key: string): number | undefined =>
    typeof detail[key] === "number" && Number.isFinite(detail[key])
      ? detail[key]
      : undefined;
  const code = optionalString("code") ?? "update_failed";
  const column = optionalNumber("column");
  const line = optionalNumber("line");
  const releaseId = optionalString("releaseId");
  const resourceUrl = optionalString("resourceUrl");
  const source = optionalString("source");
  const stack = optionalString("stack");
  const url = optionalString("url");
  const userAgent = optionalString("userAgent");
  const version = optionalString("version");
  const workerVersion = optionalString("workerVersion");
  return {
    code,
    ...(column === undefined ? {} : { column }),
    ...(line === undefined ? {} : { line }),
    message: optionalString("message") ?? code,
    name: optionalString("name") ?? "Error",
    occurredAt: optionalString("occurredAt") ?? new Date().toISOString(),
    phase: optionalString("phase") ?? "unknown",
    ...(releaseId === undefined ? {} : { releaseId }),
    ...(resourceUrl === undefined ? {} : { resourceUrl }),
    ...(stack === undefined ? {} : { stack }),
    ...(source === undefined ? {} : { source }),
    ...(userAgent === undefined ? {} : { userAgent }),
    ...(url === undefined ? {} : { url }),
    ...(version === undefined ? {} : { version }),
    ...(workerVersion === undefined ? {} : { workerVersion }),
  };
};
