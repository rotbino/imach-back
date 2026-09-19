/** Typed application error — mapped to a clean HTTP response by the central handler. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errors = {
  unauthorized: (msg = "Authentication required") => new AppError(401, "UNAUTHORIZED", msg),
  forbidden: (msg = "You do not have access to this resource") => new AppError(403, "FORBIDDEN", msg),
  notFound: (what = "Resource") => new AppError(404, "NOT_FOUND", `${what} not found`),
  conflict: (msg: string, code = "CONFLICT") => new AppError(409, code, msg),
  badRequest: (msg: string, code = "BAD_REQUEST") => new AppError(400, code, msg),
} as const;
