import type { FastifyInstance } from "fastify";
import { RegisterBody, LoginBody, type RegisterBodyT, type LoginBodyT } from "./auth.schemas.js";
import { authService } from "./auth.service.js";

const AUTH_RATE = { max: 15, timeWindow: "1 minute" };

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/register",
    {
      config: { rateLimit: AUTH_RATE },
      schema: { body: RegisterBody },
    },
    async (request, reply) => {
      const out = await authService.register(request.body as RegisterBodyT, reply);
      return reply.code(201).send(out);
    }
  );

  app.post(
    "/login",
    {
      config: { rateLimit: AUTH_RATE },
      schema: { body: LoginBody },
    },
    async (request, reply) => {
      return authService.login(request.body as LoginBodyT, reply);
    }
  );

  app.post("/refresh", async (request, reply) => {
    return authService.refresh(request, reply);
  });

  app.post(
    "/logout",
    { preHandler: [app.requireAuth] },
    async (request, reply) => {
      return authService.logout(request, reply);
    }
  );

  app.get(
    "/me",
    { preHandler: [app.requireAuth] },
    async (request) => {
      return authService.me(request.user);
    }
  );
}
