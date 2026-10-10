export interface FlareApiErrorBody {
  error?: unknown;
  code?: unknown;
  hint?: unknown;
}

// Typed API failure: the server's stable `code` + `hint` ride on the
// Error so CLIs and agents can switch on the code and print the next
// step. The message keeps the legacy `<op> failed: <status>` prefix.
export class FlareApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly hint: string | null;

  constructor(op: string, status: number, body: FlareApiErrorBody) {
    const serverError = typeof body.error === "string" && body.error ? body.error : null;
    super(serverError ? `${op} failed: ${status} — ${serverError}` : `${op} failed: ${status}`);
    this.name = "FlareApiError";
    this.status = status;
    this.code = typeof body.code === "string" ? body.code : null;
    this.hint = typeof body.hint === "string" ? body.hint : null;
  }
}
