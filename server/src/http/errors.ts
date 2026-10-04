// Typed HTTP errors. Thrown anywhere in a route; app.ts turns them into the
// envelope {error:{code,message,details,requestId}} with the given status.

export class HttpError extends Error {
  status: number;
  code: string;
  details: unknown;

  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const make = (status: number) => (code: string, message: string, details?: unknown) =>
  new HttpError(status, code, message, details);

export const badRequest = make(400);
export const notFound = make(404);
/** Gate violations (approval, run lock, error budget, …). */
export const conflict = make(409);
/** Validation failures. */
export const unprocessable = make(422);
/** Agent-run caps. */
export const tooManyRequests = make(429);
