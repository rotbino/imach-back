import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { FastifyRequest } from "fastify";
import type { AuthUser } from "../common/decorators/auth.decorators";

/**
 * Bearer-token guard — verifies the access JWT and attaches the
 * `AuthUser` claims to `request.user` for the controllers.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) {
      throw new UnauthorizedException({ error: "UNAUTHORIZED", message: "Invalid or expired access token" });
    }

    try {
      const payload = await this.jwt.verifyAsync<AuthUser>(token);
      request.user = { id: payload.id, phone: payload.phone, role: payload.role };
      return true;
    } catch {
      throw new UnauthorizedException({ error: "UNAUTHORIZED", message: "Invalid or expired access token" });
    }
  }
}
