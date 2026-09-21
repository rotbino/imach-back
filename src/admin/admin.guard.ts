import { CanActivate, ExecutionContext, HttpStatus } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AppError } from "../common/errors/app-error";
import { t, type Locale } from "../common/i18n/i18n";

/**
 * Route guard for the whole admin surface. Runs AFTER JwtAuthGuard, so the
 * request already carries the AuthUser claims — a single role check is all
 * the authorization the panel needs: every user with role=ADMIN passes,
 * everyone else gets a 403. Keeping the guard inside src/admin (not common)
 * is deliberate: when the admin codebase splits into its own service, the
 * guard travels with the folder.
 */
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: { role?: string }; locale?: Locale }>();
    if (req.user?.role === "ADMIN") return true;
    const locale = (req.locale ?? "fa") as Locale;
    throw AppError.forbidden(t(locale, "admin.forbidden", "دسترسی مدیریتی لازم است"));
  }
}
