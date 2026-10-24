import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.module";
import { AppError } from "../common/errors/app-error";
import { assertBusinessOwner } from "../common/guards";
import type { AuthUser } from "../common/decorators/auth.decorators";
import type { Locale } from "../common/i18n/i18n";
import { NotificationsService } from "../notifications/notifications.service";

/**
 * M10 (N2/S3 · سند ۰۳ §۴.۱) — نظرات و امتیاز کاتالوک.
 *
 * · هر خریدار به‌ازای هر کاتالوگ یک نظر — upsert سرویس‌سوی روی
 *   (authorUserId × businessId)؛ نویسنده = شخص، هویت نمایش = کسب‌وکار فعال.
 * · ثبت ⇒ بازسازی Business.ratingAvg/ratingCount (denormalized) + اعلان
 *   REVIEW به مالک کاتالوگ؛ پاسخ فروشنده ⇒ اعلان REVIEW_REPLY به نویسنده.
 * · فروشنده خودش نمی‌تواند به کاتالوگش نظر بدهد (حفاظت اعتماد).
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService
  ) {}

  /** میانگین/شمارش را از روی ردیف‌ها بازسازی و روی Business می‌نیشاند */
  private async rebuildRating(businessId: string): Promise<void> {
    const agg = await this.prisma.catalogReview.aggregate({
      where: { businessId },
      _avg: { rating: true },
      _count: { _all: true },
    });
    await this.prisma.business.update({
      where: { id: businessId },
      data: {
        ratingAvg: Math.round((agg._avg.rating ?? 0) * 10) / 10,
        ratingCount: agg._count._all,
      },
    });
  }

  /** شیت نظرات: خلاصه + ریز (تازه اول) + نظر خودِ بیننده (اگر احراز شده) */
  async list(businessId: string, viewer?: AuthUser) {
    const rows = await this.prisma.catalogReview.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { author: { select: { name: true } } },
    });
    // هویت نمایش نویسنده‌ها: کسب‌وکار فعالِ هنگام ثبت (snapshot)؛ بازمانده‌ها
    // فقط نام شخص — «احراز» نداریم ولی نام کسب‌وکار برای اعتماد کافی است
    const bizIds = [...new Set(rows.map((r) => r.authorBusinessId).filter((x): x is string => !!x))];
    const bizs = bizIds.length
      ? await this.prisma.business.findMany({ where: { id: { in: bizIds } }, select: { id: true, name: true, isVerified: true } })
      : [];
    const bizById = new Map(bizs.map((b) => [b.id, b]));

    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { ratingAvg: true, ratingCount: true },
    });

    let mine: {
      id: string;
      rating: number;
      text: string | null;
      reply: string | null;
      repliedAt: Date | null;
      createdAt: Date;
    } | null = null;
    if (viewer) {
      const own = rows.find((r) => r.authorUserId === viewer.id) ?? null;
      if (own) {
        mine = {
          id: own.id,
          rating: own.rating,
          text: own.text,
          reply: own.reply,
          repliedAt: own.repliedAt,
          createdAt: own.createdAt,
        };
      }
    }

    return {
      avg: business?.ratingAvg ?? 0,
      count: business?.ratingCount ?? 0,
      mine,
      items: rows.map((r) => {
        const ab = r.authorBusinessId ? bizById.get(r.authorBusinessId) : undefined;
        return {
          id: r.id,
          rating: r.rating,
          text: r.text,
          reply: r.reply,
          repliedAt: r.repliedAt,
          createdAt: r.createdAt,
          authorName: ab?.name ?? r.author?.name ?? "کاربر آیمچ",
          authorVerified: ab?.isVerified ?? false,
        };
      }),
    };
  }

  /** ثبت/به‌روزرسانی نظر خریدار — upsert یک-نظر-به-کاتالوک (DM-4) */
  async upsert(user: AuthUser, businessId: string, rating: number, text: string | null) {
    const target = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, ownerId: true, name: true, slug: true },
    });
    if (!target) throw AppError.notFound("کاتالوگ پیدا نشد");
    if (target.ownerId === user.id) {
      throw AppError.badRequest("به کاتالوگ خودتان نمی‌توانید نظر بدهید", "REVIEW_OWN_CATALOG");
    }
    // هویت نمایش = کسب‌وکار فعال همین کاربر (نخستین کسب‌وکار — الگوی اپ)
    const mine = await this.prisma.business.findFirst({
      where: { ownerId: user.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    });
    const cleanText = text?.trim() || null;
    if (cleanText && cleanText.length > 700) {
      throw AppError.badRequest("متن نظر بیش از حد بلند است", "REVIEW_TEXT_LONG");
    }

    const row = await this.prisma.catalogReview.upsert({
      where: { authorUserId_businessId: { authorUserId: user.id, businessId } },
      create: {
        businessId,
        authorUserId: user.id,
        authorBusinessId: mine?.id ?? null,
        rating,
        text: cleanText,
      },
      update: { rating, text: cleanText },
    });

    await this.rebuildRating(businessId);

    // اعلان به مالک کاتالوگ — best-effort
    if (target.ownerId) {
      await this.notifications
        .push({
          userId: target.ownerId,
          bizId: target.id,
          type: "REVIEW",
          actorId: mine?.id ?? null,
          actorName: mine?.name ?? "کاربر آیمچ",
          actorSlug: null,
          title: `${mine?.name ?? "خریداری"} به کاتالوگ شما ${rating} ستاره داد`,
          url: `/c/${target.slug}`,
        })
        .catch(() => undefined);
    }

    return { id: row.id, rating: row.rating, text: row.text };
  }

  /** پاسخ عمومی فروشنده زیر نظر — فقط مالک کاتالوک */
  async reply(user: AuthUser, reviewId: string, reply: string, locale: Locale = "fa") {
    const review = await this.prisma.catalogReview.findUnique({
      where: { id: reviewId },
      include: { business: { select: { id: true, ownerId: true, name: true, slug: true } } },
    });
    if (!review) throw AppError.notFound("نظر پیدا نشد");
    await assertBusinessOwner(this.prisma, user, review.business.id, locale);
    const clean = reply.trim();
    if (!clean) throw AppError.badRequest("متن پاسخ خالی است", "REPLY_EMPTY");
    if (clean.length > 700) throw AppError.badRequest("متن پاسخ بیش از حد بلند است", "REPLY_LONG");

    const updated = await this.prisma.catalogReview.update({
      where: { id: reviewId },
      data: { reply: clean, repliedAt: new Date() },
    });

    // اعلان به نویسندهٔ نظر — best-effort
    await this.notifications
      .push({
        userId: review.authorUserId,
        type: "REVIEW_REPLY",
        actorId: review.business.id,
        actorName: review.business.name,
        actorSlug: null,
        title: `${review.business.name} به نظر شما پاسخ داد`,
        url: `/c/${review.business.slug}`,
      })
      .catch(() => undefined);

    return { id: updated.id, reply: updated.reply, repliedAt: updated.repliedAt };
  }
}
