import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isProd } from "../config/env";

/**
 * Central error mapping — every failure leaves the API in ONE shape:
 *
 *   { error: "STABLE_MACHINE_CODE", message: "human text", fields? }
 *
 * The web client matches on `error` (stable) and shows `message`.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    // Already-normalized HTTP exception (AppError, ThrottlerException, …)
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === "object" && body !== null && "error" in (body as Record<string, unknown>)) {
        const { error, ...rest } = body as { error: string } & Record<string, unknown>;

        // Normalize built-in exceptions to our stable machine codes
        const normalized: Record<string, string> = {
          "Bad Request": "VALIDATION_ERROR",
          Unauthorized: "UNAUTHORIZED",
          Forbidden: "FORBIDDEN",
          "Not Found": "NOT_FOUND",
          Conflict: "CONFLICT",
        };
        const code = normalized[error] ?? error;
        reply.code(status).send({ error: code, ...rest });
        return;
      }

      // ValidationPipe / built-in exceptions → normalize
      const validationFields =
        typeof body === "object" && body !== null && "message" in (body as Record<string, unknown>)
          ? (body as { message?: unknown }).message
          : undefined;

      if (status === HttpStatus.TOO_MANY_REQUESTS) {
        reply.code(status).send({
          error: "RATE_LIMITED",
          message: "درخواست‌های شما زیاد است، کمی بعد تلاش کنید",
        });
        return;
      }

      reply.code(status).send({
        error: status === HttpStatus.BAD_REQUEST ? "VALIDATION_ERROR" : "HTTP_ERROR",
        message:
          status === HttpStatus.BAD_REQUEST
            ? "اطلاعات ارسالی معتبر نیست"
            : exception.message,
        ...(Array.isArray(validationFields) ? { fields: validationFields } : {}),
      });
      return;
    }

    this.logger.error({ err: exception, url: request.url }, "unhandled error");
    reply.code(500).send({
      error: "INTERNAL_ERROR",
      message: isProd ? "خطای داخلی سرور" : String(exception instanceof Error ? exception.message : exception),
    });
  }
}
