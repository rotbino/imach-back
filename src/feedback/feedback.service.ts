import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.module";
import { AppError } from "../common/errors/app-error";
import { assertBusinessOwner } from "../common/guards";
import type { AuthUser } from "../common/decorators/auth.decorators";

/**
 * M10 (N3/N4 · سند ۰۳ §۴.۲/۴.۳/۴.۶) — بازخورد/پرسش‌وپاسخ دستیارها،
 * نظرات عمومی ویترین (Testimonial) و فیلم‌های آموزشی (VideoLesson).
 *
 * · FeedbackPost: لایک هر کسب‌وکار یک‌بار (likedBy) + پاسخ تورفته؛
 *   پاسخ تیم آیمچ فقط از ADMIN.
 * · Testimonial: ثبت آزاد (approved=false — میهمانِ لندینگ هم می‌فرستد)؛
 *   نمایش فقط تأییدشده‌ها؛ صف تأیید ادمین.
 * · VideoLesson: فقط خواندن (seed از محتوای راهنما — فاز داده).
 */
export type FeedbackKind = "FEEDBACK" | "QUESTION";
export type FeedbackArm = "BUY" | "SELL";

interface FbReply {
  team?: boolean;
  businessName: string;
  text: string;
  createdAt: string;
}

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  // ── بازخورد و پرسش‌وپاسخ ────────────────────────────────────────────

  list(kind: FeedbackKind, arm: FeedbackArm, viewerBusinessId?: string) {
    return this.prisma.feedbackPost.findMany({
      where: { kind, arm },
      orderBy: [{ likeCount: "desc" }, { createdAt: "desc" }],
      take: 100,
      include: { author: { select: { name: true } } },
    }).then((rows) =>
      rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        arm: r.arm,
        text: r.text,
        likeCount: r.likeCount,
        likedByMe: viewerBusinessId ? r.likedBy.includes(viewerBusinessId) : false,
        replies: (r.replies as FbReply[] | null) ?? [],
        createdAt: r.createdAt,
        authorName: r.author?.name ?? "کاربر آیمچ",
      }))
    );
  }

  async create(user: AuthUser, businessId: string, kind: FeedbackKind, arm: FeedbackArm, text: string) {
    const business = await assertBusinessOwner(this.prisma, user, businessId, "fa");
    const clean = text.trim();
    if (!clean) throw AppError.badRequest("متن را بنویسید", "FB_EMPTY");
    if (clean.length > 700) throw AppError.badRequest("متن بیش از حد بلند است", "FB_LONG");
    return this.prisma.feedbackPost.create({
      data: { kind, arm, authorBusinessId: business.id, text: clean },
      select: { id: true },
    });
  }

  /** لایک/برداشتن لایک — هر کسب‌وکار یک‌بار (toggle) */
  async toggleLike(user: AuthUser, postId: string, businessId: string) {
    const business = await assertBusinessOwner(this.prisma, user, businessId, "fa");
    const post = await this.prisma.feedbackPost.findUnique({ where: { id: postId } });
    if (!post) throw AppError.notFound("پست پیدا نشد");
    const has = post.likedBy.includes(business.id);
    const likedBy = has ? post.likedBy.filter((x) => x !== business.id) : [...post.likedBy, business.id];
    const row = await this.prisma.feedbackPost.update({
      where: { id: postId },
      data: { likedBy, likeCount: likedBy.length },
    });
    return { id: row.id, likeCount: row.likeCount, likedByMe: !has };
  }

  /** پاسخ تورفته — کاربر با نام کسب‌وکارش؛ ADMIN = پاسخ تیم آیمچ */
  async reply(user: AuthUser, postId: string, businessId: string | null, text: string) {
    const clean = text.trim();
    if (!clean) throw AppError.badRequest("متن پاسخ خالی است", "FB_REPLY_EMPTY");
    if (clean.length > 500) throw AppError.badRequest("پاسخ بیش از حد بلند است", "FB_REPLY_LONG");

    let businessName = "تیم آیمچ";
    let team = true;
    if (user.role !== "ADMIN") {
      // پاسخ غیرتیم = نام کسب‌وکار پاسخ‌دهنده
      const business = await assertBusinessOwner(this.prisma, user, businessId ?? "", "fa");
      businessName = business.name;
      team = false;
    }

    const post = await this.prisma.feedbackPost.findUnique({ where: { id: postId } });
    if (!post) throw AppError.notFound("پست پیدا نشد");
    const replies = ((post.replies as FbReply[] | null) ?? []);
    replies.push({ team, businessName, text: clean, createdAt: new Date().toISOString() });
    // Prisma JSON field — رفت‌وبرگشت JSON برای ساختار InputJsonValue
    const repliesJson = JSON.parse(JSON.stringify(replies)) as FbReply[];
    await this.prisma.feedbackPost.update({ where: { id: postId }, data: { replies: repliesJson as object } });
    return { id: postId, replies };
  }

  // ── نظرات عمومی ویترین (Testimonial) ───────────────────────────────

  /** فقط تأییدشده‌ها — عمومی؛ sortHint نزولی بعد تازه‌ها */
  listApproved() {
    return this.prisma.testimonial.findMany({
      where: { approved: true },
      orderBy: [{ sortHint: "desc" }, { createdAt: "desc" }],
      take: 100,
    });
  }

  /** ثبت نظر عمومی — مهمان هم می‌فرستد؛ approved=false تا تأیید ادمین (P-2) */
  async submit(input: { name: string; business: string; role?: string; isBuyer?: boolean; feature?: string; text: string }) {
    const name = input.name.trim();
    const biz = input.business.trim();
    const text = input.text.trim();
    if (!name || !biz || !text) {
      throw AppError.badRequest("نام، کسب‌وکار و متن نظر را کامل کنید", "TS_INCOMPLETE");
    }
    if (name.length > 60 || biz.length > 80 || text.length > 600) {
      throw AppError.badRequest("یکی از فیلدها بیش از حد بلند است", "TS_LONG");
    }
    const row = await this.prisma.testimonial.create({
      data: {
        name,
        business: biz,
        role: input.role?.trim() || (input.isBuyer ? "خریدار عمده" : "فروشنده عمده"),
        isBuyer: input.isBuyer ?? false,
        feature: input.feature?.trim() || null,
        text,
        approved: false,
      },
      select: { id: true },
    });
    return row;
  }

  /** صف ادمین — همه (تأییدشده و در انتظار) */
  async adminQueue() {
    const rows = await this.prisma.testimonial.findMany({
      orderBy: [{ approved: "asc" }, { createdAt: "desc" }],
      take: 200,
    });
    return rows.map((r) => ({
      ...r,
      when: r.createdAt,
    }));
  }

  async approve(id: string) {
    const row = await this.prisma.testimonial.update({ where: { id }, data: { approved: true } });
    return { id: row.id, approved: row.approved };
  }

  async reject(id: string) {
    await this.prisma.testimonial.delete({ where: { id } });
    return { id, approved: false, deleted: true };
  }

  // ── فیلم‌های آموزشی ─────────────────────────────────────────────────

  listLessons(arm: FeedbackArm) {
    return this.prisma.videoLesson.findMany({
      where: { arm, isActive: true },
      orderBy: { sortHint: "asc" },
    });
  }
}
