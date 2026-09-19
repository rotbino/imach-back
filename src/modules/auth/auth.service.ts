import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply } from "fastify";
import { env, isProd } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { errors } from "../../lib/errors.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import type { AuthUser } from "../../plugins/auth.js";

const REFRESH_COOKIE = "imach_rt";
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

export interface PublicUser {
  id: string;
  name: string;
  phone: string;
  role: string;
}

const toPublicUser = (u: { id: string; name: string; phone: string; role: string }): PublicUser => u;

async function withBusinesses(user: PublicUser) {
  const businesses = await prisma.business.findMany({
    where: { ownerId: user.id },
    select: { id: true, slug: true, name: true, role: true, city: true, isVerified: true },
    orderBy: { name: "asc" },
  });
  return businesses;
}

async function issueSession(reply: FastifyReply, user: AuthUser & { name?: string }) {
  const accessToken = reply.jwtSign(
    { id: user.id, phone: user.phone, role: user.role },
    { expiresIn: env.JWT_EXPIRES_IN }
  );

  const raw = randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  await prisma.refreshToken.create({
    data: { tokenHash: sha256(raw), userId: user.id, expiresAt },
  });

  reply.setCookie(REFRESH_COOKIE, raw, {
    path: "/api/v1/auth",
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400,
  });

  return accessToken;
}

export const authService = {
  async register(
    body: { name: string; phone: string; password: string },
    reply: FastifyReply
  ) {
    const exists = await prisma.user.findUnique({ where: { phone: body.phone }, select: { id: true } });
    if (exists) throw errors.conflict("این شماره موبایل قبلاً ثبت شده است", "PHONE_TAKEN");

    const user = await prisma.user.create({
      data: {
        name: body.name.trim(),
        phone: body.phone,
        passwordHash: await hashPassword(body.password),
      },
    });

    const publicUser: PublicUser = toPublicUser(user);
    const accessToken = await issueSession(reply, { id: user.id, phone: user.phone, role: user.role });
    return { accessToken, user: publicUser, businesses: await withBusinesses(publicUser) };
  },

  async login(body: { phone: string; password: string }, reply: FastifyReply) {
    const user = await prisma.user.findUnique({ where: { phone: body.phone } });
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      throw errors.unauthorized("شماره موبایل یا رمز عبور اشتباه است");
    }

    const publicUser = toPublicUser(user);
    const accessToken = await issueSession(reply, { id: user.id, phone: user.phone, role: user.role });
    return { accessToken, user: publicUser, businesses: await withBusinesses(publicUser) };
  },

  /** Rotate the refresh token: verify → revoke old row → issue a fresh pair. */
  async refresh(request: { cookies: Record<string, string | undefined> }, reply: FastifyReply) {
    const raw = request.cookies[REFRESH_COOKIE];
    if (!raw) throw errors.unauthorized("Refresh token missing");

    const row = await prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(raw) },
      include: { user: true },
    });
    if (!row || row.revokedAt || row.expiresAt < new Date()) {
      reply.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
      throw errors.unauthorized("Refresh token invalid or expired");
    }

    await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });

    const publicUser = toPublicUser(row.user);
    const accessToken = await issueSession(reply, {
      id: row.user.id,
      phone: row.user.phone,
      role: row.user.role,
    });
    return { accessToken, user: publicUser, businesses: await withBusinesses(publicUser) };
  },

  async logout(request: { cookies: Record<string, string | undefined>; user?: AuthUser }, reply: FastifyReply) {
    const raw = request.cookies[REFRESH_COOKIE];
    if (raw) {
      await prisma.refreshToken.updateMany({
        where: { tokenHash: sha256(raw), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    reply.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
    return { ok: true };
  },

  async me(user: AuthUser) {
    const row = await prisma.user.findUnique({ where: { id: user.id } });
    if (!row) throw errors.notFound("User");
    const publicUser = toPublicUser(row);
    return { user: publicUser, businesses: await withBusinesses(publicUser) };
  },
};
