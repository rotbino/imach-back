import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env, isProd, jwtExpiresInSeconds } from "../common/config/env";
import { isSupportedCountry } from "../common/catalog/catalog";
import type { AuthUser } from "../common/decorators/auth.decorators";
import { AppError } from "../common/errors/app-error";
import { t, type Locale } from "../common/i18n/i18n";
import { PrismaService } from "../common/prisma/prisma.module";

const REFRESH_COOKIE = "imach_rt";
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/** Normalize any dialled format to the canonical 09xxxxxxxxx. */
export function normalizePhone(raw: string): string {
  let p = raw.replace(/[\s\-()]/g, "").replace(/^\+/, "");
  if (p.startsWith("0098")) p = `0${p.slice(4)}`;
  else if (p.startsWith("98") && p.length === 12) p = `0${p.slice(2)}`;
  else if (p.length === 10 && p.startsWith("9")) p = `0${p}`;
  return p;
}

const isCanonicalPhone = (p: string): boolean => /^09\d{9}$/.test(p);

const BUSINESS_SUMMARY_SELECT = {
  id: true,
  slug: true,
  name: true,
  activityType: true,
  city: true,
  country: true,
  currency: true,
  isVerified: true,
} as const;

export interface PublicUser {
  id: string;
  name: string;
  phone: string;
  role: string;
  country: string;
}

const toPublicUser = (u: {
  id: string;
  name: string;
  phone: string;
  role: string;
  country: string;
}): PublicUser => u;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService
  ) {}

  private async withBusinesses(user: PublicUser) {
    return this.prisma.business.findMany({
      where: { ownerId: user.id },
      select: BUSINESS_SUMMARY_SELECT,
      orderBy: { name: "asc" },
    });
  }

  /** Issues a fresh access JWT + rotating refresh-token cookie pair. */
  private async issueSession(reply: FastifyReply, user: AuthUser): Promise<string> {
    const accessToken = await this.jwt.signAsync(
      { id: user.id, phone: user.phone, role: user.role },
      { expiresIn: jwtExpiresInSeconds() }
    );

    const raw = randomBytes(48).toString("base64url");
    const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    await this.prisma.refreshToken.create({
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

  async registerUser(
    body: { name: string; phone: string; password: string; country?: string; ref?: string },
    reply: FastifyReply,
    locale: Locale
  ) {
    const phone = normalizePhone(body.phone);
    if (!isCanonicalPhone(phone)) {
      throw AppError.badRequest(
        t(locale, "auth.invalidPhone", "شماره موبایل معتبر نیست"),
        "INVALID_PHONE"
      );
    }
    const exists = await this.prisma.user.findUnique({ where: { phone }, select: { id: true } });
    if (exists) {
      throw AppError.conflict(t(locale, "auth.phoneTaken", "این شماره موبایل قبلاً ثبت شده است"), "PHONE_TAKEN");
    }

    // signup country drives the default catalog currency of future businesses
    const country = body.country && isSupportedCountry(body.country) ? body.country : "IR";

    const bcrypt = await import("bcryptjs");
    const user = await this.prisma.user.create({
      data: {
        name: body.name.trim(),
        phone,
        passwordHash: await bcrypt.hash(body.password, 10),
        country,
      },
    });

    // ── Referral attribution ────────────────────────────────────────────────
    // ?ref={businessSlug}        → invite via the referrer's CATALOG (SELL
    //                              page): the referred becomes their CUSTOMER.
    // ?ref=buy:{businessSlug}    → invite via the referrer's PURCHASE DESK
    //                              (BUY page): the referred becomes their
    //                              SUPPLIER.
    // The auto-follow itself fires later, in createBusiness, when the
    // referred user actually owns pages. Invalid / unknown codes are ignored
    // silently — signup must never break.
    let refArm: "SELL" | "BUY" = "SELL";
    let refSlug = body.ref?.trim() ?? "";
    if (refSlug.startsWith("buy:")) {
      refArm = "BUY";
      refSlug = refSlug.slice(4).trim();
    }
    if (refSlug) {
      const refBiz = await this.prisma.business.findUnique({
        where: { slug: refSlug },
        select: { ownerId: true },
      });
      if (refBiz?.ownerId && refBiz.ownerId !== user.id) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { referredById: refBiz.ownerId, refArm },
        });
      }
    }

    const publicUser = toPublicUser(user);
    const accessToken = await this.issueSession(reply, {
      id: user.id,
      phone: user.phone,
      role: user.role as AuthUser["role"],
    });
    return { accessToken, user: publicUser, businesses: await this.withBusinesses(publicUser) };
  }

  async loginUser(body: { phone: string; password: string }, reply: FastifyReply, locale: Locale) {
    const phone = normalizePhone(body.phone);
    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) {
      throw AppError.unauthorized(t(locale, "auth.invalidCredentials", "شماره موبایل یا رمز عبور اشتباه است"));
    }

    const bcrypt = await import("bcryptjs");
    const ok = await bcrypt.compare(body.password, user.passwordHash);
    if (!ok) {
      throw AppError.unauthorized(t(locale, "auth.invalidCredentials", "شماره موبایل یا رمز عبور اشتباه است"));
    }

    const publicUser = toPublicUser(user);
    const accessToken = await this.issueSession(reply, {
      id: user.id,
      phone: user.phone,
      role: user.role as AuthUser["role"],
    });
    return { accessToken, user: publicUser, businesses: await this.withBusinesses(publicUser) };
  }

  /** Rotate the refresh token: verify → revoke old row → issue a fresh pair. */
  async refreshSession(request: FastifyRequest, reply: FastifyReply) {
    const raw = (request.cookies as Record<string, string | undefined>)[REFRESH_COOKIE];
    if (!raw) throw AppError.unauthorized("Refresh token missing");

    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(raw) },
      include: { user: true },
    });
    if (!row || row.revokedAt || row.expiresAt < new Date()) {
      reply.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
      throw AppError.unauthorized("Refresh token invalid or expired");
    }

    await this.prisma.refreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });

    const publicUser = toPublicUser(row.user);
    const accessToken = await this.issueSession(reply, {
      id: row.user.id,
      phone: row.user.phone,
      role: row.user.role as AuthUser["role"],
    });
    return { accessToken, user: publicUser, businesses: await this.withBusinesses(publicUser) };
  }

  async logoutUser(request: FastifyRequest, reply: FastifyReply) {
    const raw = (request.cookies as Record<string, string | undefined>)[REFRESH_COOKIE];
    if (raw) {
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash: sha256(raw), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    reply.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
    return { ok: true };
  }

  async getMe(user: AuthUser) {
    const row = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!row) throw AppError.notFound("User not found");
    const publicUser = toPublicUser(row);
    return { user: publicUser, businesses: await this.withBusinesses(publicUser) };
  }
}
