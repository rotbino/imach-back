import { PrismaClient } from "@prisma/client";
import { isProd } from "../config/env.js";

/**
 * Single Prisma Client instance for the whole process.
 * Connection pool is managed by the engine — sized by connection_limit
 * in the DATABASE_URL when scaling horizontally.
 */
export const prisma = new PrismaClient({
  log: isProd ? ["error"] : ["warn", "error"],
});

export type DB = PrismaClient;
