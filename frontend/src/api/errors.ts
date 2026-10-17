export type ErrorDetail = { field: string; message: string };

/** Normalised API error (api.md §1 error envelope). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: ErrorDetail[] = [],
    public requestId: string | null = null,
  ) {
    super(message);
  }

  /** Field errors keyed by form field (`body.` prefix removed). */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const d of this.details) out[d.field.replace(/^body\./, "")] = d.message;
    return out;
  }
}

/** `parsed` is the body when the caller already consumed it (openapi-fetch reads error bodies itself). */
export async function toApiError(res: Response, parsed?: unknown): Promise<ApiError> {
  let body: unknown = parsed ?? null;
  if (body === null && !res.bodyUsed) {
    try {
      body = await res.json();
    } catch {
      /* non-JSON error (e.g. proxy) */
    }
  }
  const err = (body as { error?: { code?: string; message?: string; details?: ErrorDetail[]; request_id?: string } })
    ?.error;
  return new ApiError(
    res.status,
    err?.code ?? (res.status === 0 ? "NETWORK_ERROR" : "ERROR"),
    err?.message ?? `Request failed (${res.status})`,
    err?.details ?? [],
    err?.request_id ?? res.headers.get("X-Request-ID"),
  );
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "VALIDATION_ERROR" && e.details.length) return e.details.map((d) => d.message).join("; ");
    return e.message;
  }
  return e instanceof Error ? e.message : "Something went wrong";
}
