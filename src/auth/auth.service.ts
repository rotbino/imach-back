import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env, isProd, jwtExpiresInSeconds } from "../common/config/env";
import { dialOfCountry, isSupportedCountry } from "../common/catalog/catalog";
import type { AuthUser } from "../common/decorators/auth.decorators";
import { AppError } from "../common/errors/app-error";
import { t, type Locale } from "../common/i18n/i18n";
import { PrismaService } from "../common/prisma/prisma.module";
import { PushService } from "../notifications/push.service";

const REFRESH_COOKIE = "imach_rt";
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/**
 * Normalize any dialled format to the canonical INTERNATIONAL mobile identity:
 * dial code + national number, WITHOUT the leading trunk 0 — e.g. Iran
 * 0912…, 912…, +98912…, 0098912… all become 98912….
 * The dial comes from the country the user picked in the form (VPN users may
 * override the guessed country), so the identity is unique world-wide.
 * Returns null when the number cannot be rescued.
 */
export function normalizeIntlPhone(raw: string, country: string): string | null {
  const dial = dialOfCountry(country);
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2); // international prefix
  if (d.startsWith(dial)) d = d.slice(dial.length); // user pasted the full international number
  while (d.startsWith("0")) d = d.slice(1); // national trunk prefix — never stored
  const valid = country === "IR" ? /^9\d{9}$/.test(d) : /^\d{7,12}$/.test(d);
  if (!valid) return null;
  return dial + d;
}

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
  firstName: string | null;
  lastName: string | null;
  phone: string;
  role: string;
  country: string;
  language: string;
}

// Explicit projection — the raw Prisma row (passwordHash, referral fields, …)
// must never ride on the response.
const toPublicUser = (u: {
  id: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  phone: string;
  role: string;
  country: string;
  language: string;
}): PublicUser => ({
  id: u.id,
  name: u.name,
  firstName: u.firstName,
  lastName: u.lastName,
  phone: u.phone,
  role: u.role,
  country: u.country,
  language: u.language,
});

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly pushService: PushService
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

  /**
   * Step-1 «ادامه» of the signup — the ONE async check a client cannot do
   * alone: is this mobile already registered? Public (pre-auth) by design;
   * throttled like the rest of the controller and reveals only a boolean.
   */
  async checkPhone(body: { phone: string; country?: string }, locale: Locale) {
    const country = body.country && isSupportedCountry(body.country) ? body.country : "IR";
    const phone = normalizeIntlPhone(body.phone, country);
    if (!phone) {
      throw AppError.badRequest(
        t(locale, "auth.invalidPhone", "شماره موبایل معتبر نیست"),
        "INVALID_PHONE"
      );
    }
    const exists = await this.prisma.user.findUnique({ where: { phone }, select: { id: true } });
    return { available: !exists };
  }

  async registerUser(
    body: {
      firstName?: string;
      lastName?: string;
      name?: string;
      phone: string;
      password: string;
      country?: string;
      language?: string;
      ref?: string;
    },
    reply: FastifyReply,
    locale: Locale
  ) {
    // signup country drives the default catalog currency AND the phone dial code
    const country = body.country && isSupportedCountry(body.country) ? body.country : "IR";
    const phone = normalizeIntlPhone(body.phone, country);
    if (!phone) {
      throw AppError.badRequest(
        t(locale, "auth.invalidPhone", "شماره موبایل معتبر نیست"),
        "INVALID_PHONE"
      );
    }
    const exists = await this.prisma.user.findUnique({ where: { phone }, select: { id: true } });
    if (exists) {
      throw AppError.conflict(t(locale, "auth.phoneTaken", "این شماره موبایل قبلاً ثبت شده است"), "PHONE_TAKEN");
    }
    // ── Person identity — firstName/lastName are canonical; the legacy combined
    // `name` is still accepted once more and split on the first space so an old
    // client bundle during a deploy window never breaks signup. Both parts are
    // REQUIRED: wholesale is face-to-face trade, the person name is trust.
    const legacyParts = (body.name ?? "").trim().split(/\s+/).filter(Boolean);
    const firstName = (body.firstName ?? legacyParts[0] ?? "").trim();
    const lastName = (body.lastName ?? legacyParts.slice(1).join(" ")).trim();
    if (firstName.length < 2 || lastName.length < 2) {
      throw AppError.badRequest(
        t(locale, "auth.nameRequired", "نام و نام خانوادگی را کامل بنویسید"),
        "NAME_REQUIRED"
      );
    }
    const fullName = `${firstName} ${lastName}`.trim();
    // user language is stored for future multilingual sessions (per-country default: fa)
    const language = (body.language ?? "").trim().toLowerCase().slice(0, 8) || "fa";

    const bcrypt = await import("bcryptjs");
    const user = await this.prisma.user.create({
      data: {
        firstName,
        lastName,
        name: fullName,
        phone,
        passwordHash: await bcrypt.hash(body.password, 10),
        country,
        language,
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

    // ── حلقه‌ی گیت مخاطبین بسته می‌شود: هر کسی که این شماره را در دفترچه‌اش
    // سپرده بود، همین حالا می‌فهمد صاحبش عضو iMach شد — بازگشت به اپ بدون
    // هیچ پیامکی. مستقیم با prisma (نه NotificationsService) تا چرخه‌ی
    // ماژولی درست نشود؛ اعلان best-effort است و ثبت‌نام هرگز نمی‌شکند.
    try {
      const contactOwners = await this.prisma.contact.findMany({
        where: { phone, userId: { not: user.id } },
        select: { userId: true, name: true },
      });
      if (contactOwners.length > 0) {
        await this.prisma.notification.createMany({
          data: contactOwners.map((c) => ({
            userId: c.userId,
            type: "CONTACT_JOINED",
            actorId: user.id,
            actorName: fullName || c.name,
          })),
        });
        // پوشِ همان اعلان — بهترین‌تلاش؛ ثبت‌نام هرگز نمی‌شکند
        const actorName = fullName || contactOwners[0].name;
        await Promise.allSettled(
          contactOwners.map((c) =>
            this.pushService
              .sendToUser(c.userId, {
                title: "iMach",
                body: `${actorName} عضو iMach شد`,
                url: "/market",
              })
              .catch(() => {})
          )
        );
      }
    } catch {
      /* notification is best-effort — signup must never break */
    }

    const accessToken = await this.issueSession(reply, {
      id: user.id,
      phone: user.phone,
      role: user.role as AuthUser["role"],
    });
    return { accessToken, user: publicUser, businesses: await this.withBusinesses(publicUser) };
  }

  async loginUser(
    body: { phone: string; password: string; country?: string },
    reply: FastifyReply,
    locale: Locale
  ) {
    const country = body.country && isSupportedCountry(body.country) ? body.country : "IR";
    const phone = normalizeIntlPhone(body.phone, country);
    if (!phone) {
      throw AppError.unauthorized(t(locale, "auth.invalidCredentials", "شماره موبایل یا رمز عبور اشتباه است"));
    }
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
