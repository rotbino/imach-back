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
 *
 * M8 (سند ۰۸ §M8 · FD-22 تصمیم ۸) — زمینهٔ گفتگو: startThread با
 * contextType/contextRefId (سفارش/پیشنهاد/پیشنهاد تامین/آگهی) گفتگوی
 * جدا برای همان سند می‌سازد؛ getThread عنوان زندهٔ «دربارهٔ: …» را از
 * خودِ سند استنتاج می‌کند (آیتم‌های فریزشده/نام کالا) — نه متن ثابت.
 * + حضور (presence): heartbeat ≤۱/۶۰s نشان آنلاین طرف را در لیست و
 * گفتگو تازه می‌کند (آستانهٔ آنلاین ۹۰s).
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

/** آستانهٔ آنلاین — ۹۰ ثانیه از آخرین ضربان (سند ۰۸ §M8) */
const ONLINE_WINDOW_MS = 90_000;

/** زمینه‌های مجاز گفتگو — سندهایی که چت از دلِ آن‌ها شروع می‌شود */
const CONTEXT_TYPES = ["ORDER", "OFFER", "SUPPLY_PROPOSAL", "LISTING"] as const;
type ContextType = (typeof CONTEXT_TYPES)[number];

/** عدد → رقم فارسی (عناوین زمینه مثل «سفارش برنج و ۲ قلم دیگر») */
const faDigits = (n: number): string => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[+d]);

