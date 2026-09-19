import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// Node ≥21.7 loads .env natively — no dotenv dependency needed.
// Path is resolved relative to THIS module so the server is cwd-independent.
import { fileURLToPath } from "node:url";
import path from "node:path";

try {
  const here = path.dirname(fileURLToPath(import.meta.url)); // src/config
  process.loadEnvFile(path.resolve(here, "../../.env"));
} catch {
  /* .env is optional (real env vars may come from the platform) */
}

const EnvSchema = Type.Object({
  PORT: Type.Number({ default: 4000, minimum: 1, maximum: 65535 }),
  HOST: Type.String({ default: "0.0.0.0" }),
  NODE_ENV: Type.Union([Type.Literal("development"), Type.Literal("test"), Type.Literal("production")], {
    default: "development",
  }),
  DATABASE_URL: Type.String({ minLength: 1 }),
  JWT_SECRET: Type.String({ minLength: 16 }),
  JWT_EXPIRES_IN: Type.String({ default: "15m" }),
  REFRESH_TOKEN_TTL_DAYS: Type.Number({ default: 30, minimum: 1, maximum: 365 }),
  CORS_ORIGINS: Type.String({ default: "*" }),
  SWAGGER_ENABLED: Type.Boolean({ default: true }),
});

const source = {
  PORT: process.env.PORT ? Number(process.env.PORT) : undefined,
  HOST: process.env.HOST,
  NODE_ENV: process.env.NODE_ENV as "development" | "test" | "production" | undefined,
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN,
  REFRESH_TOKEN_TTL_DAYS: process.env.REFRESH_TOKEN_TTL_DAYS
    ? Number(process.env.REFRESH_TOKEN_TTL_DAYS)
    : undefined,
  CORS_ORIGINS: process.env.CORS_ORIGINS,
  SWAGGER_ENABLED: process.env.SWAGGER_ENABLED ? process.env.SWAGGER_ENABLED === "true" : undefined,
} as Record<string, unknown>;

// Apply schema defaults, then validate strictly.
const parsed = Value.Default(EnvSchema, source) as Record<string, unknown>;

if (!Value.Check(EnvSchema, parsed)) {
  const messages = [...Value.Errors(EnvSchema, parsed)].map((e) => `${e.path}: ${e.message}`);
  console.error("❌ Invalid environment configuration:\n" + messages.join("\n"));
  process.exit(1);
}

export const env: Static<typeof EnvSchema> = Object.freeze(parsed as Static<typeof EnvSchema>);
export const isProd = env.NODE_ENV === "production";
