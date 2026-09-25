import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env, isProd, jwtExpiresInSeconds } from "../common/config/env";
import { currencyOfCountry, dialOfCountry, isSupportedCountry } from "../common/catalog/catalog";
import type { AuthUser } from "../common/decorators/auth.decorators";
import { AppError } from "../common/errors/app-error";
import { t, type Locale } from "../common/i18n/i18n";
import { PrismaService } from "../common/prisma/prisma.module";
import { PushService } from "../notifications/push.service";
import { ensurePage } from "../common/pages";

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
  trade: true,
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
  /** پسورد واقعی تنظیم شده؟ ثبت‌نام سریع این را false می‌گذارد. */
  passwordSet: boolean;
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
  passwordSet: boolean;
}): PublicUser => ({
  id: u.id,
  name: u.name,
  firstName: u.firstName,
  lastName: u.lastName,
  phone: u.phone,
  role: u.role,
  country: u.country,
  language: u.language,
  passwordSet: u.passwordSet,
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
        passwordSet: true,
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

  /**
   * Quick register — only mobile, no password, no name.
   *
   * Use cases (خواسته‌ی کاربر: «ثبت‌نام را راحت کنم»):
   *   ۱) کاربر تازه: User با passwordSet=false و Business خودکار با نام
   *      «کاتالوگ شما» ساخته می‌شود و سشن صادر می‌گردد.
   *   ۲) کاربر قبلاً ثبت‌نام سریع کرده (passwordSet=false): سشن صادر می‌شود
   *      تا دوباره وارد شود (بدون نیاز به پسورد).
   *   ۳) کاربر قبلاً با پسورد ثبت‌نام کرده (passwordSet=true): این endpoint
   *      رد می‌کند تا nobody hijack نکند — باید loginUser استفاده کند.
   */
  async quickRegisterUser(
    body: { phone: string; country?: string; ref?: string },
    reply: FastifyReply,
    locale: Locale
  ) {
    const country = body.country && isSupportedCountry(body.country) ? body.country : "IR";
    const phone = normalizeIntlPhone(body.phone, country);
    if (!phone) {
      throw AppError.badRequest(
        t(locale, "auth.invalidPhone", "شماره موبایل معتبر نیست"),
        "INVALID_PHONE"
      );
    }

    const existing = await this.prisma.user.findUnique({
      where: { phone },
      select: { id: true, passwordSet: true, role: true, country: true, language: true, name: true, firstName: true, lastName: true },
    });
    if (existing) {
      // اگر پسورد دارد → نمی‌توانیم «ثبت‌نام سریع» بکنیم، باید loginUser
      if (existing.passwordSet) {
        throw AppError.conflict(
          t(locale, "auth.phoneTakenWithPassword", "این شماره قبلاً با رمز عبور ثبت شده — وارد شو"),
          "PHONE_HAS_PASSWORD"
        );
      }
      // ثبت‌نام سریعِ قبلی — سشن بده
      const publicUser = toPublicUser({
        id: existing.id,
        name: existing.name,
        firstName: existing.firstName,
        lastName: existing.lastName,
        phone,
        role: existing.role,
        country: existing.country,
        language: existing.language,
        passwordSet: false,
      });
      const accessToken = await this.issueSession(reply, {
        id: existing.id,
        phone,
        role: existing.role as AuthUser["role"],
      });
      return { accessToken, user: publicUser, businesses: await this.withBusinesses(publicUser) };
    }

    // ساخت کاربر جدید با passwordSet=false — placeholder name و placeholder password
    // (هش رندم ۴۸ بایتی: هرگز قابل guess نیست، ولی کاربر نمی‌تواند با آن وارد شود
    // چون نمی‌داندش — فقط سشن مرورگرش را دارد)
    const placeholderName = `کاربر ${phone.slice(-4)}`;
    const randomPassword = randomBytes(48).toString("base64url");
    const bcrypt = await import("bcryptjs");
    const user = await this.prisma.user.create({
      data: {
        name: placeholderName,
        phone,
        passwordHash: await bcrypt.hash(randomPassword, 10),
        passwordSet: false,
        country,
        language: "fa",
      },
    });

    // ساخت Business خودکار با نام پیش‌فرض «کاتالوگ شما» — slug یکتا با phone suffix
    const slugBase = `biz-${phone.slice(-6)}`;
    let slug = slugBase;
    for (let i = 0; i < 5; i++) {
      const clash = await this.prisma.business.findUnique({ where: { slug }, select: { id: true } });
      if (!clash) break;
      slug = `${slugBase}-${randomBytes(2).toString("hex")}`;
    }
    const business = await this.prisma.business.create({
      data: {
        slug,
        name: "کاتالوگ شما",
        city: "—", // شهر هنوز مشخص نیست — کاربر از مدال «انتخاب شهر» پر می‌کند
        province: null,
        country,
        currency: currencyOfCountry(country),
        phone: user.phone,
        ownerId: user.id,
        pages: { create: [{ type: "SELL" }, { type: "BUY" }] },
      },
      include: { pages: { select: { id: true, type: true } } },
    });
    const mySellPageId = business.pages.find((p) => p.type === "SELL")?.id;
    const myBuyPageId = business.pages.find((p) => p.type === "BUY")?.id;

    // ── Referral attribution — همان منطق registerUser (هر دو ورودی ?ref= قبول می‌کنند)
    let refArm: "SELL" | "BUY" = "SELL";
    let refSlug = body.ref?.trim() ?? "";
    if (refSlug.startsWith("buy:")) {
      refArm = "BUY";
      refSlug = refSlug.slice(4).trim();
    }
    if (refSlug) {
      const refBiz = await this.prisma.business.findUnique({
        where: { slug: refSlug },
        select: { id: true, ownerId: true },
      });
      if (refBiz?.ownerId && refBiz.ownerId !== user.id) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { referredById: refBiz.ownerId, refArm },
        });
        // auto-follow همان‌طور که در createBusiness انجام می‌شد
        try {
          if (refArm === "BUY") {
            const refBuyPageId = await ensurePage(this.prisma, refBiz.id, "BUY");
            const sellId = mySellPageId ?? (await ensurePage(this.prisma, business.id, "SELL"));
            await this.prisma.follow.upsert({
              where: { followerPageId_supplierPageId: { followerPageId: refBuyPageId, supplierPageId: sellId } },
              create: { followerPageId: refBuyPageId, supplierPageId: sellId, viaRef: true },
              update: {},
            });
          } else {
            const buyId = myBuyPageId ?? (await ensurePage(this.prisma, business.id, "BUY"));
            const refSellPageId = await ensurePage(this.prisma, refBiz.id, "SELL");
            await this.prisma.follow.upsert({
              where: { followerPageId_supplierPageId: { followerPageId: buyId, supplierPageId: refSellPageId } },
              create: { followerPageId: buyId, supplierPageId: refSellPageId, viaRef: true },
              update: {},
            });
          }
        } catch {
          /* best-effort */
        }
      }
    }

    // ── حلقه‌ی گیت مخاطبین — ثبت‌نام سریع هم همین通知 را روشن می‌کند
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
            actorName: placeholderName || c.name,
          })),
        });
      }
    } catch {
      /* best-effort */
    }

    const publicUser = toPublicUser({
      id: user.id,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      role: user.role,
      country: user.country,
      language: user.language,
      passwordSet: false,
    });
    const accessToken = await this.issueSession(reply, {
      id: user.id,
      phone: user.phone,
      role: user.role as AuthUser["role"],
    });
    return { accessToken, user: publicUser, businesses: await this.withBusinesses(publicUser) };
  }

  /**
   * Set password — برای کاربرانی که ثبت‌نام سریع کرده‌اند (passwordSet=false)
   * یا می‌خواهند پسوردشان را عوض کنند.
   *
   * اگر passwordSet=true باشد (کاربر قبلاً پسورد دارد)، currentPassword را
   * بررسی می‌کنیم. اگر passwordSet=false باشد (ثبت‌نام سریع)، currentPassword
   * را نادیده می‌گیریم و فقط newPassword را ست می‌کنیم.
   */
  async setPassword(user: AuthUser, body: { currentPassword?: string; newPassword: string }, locale: Locale) {
    const row = await this.prisma.user.findUnique({ where: { id: user.id }, select: { id: true, passwordHash: true, passwordSet: true } });
    if (!row) throw AppError.notFound("User not found");

    const bcrypt = await import("bcryptjs");

    if (row.passwordSet) {
      // کاربر قبلاً پسورد دارد — currentPassword باید درست باشد
      if (!body.currentPassword) {
        throw AppError.badRequest(
          t(locale, "auth.currentPasswordRequired", "رمز عبور فعلی را وارد کنید"),
          "CURRENT_PASSWORD_REQUIRED"
        );
      }
      const ok = await bcrypt.compare(body.currentPassword, row.passwordHash);
      if (!ok) {
        throw AppError.unauthorized(
          t(locale, "auth.invalidCredentials", "رمز عبور فعلی اشتباه است")
        );
      }
    }

    await this.prisma.user.update({
      where: { id: row.id },
      data: {
        passwordHash: await bcrypt.hash(body.newPassword, 10),
        passwordSet: true,
      },
    });
    return { ok: true };
  }

  /**
   * Change phone — برای کاربری که موقع ثبت‌نام سریع شماره‌اش را اشتباه زده.
   * شماره جدید را می‌گیرد و اگر آزاد بود، عوض می‌کند.
   */
  async changePhone(user: AuthUser, body: { phone: string; country?: string }, locale: Locale) {
    const country = body.country && isSupportedCountry(body.country) ? body.country : "IR";
    const phone = normalizeIntlPhone(body.phone, country);
    if (!phone) {
      throw AppError.badRequest(
        t(locale, "auth.invalidPhone", "شماره موبایل معتبر نیست"),
        "INVALID_PHONE"
      );
    }
    const taken = await this.prisma.user.findUnique({ where: { phone }, select: { id: true } });
    if (taken && taken.id !== user.id) {
      throw AppError.conflict(
        t(locale, "auth.phoneTaken", "این شماره قبلاً ثبت شده است"),
        "PHONE_TAKEN"
      );
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { phone } });
    // phone روی Business هم آپدیت می‌شود (هر Business یک phone دارد که از signup آمده)
    await this.prisma.business.updateMany({ where: { ownerId: user.id }, data: { phone } });
    return { ok: true, phone };
  }
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
    // عکس پروفایل — از جدول فایل‌ها با اسلات «avatar» (آخرین رکورد)
    const avatar = await this.prisma.file.findFirst({
      where: { relatedModel: "User", relatedId: user.id, fieldKey: "avatar" },
      orderBy: { createdAt: "desc" },
      select: { url: true, thumbUrl: true },
    });
    return {
      user: publicUser,
      businesses: await this.withBusinesses(publicUser),
      avatar: avatar ? { url: avatar.url, thumbUrl: avatar.thumbUrl } : null,
    };
  }

  /**
   * Edit profile — نام و نام خانوادگی مالک کسب‌وکار را به‌روزرسانی می‌کند.
   * این فیلدها در ویترین کاتالوگ زیر عنوان نشان داده می‌شوند.
   */
  async editProfile(
    user: AuthUser,
    body: { firstName?: string; lastName?: string },
    locale: Locale
  ) {
    const row = await this.prisma.user.findUnique({ where: { id: user.id }, select: { id: true, firstName: true, lastName: true } });
    if (!row) throw AppError.notFound("User not found");

    const firstName = (body.firstName ?? "").trim();
    const lastName = (body.lastName ?? "").trim();
    if (firstName.length < 2 || lastName.length < 2) {
      throw AppError.badRequest(
        t(locale, "auth.nameRequired", "نام و نام خانوادگی را کامل بنویسید"),
        "NAME_REQUIRED"
      );
    }
    const fullName = `${firstName} ${lastName}`.trim();
    const updated = await this.prisma.user.update({
      where: { id: row.id },
      data: { firstName, lastName, name: fullName },
    });
    const publicUser = toPublicUser(updated);
    return { user: publicUser };
  }
}