/** اقلام فریزشدهٔ سند — فقط شکل خوانده‌شده برای عنوان */
interface FrozenItem {
  name?: string;
  goodId?: string;
  [k: string]: unknown;
}

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

  // ── حضور (presence) ─────────────────────────────────────────────

  /**
   * POST /chat/heartbeat — ضربان حضور؛ شل هر ≤۶۰s یک‌بار می‌زند.
   * هر فعالیتِ صفحه‌ای همان ضربان را تازه می‌کند (رفت و برگشت اپ).
   */
  async heartbeat(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { lastSeenAt: new Date() },
    });
    return { ok: true };
  }

  /** مپ آنلاین‌بودن کسب‌وکارهای مقابل — مالکشان ≤۹۰s ضربان زده باشد */
  private async onlineByBiz(bizIds: string[]): Promise<Map<string, boolean>> {
    if (!bizIds.length) return new Map();
    const bizs = await this.prisma.business.findMany({
      where: { id: { in: bizIds } },
      select: { id: true, ownerId: true },
    });
    if (!bizs.length) return new Map();
    // ownerId نالپذیر است (مالک حذف شده) — بدون مالک، حضور هم نیست
    const ownerIds = bizs
      .map((b) => b.ownerId)
      .filter((id): id is string => !!id);
    const owners = ownerIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, lastSeenAt: true },
        })
      : [];
    const now = Date.now();
    const onlineByOwner = new Map(
      owners.map((u) => [
        u.id,
        !!u.lastSeenAt && now - u.lastSeenAt.getTime() <= ONLINE_WINDOW_MS,
      ])
    );
    return new Map(
      bizs.map((b) => [b.id, b.ownerId ? (onlineByOwner.get(b.ownerId) ?? false) : false])
    );
  }

  // ── لیست گفتگوها (۲۹) ────────────────────────────────────────────

  /**
   * GET /chat/getThreads — فهرست گفتگوهای من (هر دو طرف).
   * هر ردیف: طرف مقابل (پروجکت‌شده + نشان آنلاین M8) + آخرین پیام +
   * شمارندهٔ نخواندهٔ من. side = کدام سمتِ من در گفتگوست (a|b).
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

    // طرف مقابل‌ها — یک fetch + حضورشان — یک fetch
    const otherIds = threads.map((t) => (mine.includes(t.aId) ? t.bId : t.aId));
    const [others, onlineMap] = await Promise.all([
      this.prisma.business.findMany({
        where: { id: { in: otherIds } },
        select: OTHER_SELECT,
      }),
      this.onlineByBiz(otherIds),
    ]);
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
          other: { ...other, online: onlineMap.get(otherId) ?? false },
          lastText: t.lastText,
          lastAt: t.lastAt,
          unread: unreadByThread.get(t.id) ?? 0,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return { items, unreadTotal: items.reduce((s, i) => s + i.unread, 0) };
  }

  // ── شروع گفتگو (۳۰ · FD-22 تصمیم ۸) ─────────────────────────────

  /**
   * POST /chat/startThread — یافتن یا ساخت گفتگو با یک کسب‌وکار.
   * businessId = کسب‌وکارِ خودم (معمولاً فعال) · withBusinessId = طرف مقابل.
   * گفتگو با خودم ممنوع (حساب‌بازی نیست، چت کاری است).
   * M8: با contextType/contextRefId گفتگوی زمینه‌دارِ همان سند ساخته می‌شود —
   * زوجِ سند باید همان دو طرف گفتگو باشد (اعتبارسنجی روی خودِ داده).
   */
  async startThread(
    userId: string,
    businessId: string,
    withBusinessId: string,
    contextType?: string,
    contextRefId?: string
  ) {
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

    // زمینه — کلید غیرنالپذور «TYPE:id»؛ گفتگوی آزاد «» (قاعدهٔ یکتایی M8)
    let contextKey = "";
    if (contextType || contextRefId) {
      if (!contextType || !CONTEXT_TYPES.includes(contextType as ContextType)) {
        throw AppError.badRequest(
          "زمینهٔ گفتگو باید ORDER، OFFER، SUPPLY_PROPOSAL یا LISTING باشد",
          "BAD_CONTEXT_TYPE"
        );
      }
      if (!contextRefId) {
        throw AppError.badRequest("شناسهٔ سند زمینه لازم است", "BAD_CONTEXT_REF");
      }
      await this.assertContextPair(contextType as ContextType, contextRefId, businessId, withBusinessId);
      contextKey = `${contextType}:${contextRefId}`;
    }

    const [aId, bId] = this.orderedPair(businessId, withBusinessId);
    const existing = await this.prisma.thread.findUnique({
      where: { aId_bId_contextKey: { aId, bId, contextKey } },
    });
    if (existing) {
      return {
        id: existing.id,
        other,
        created: false,
        context: existing.contextType ? { type: existing.contextType, refId: existing.contextRefId ?? "" } : null,
      };
    }

    // صریح‌نویسی contextKey (درس readAt) — رفتار پیش‌فرض به سند قدیمی نمی‌چسبد
    const thread = await this.prisma.thread.create({
      data: {
        aId,
        bId,
        contextKey,
        ...(contextKey ? { contextType, contextRefId } : {}),
      },
    });
    return {
      id: thread.id,
      other,
      created: true,
      context: thread.contextType ? { type: thread.contextType, refId: thread.contextRefId ?? "" } : null,
    };
  }

  /** سند زمینه باید موجود باشد و دو طرفش همان زوج گفتگو باشد — استنتاج از داده */
  private async assertContextPair(
    type: ContextType,
    refId: string,
    businessId: string,
    withBusinessId: string
  ) {
    const pair = new Set([businessId, withBusinessId]);
    if (type === "ORDER") {
      const o = await this.prisma.order.findUnique({
        where: { id: refId },
        select: { buyerId: true, sellerId: true },
      });
      if (!o) throw new AppError("CONTEXT_NOT_FOUND", "سند زمینه پیدا نشد", HttpStatus.NOT_FOUND);
      if (!pair.has(o.buyerId) || !pair.has(o.sellerId)) {
        throw new AppError(
          "CONTEXT_MISMATCH",
          "دو طرف این گفتگو طرف‌های سند زمینه نیستند",
          HttpStatus.FORBIDDEN
        );
      }
    } else if (type === "OFFER") {
      const o = await this.prisma.offer.findUnique({
        where: { id: refId },
        select: { buyerId: true, sellerId: true },
      });
      if (!o) throw new AppError("CONTEXT_NOT_FOUND", "سند زمینه پیدا نشد", HttpStatus.NOT_FOUND);
      if (!pair.has(o.buyerId) || !pair.has(o.sellerId)) {
        throw new AppError(
          "CONTEXT_MISMATCH",
          "دو طرف این گفتگو طرف‌های سند زمینه نیستند",
          HttpStatus.FORBIDDEN
        );
      }
    } else if (type === "SUPPLY_PROPOSAL") {
      const p = await this.prisma.supplyProposal.findUnique({
        where: { id: refId },
        select: { buyerId: true, supplierId: true },
      });
      if (!p) throw new AppError("CONTEXT_NOT_FOUND", "سند زمینه پیدا نشد", HttpStatus.NOT_FOUND);
      if (!pair.has(p.buyerId) || !pair.has(p.supplierId)) {
        throw new AppError(
          "CONTEXT_MISMATCH",
          "دو طرف این گفتگو طرف‌های سند زمینه نیستند",
          HttpStatus.FORBIDDEN
        );
      }
    } else {
      // LISTING — فروشندهٔ آگهی باید یکی از دو طرف گفتگو باشد
      const l = await this.prisma.listing.findUnique({
        where: { id: refId },
        select: { businessId: true },
      });
      if (!l) throw new AppError("CONTEXT_NOT_FOUND", "سند زمینه پیدا نشد", HttpStatus.NOT_FOUND);
      if (!pair.has(l.businessId)) {
        throw new AppError(
          "CONTEXT_MISMATCH",
          "فروشندهٔ این آگهی طرف این گفتگو نیست",
          HttpStatus.FORBIDDEN
        );
      }
    }
  }

  /** DTO زمینه — نوع + شناسه؛ عنوان فقط در getThread (استنتاج زنده) */
  private contextDto(thread: { contextType: string | null; contextRefId: string | null }) {
    return thread.contextType
      ? { type: thread.contextType, refId: thread.contextRefId ?? "" }
      : null;
  }

  /**
   * عنوان زمینه — «دربارهٔ: سفارش برنج هاشمی» (FD-22). استنتاج زنده از
   * خودِ سند: نام کالای اول + «و N قلم دیگر»؛ اگر سند حذف شده باشد null
   * می‌گردد و نوار زمینه عقب می‌نشیند (منبع حقیقت خودِ داده است).
   */
  private async contextTitle(thread: {
    contextType: string | null;
    contextRefId: string | null;
  }): Promise<string | null> {
    if (!thread.contextType || !thread.contextRefId) return null;
    const refId = thread.contextRefId;

    if (thread.contextType === "ORDER") {
      const o = await this.prisma.order.findUnique({
        where: { id: refId },
        select: { items: true, docNo: true },
      });
      if (!o) return null;
      const items = Array.isArray(o.items) ? (o.items as FrozenItem[]) : [];
      const first = items[0]?.name;
      const rest = items.length > 1 ? ` و ${faDigits(items.length - 1)} قلم دیگر` : "";
      if (first) return `سفارش ${first}${rest}`;
      return o.docNo ? `سفارش ${faDigits(o.docNo)}` : "سفارش";
    }

    if (thread.contextType === "OFFER") {
      const off = await this.prisma.offer.findUnique({
        where: { id: refId },
        select: { listing: { select: { good: { select: { nameFa: true } } } } },
      });
      return off ? `پیشنهاد ${off.listing.good.nameFa}` : null;
    }

    if (thread.contextType === "SUPPLY_PROPOSAL") {
      const p = await this.prisma.supplyProposal.findUnique({
        where: { id: refId },
        select: { items: true },
      });
      if (!p) return null;
      const items = Array.isArray(p.items)
        ? (p.items as FrozenItem[]).filter((it) => it && typeof it.goodId === "string")
        : [];
      const goods = items.length
        ? await this.prisma.good.findMany({
            where: { id: { in: items.map((it) => it.goodId as string) } },
            select: { id: true, nameFa: true },
          })
        : [];
      // ترتیب اقلام سند منبع حقیقت است — نه ترتیبِ برگشتی کوئری
      const nameById = new Map(goods.map((g) => [g.id, g.nameFa]));
      const first = items[0] ? nameById.get(items[0].goodId as string) : undefined;
      const rest = items.length > 1 ? ` و ${faDigits(items.length - 1)} قلم دیگر` : "";
      return first ? `پیشنهاد تأمین ${first}${rest}` : "پیشنهاد تأمین";
    }

    // LISTING — عنوان شخصی فروشنده یا نام کالای مرجع
    const l = await this.prisma.listing.findUnique({
      where: { id: refId },
      select: { title: true, good: { select: { nameFa: true } } },
    });
    return l ? l.title || l.good?.nameFa || null : null;
  }

  // ── گفتگو (۳۰) ──────────────────────────────────────────────────

  /**
   * GET /chat/getThread/:id — جزئیات گفتگو + ۱۰۰ پیام آخر (صعودی).
   * باز کردن گفتگو = خواندن: پیام‌های طرف مقابل same-call علامت می‌خورند
   * (رفتار باز کردن چت؛ شمارندهٔ بج همین‌جا صفر می‌شود).
   * M8: زمینه (نوع + عنوان زنده) + نشان آنلاین طرف.
   */
  async getThread(userId: string, threadId: string) {
    const { thread, myBusinessId, otherId } = await this.assertMine(userId, threadId);
    const [other, messages, onlineMap, contextTitle] = await Promise.all([
      this.prisma.business.findUnique({ where: { id: otherId }, select: OTHER_SELECT }),
      this.prisma.message.findMany({
        where: { threadId: thread.id },
        orderBy: { createdAt: "desc" },
        take: MSG_PAGE,
        include: { thread: false },
      }),
      this.onlineByBiz([otherId]),
      this.contextTitle(thread),
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
      other: { ...other, online: onlineMap.get(otherId) ?? false },
      context: thread.contextType
        ? { type: thread.contextType, refId: thread.contextRefId ?? "", title: contextTitle }
        : null,
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
