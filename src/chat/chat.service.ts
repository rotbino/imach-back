import { Injectable } from "@nestjs/common";
import { HttpStatus } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.module";
import { AppError } from "../common/errors/app-error";

/**
 * فاز ۶ مهاجرت — سرویس چت کاری (sc-msgs / sc-chat).
 * گفتگو بین دو کسب‌وکار؛ زوج مرتب (aId ≤ bId) برای یکتایی بدون جهت.
 * نرخ خواندن: لیست = آخرین پیام + شمارندهٔ نخوانده (groupBy)؛ گفتگو =
 * ۱۰۰ پیام آخر صعودی + علامت‌خوردن خودکار به‌عنوان خوانده‌شده (رفتار
 * باز کردن چت). متن خالص + پیوست عکس از /files — هیچ منطق کسب‌وکار
 * (تطبیق/قیمت/درخواست) اینجا دخالت ندارد؛ چت سابقهٔ معامله است.
 */

const OTHER_SELECT = {
  id: true,
  slug: true,
  name: true,
  trade: true,
  city: true,
  isVerified: true,
  catalogCount: true,
  phone: true,
} as const;

/** سقف پیام‌های هر بار خواندن — چت‌های کاری بلند نمی‌شوند، سقف امنیتی است */
const MSG_PAGE = 100;

@Injectable()
export class ChatService {
  constructor(private readonly prisma: PrismaService) {}

