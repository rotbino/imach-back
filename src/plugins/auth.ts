import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { errors } from "../lib/errors.js";

/** Minimal JWT claims embedded in every access token. */
export interface AuthUser {
  id: string;
  phone: string;
  role: "MEMBER" | "ADMIN";
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    /** preHandler guard: verifies the Bearer token and populates request.user */
    requireAuth: (request: FastifyRequest) => Promise<void>;
  }
}

const AUTH_PLUGIN_NAME = "auth";

async function authDecorator(app: FastifyInstance): Promise<void> {
  app.decorate("requireAuth", async (request: FastifyRequest) => {
    try {
      await request.jwtVerify();
    } catch {
      throw errors.unauthorized("Invalid or expired access token");
    }
  });
}

/**
 * fastify-plugin keeps the decorator on the parent scope so route modules
 * registered afterwards can use `app.requireAuth` and typed request.user.
 */
export const authPlugin = fp(authDecorator, { name: AUTH_PLUGIN_NAME });
