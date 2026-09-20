/**
 * Environment configuration — loaded and validated once at boot.
 * The app refuses to start with an invalid/missing configuration
 * (fail-fast instead of a broken runtime).
 */

function loadEnvFile(): void {
  // Node ≥ 20.6 loads .env natively; path resolved from CWD (project root).
  try {
    process.loadEnvFile(".env");
  } catch {
    /* .env is optional — real env vars may come from the platform */
  }
}
loadEnvFile();

function required(name: string, value: string | undefined, minLen = 1): string {
  if (!value || value.length < minLen) {
    console.error(`Invalid environment: ${name} is required${minLen > 1 ? ` (min ${minLen} chars)` : ""}`);
    process.exit(1);
  }
  return value;
}

function num(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    console.error(`Invalid environment: ${name} must be a number`);
    process.exit(1);
  }
  return parsed;
}

function bool(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1";
}

export const env = Object.freeze({
  PORT: num("PORT", process.env.PORT, 4000),
  HOST: process.env.HOST || "0.0.0.0",
  NODE_ENV: process.env.NODE_ENV || "development",
  DATABASE_URL: required("DATABASE_URL", process.env.DATABASE_URL),
  JWT_SECRET: required("JWT_SECRET", process.env.JWT_SECRET, 16),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "15m",
  REFRESH_TOKEN_TTL_DAYS: num("REFRESH_TOKEN_TTL_DAYS", process.env.REFRESH_TOKEN_TTL_DAYS, 30),
  CORS_ORIGINS: process.env.CORS_ORIGINS || "*",
  SWAGGER_ENABLED: bool("SWAGGER_ENABLED", process.env.SWAGGER_ENABLED, true),
});

export const isProd = env.NODE_ENV === "production";

/** "15m" | "7d" | "3600" → seconds (number, as @nestjs/jwt expects). */
export function jwtExpiresInSeconds(spec = env.JWT_EXPIRES_IN): number {
  const match = /^(\d+)\s*(s|m|h|d)?$/i.exec(spec.trim());
  if (!match) return 900; // safe default: 15 min
  const value = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const mult = unit === "m" ? 60 : unit === "h" ? 3600 : unit === "d" ? 86_400 : 1;
  return value * mult;
}