  /** کسب‌وکارهای کاربر — هر گفتگو باید یکی از آن‌ها را داشته باشد */
  private async myBusinessIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.business.findMany({
      where: { ownerId: userId },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** زوج مرتب — aId ≤ bId (ObjectId رشته‌ای؛ مقایسهٔ واژه‌نامه‌ای کافی است) */
  private orderedPair(x: string, y: string): [string, string] {
    return x < y ? [x, y] : [y, x];
  }

  /**
   * GET /chat/getThreads — فهرست گفتگوهای من (هر دو طرف).
   * هر ردیف: طرف مقابل (پروجکت‌شده) + آخرین پیام + شمارندهٔ نخواندهٔ من.
   * side = کدام سمتِ من در گفتگوست (a|b) — برای تشخیص پیام‌های خودم.
   */
  async getThreads(userId: string) {
    const mine = await this.myBusinessIds(userId);
    if (!mine.length) return { items: [], unreadTotal: 0 };

    const threads = await this.prisma.thread.findMany({
      where: { OR: [{ aId: { in: mine } }, { bId: { in: mine } }] },
      orderBy: { lastAt: "desc" },
      take: 50,
    });
    if (!threads.length) return { items: [], unreadTotal: 0 };

    // طرف مقابل‌ها — یک fetch
    const otherIds = threads.map((t) => (mine.includes(t.aId) ? t.bId : t.aId));
    const others = await this.prisma.business.findMany({
      where: { id: { in: otherIds } },
      select: OTHER_SELECT,
    });
    const otherById = new Map(others.map((o) => [o.id, o]));

    // نخوانده‌های من به تفکیک گفتگو — پیام‌های طرف مقابل که هنوز نخوانده‌ام
    const unreadByThread = new Map<string, number>();
    const grouped = await this.prisma.message.groupBy({
      by: ["threadId"],
      where: {
        threadId: { in: threads.map((t) => t.id) },
        senderId: { notIn: mine },
        readAt: null,
      },
      _count: { _all: true },
    });
    for (const g of grouped) unreadByThread.set(g.threadId, g._count._all);

    const items = threads
      .map((t) => {
        const mySide = mine.includes(t.aId) ? "a" : "b";
        const otherId = mySide === "a" ? t.bId : t.aId;
        const other = otherById.get(otherId);
        if (!other) return null; // طرف مقابل حذف شده — ردیف بی‌معنا
        return {
          id: t.id,
          side: mySide,
          other,
          lastText: t.lastText,
          lastAt: t.lastAt,
          unread: unreadByThread.get(t.id) ?? 0,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return { items, unreadTotal: items.reduce((s, i) => s + i.unread, 0) };
  }

  /**
   * POST /chat/startThread — یافتن یا ساخت گفتگو با یک کسب‌وکار.
   * businessId = کسب‌وکارِ خودم (معمولاً فعال) · withBusinessId = طرف مقابل.
   * گفتگو با خودم ممنوع (حساب‌بازی نیست، چت کاری است).
   */
  async startThread(userId: string, businessId: string, withBusinessId: string) {
    const mine = await this.myBusinessIds(userId);
    if (!mine.includes(businessId)) {
      throw AppError.badRequest("این کسب‌وکار مال شما نیست", "BIZ_NOT_YOURS");
    }
    if (businessId === withBusinessId) {
      throw AppError.badRequest("با خودت گفتگو نمی‌سازیم", "THREAD_SELF");
    }
    const other = await this.prisma.business.findUnique({
      where: { id: withBusinessId },
      select: OTHER_SELECT,
    });
    if (!other) throw AppError.badRequest("کسب‌وکار طرف مقابل پیدا نشد", "BIZ_NOT_FOUND");

    const [aId, bId] = this.orderedPair(businessId, withBusinessId);
    const existing = await this.prisma.thread.findUnique({ where: { aId_bId: { aId, bId } } });
    if (existing) return { id: existing.id, other, created: false };

    const thread = await this.prisma.thread.create({ data: { aId, bId } });
    return { id: thread.id, other, created: true };
  }

  /**
   * GET /chat/getThread/:id — جزئیات گفتگو + ۱۰۰ پیام آخر (صعودی).
   * باز کردن گفتگو = خواندن: پیام‌های طرف مقابل same-call علامت می‌خورند
   * (رفتار باز کردن چت؛ شمارندهٔ بج همین‌جا صفر می‌شود).
   */
  async getThread(userId: string, threadId: string) {
    const { thread, myBusinessId, otherId } = await this.assertMine(userId, threadId);
    const [other, messages] = await Promise.all([
      this.prisma.business.findUnique({ where: { id: otherId }, select: OTHER_SELECT }),
      this.prisma.message.findMany({
        where: { threadId: thread.id },
        orderBy: { createdAt: "desc" },
        take: MSG_PAGE,
        include: { thread: false },
      }),
    ]);
    if (!other) throw new AppError("BIZ_NOT_FOUND", "کسب‌وکار طرف مقابل پیدا نشد", HttpStatus.NOT_FOUND);

    // علامت‌خواندن — فقط پیام‌های طرف مقابلِ نخوانده
    await this.prisma.message.updateMany({
      where: { threadId: thread.id, senderId: { not: myBusinessId }, readAt: null },
      data: { readAt: new Date() },
    });

    // پیوست عکس‌ها — یک fetch برای همهٔ fileIdها
    const fileIds = [...new Set(messages.map((m) => m.fileId).filter((f): f is string => !!f))];
    const files = fileIds.length
      ? await this.prisma.file.findMany({
          where: { id: { in: fileIds } },
          select: { id: true, url: true, thumbUrl: true, name: true },
        })
      : [];
    const fileById = new Map(files.map((f) => [f.id, f]));

    return {
      id: thread.id,
      other,
      messages: messages
        .slice()
        .reverse()
        .map((m) => ({
          id: m.id,
          mine: m.senderId === myBusinessId,
          text: m.text,
          file: m.fileId ? fileById.get(m.fileId) ?? null : null,
          createdAt: m.createdAt,
        })),
    };
  }

  /**
   * POST /chat/sendMessage — ارسال پیام (متن + پیوست اختیاری).
   * متن بعد از trim باید ۱..۲۰۰۰ نویسه باشد؛ fileId باید واقعی باشد.
   * lastText/lastAt گفتگو همین‌جا به‌روز می‌شود (denormalized لیست).
   */
  async sendMessage(userId: string, threadId: string, text: string, fileId?: string) {
    const { thread, myBusinessId } = await this.assertMine(userId, threadId);
    const clean = (text ?? "").trim();
    if (!clean && !fileId) {
      throw AppError.badRequest("پیام خالی است", "MSG_EMPTY");
    }
    if (clean.length > 2000) {
      throw AppError.badRequest("پیام بلند است — حداکثر ۲۰۰۰ نویسه", "MSG_TOO_LONG");
    }
    if (fileId) {
      const file = await this.prisma.file.findUnique({ where: { id: fileId }, select: { id: true } });
      if (!file) throw AppError.badRequest("پیوست پیدا نشد", "FILE_NOT_FOUND");
    }

    const [msg] = await this.prisma.$transaction([
      this.prisma.message.create({
        // readAt صریح null — در موتور Mongoی پرایسما فیلتر null با فیلدِ غایب
        // مطابقت نمی‌کند؛ نوشتن صریح تضمین می‌کند شمارندهٔ نخوانده همیشه درست است
        data: {
          threadId: thread.id,
          senderId: myBusinessId,
          text: clean,
          fileId: fileId ?? null,
          readAt: null,
        },
      }),
      this.prisma.thread.update({
        where: { id: thread.id },
        data: { lastText: clean || "📷", lastAt: new Date() },
      }),
    ]);

    return {
      id: msg.id,
      mine: true,
      text: msg.text,
      file: fileId ? await this.fileProjection(fileId) : null,
      createdAt: msg.createdAt,
    };
  }

  /** عکس پیام را snapshot کن — فایل حذف شود، پیام متنش را نگه می‌دارد */
  private async fileProjection(fileId: string) {
    const f = await this.prisma.file.findUnique({
      where: { id: fileId },
      select: { id: true, url: true, thumbUrl: true, name: true },
    });
    return f ?? null;
  }

  /** مالکیت گفتگو — باید یکی از کسب‌وکارهای من طرف آن باشد */
  private async assertMine(userId: string, threadId: string) {
    const thread = await this.prisma.thread.findUnique({ where: { id: threadId } });
    if (!thread) throw new AppError("THREAD_NOT_FOUND", "گفتگو پیدا نشد", HttpStatus.NOT_FOUND);
    const mine = await this.myBusinessIds(userId);
    const myBusinessId = mine.includes(thread.aId)
      ? thread.aId
      : mine.includes(thread.bId)
        ? thread.bId
        : null;
    if (!myBusinessId) throw AppError.forbidden("این گفتگو مال شما نیست");
    const otherId = myBusinessId === thread.aId ? thread.bId : thread.aId;
    return { thread, myBusinessId, otherId };
  }
}
