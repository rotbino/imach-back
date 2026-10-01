import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * Typed application error carrying a stable machine `code`
 * (language-independent) plus a human message (already localized by t()).
 * The central exception filter maps it to `{ error, message }`.
 */
export class AppError extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    public readonly fields?: unknown
  ) {
    super({ error: code, message, ...(fields ? { fields } : {}) }, status);
  }

  static unauthorized(msg: string): AppError {
    return new AppError("UNAUTHORIZED", msg, HttpStatus.UNAUTHORIZED);
  }
  static forbidden(msg: string): AppError {
    return new AppError("FORBIDDEN", msg, HttpStatus.FORBIDDEN);
  }
  static notFound(msg = "Resource not found"): AppError {
    return new AppError("NOT_FOUND", msg, HttpStatus.NOT_FOUND);
  }
  static conflict(msg: string, code = "CONFLICT"): AppError {
    return new AppError(code, msg, HttpStatus.CONFLICT);
  }
  static badRequest(msg: string, code = "BAD_REQUEST"): AppError {
    return new AppError(code, msg, HttpStatus.BAD_REQUEST);
  }
}
