import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.module";
import { AppError } from "../common/errors/app-error";

/** قلم سفارش نماینده — آزاد (بدون نیاز به Listing): نام/بسته/تعداد/قیمت */
export interface RepItem {
  name: string;
  pack?: string | null;
  qty: number;
  unitPriceMinor: number;
}

const REP_STATUSES = ["NEW", "SENT", "DELIVERED", "SETTLED"] as const;
type RepStatus = (typeof REP_STATUSES)[number];

const faNum = (n: number) => n.toLocaleString("fa-IR");

/**
 * سفارش نمایندهٔ فروش (M9 · سند ۰۸ §M9/FD-17) — چرخهٔ بازاریاب سنتی:
 * NEW → SENT (لیست بیرون از سیستم برای تأمین‌کننده رفت: واتس‌اپ/پیامک/
 * کپی) → DELIVERED (کالا به مشتری رسید — پورسانت در انتظار) → SETTLED
 * (پورسانت گرفته شد). پورسانت توافقی است؛ پول بیرون از سیستم جابه‌جا
 * می‌شود — این ماژول فقط ردیابی و گزارش است (design-audit §۹).
 */
@Injectable()
export class RepService {
  constructor(private readonly prisma: PrismaService) {}

  /** ثبت سفارش نماینده — قلم‌ها آزادند؛ جمع سمت سرور محاسبه می‌شود */
  async create(
    repUserId: string,
    businessId: string,
    customerName: string,
    items: RepItem[],
    commissionPct: number
  ) {
    if (!customerName.trim()) throw AppError.badRequest("نام مشتری را وارد کنید", "REP_NO_CUSTOMER");
    if (!Array.isArray(items) || items.length === 0) {
      throw AppError.badRequest("سفارش خالی است — حداقل یک قلم وارد کنید", "REP_NO_ITEMS");
    }
    if (!(commissionPct > 0) || commissionPct > 100) {
      throw AppError.badRequest("پورسانت باید بین ۱ تا ۱۰۰ درصد باشد", "REP_BAD_COMMISSION");
    }
    let totalMinor = 0;
    const clean = items.map((it) => {
      const qty = Math.floor(Number(it.qty));
      const price = Math.floor(Number(it.unitPriceMinor));
      if (!it.name?.trim() || !(qty > 0) || !(price >= 0)) {
        throw AppError.badRequest("قلم‌های سفارش کامل نیستند (نام/تعداد/قیمت)", "REP_BAD_ITEM");
      }
      totalMinor += qty * price;
      return { name: it.name.trim(), pack: it.pack?.trim() || null, qty, unitPriceMinor: price };
    });
    if (totalMinor <= 0) throw AppError.badRequest("مبلغ سفارش صفر است", "REP_ZERO_TOTAL");

    return this.prisma.repOrder.create({
      data: {
        repUserId,
        businessId,
        customerName: customerName.trim(),
        items: clean,
        totalMinor,
        commissionPct,
        status: "NEW",
      },
    });
  }

  /** فهرست سفارش‌های نماینده — با فیلتر کسب‌وکار (گزارش واحد ۳۸) */
  async list(repUserId: string, businessId?: string) {
    const rows = await this.prisma.repOrder.findMany({
      where: { repUserId, ...(businessId ? { businessId } : {}) },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        business: { select: { id: true, slug: true, name: true, city: true, trade: true } },
      },
    });
    return rows.map((r) => {
      const items = r.items as unknown as RepItem[];
      return {
        id: r.id,
        businessId: r.businessId,
        business: r.business,
        customerName: r.customerName,
        items,
        itemCount: items.length,
        totalMinor: r.totalMinor,
        commissionPct: r.commissionPct,
        commissionMinor: this.commissionMinor(r),
        status: r.status,
        sharedVia: r.sharedVia,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });
  }

  /** پیشبرد وضعیت — فقط گامِ بعدی مجاز است (NEW→SENT→DELIVERED→SETTLED) */
  private async advance(repUserId: string, repOrderId: string, next: RepStatus, sharedVia?: string) {
    const order = await this.prisma.repOrder.findUnique({ where: { id: repOrderId } });
    if (!order || order.repUserId !== repUserId) {
      throw AppError.notFound("این سفارش نمایندگی مال شما نیست");
    }
    const idx = REP_STATUSES.indexOf(order.status as RepStatus);
    const target = REP_STATUSES.indexOf(next);
    if (target !== idx + 1) {
      throw AppError.badRequest(
        order.status === "SETTLED" ? "این سفارش تسویه شده است" : "این سفارش هنوز به این گام نرسیده است",
        "REP_BAD_TRANSITION"
      );
    }
    return this.prisma.repOrder.update({
      where: { id: repOrderId },
      data: { status: next, ...(sharedVia ? { sharedVia } : {}) },
    });
  }

  /** ارسال لیست سفارش به تأمین‌کننده — بیرون از سیستم (واتس‌اپ/پیامک/کپی) */
  async share(repUserId: string, repOrderId: string, via: "WHATSAPP" | "SMS" | "CLIPBOARD") {
    await this.advance(repUserId, repOrderId, "SENT", via);
    const fresh = await this.prisma.repOrder.findUnique({
      where: { id: repOrderId },
      include: { business: { select: { name: true } } },
    });
    return { order: fresh, text: this.listText(fresh!) };
  }

  /** تحویل شد — کالا به مشتری رسید؛ پورسانت در انتظار */
  async deliver(repUserId: string, repOrderId: string) {
    return this.advance(repUserId, repOrderId, "DELIVERED");
  }

  /** تسویه — پورسانت گرفته شد؛ در درآمد ماه می‌نشیند */
  async settle(repUserId: string, repOrderId: string) {
    return this.advance(repUserId, repOrderId, "SETTLED");
  }

  /** متنِ لیست سفارش — همان چیزی که بیرون از سیستم فرستاده می‌شود */
  private listText(order: {
    business: { name: string };
    customerName: string;
    items: unknown;
    totalMinor: number;
  }) {
    const items = (order.items as unknown as RepItem[]) ?? [];
    const lines = items
      .map((it) => `• ${it.name}${it.pack ? ` (${it.pack})` : ""} × ${faNum(it.qty)} — ${faNum(it.qty * it.unitPriceMinor)} تومان`)
      .join("\n");
    return `لیست سفارش «${order.business.name}» برای ${order.customerName}:\n${lines}\nجمع: ${faNum(order.totalMinor)} تومان`;
  }

  private commissionMinor(o: { totalMinor: number; commissionPct: number }) {
    return Math.round((o.totalMinor * o.commissionPct) / 100);
  }

  /**
   * داشبورد ۳۸ — آمار ماه جاری + کسب‌وکارهای زیر نمایندگی با آمار هرکدام.
   * کسب‌وکارها = کسب‌وکارهای خودِ کاربر (چند-کسب‌وکاری با createBusiness —
   * حکم مالک FD-17: «هر کاربر می‌تواند بی‌نهایت کسب‌وکار ایجاد کند»)؛
   * سفارش‌های نمایندگیِ هر میز زیر همان کاربر می‌نشیند.
   */
  async stats(repUserId: string) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [businesses, orders] = await Promise.all([
      this.prisma.business.findMany({
        where: { ownerId: repUserId },
        select: {
          id: true, slug: true, name: true, city: true, trade: true,
          catalogCount: true, scoreSell: true, scoreBuy: true,
          enabledArms: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.repOrder.findMany({
        where: { repUserId, createdAt: { gte: monthStart } },
        select: { businessId: true, totalMinor: true, commissionPct: true, status: true },
      }),
    ]);

    const byBiz = new Map<
      string,
      { ordersMonth: number; salesMonth: number; commissionMonth: number; pct: number | null }
    >();
    let salesMonth = 0;
    let commissionMonth = 0;
    let pendingSettleMinor = 0;
    let ordersMonth = 0;
    for (const o of orders) {
      const agg = byBiz.get(o.businessId) ?? { ordersMonth: 0, salesMonth: 0, commissionMonth: 0, pct: null };
      const comm = Math.round((o.totalMinor * o.commissionPct) / 100);
      agg.ordersMonth += 1;
      agg.salesMonth += o.totalMinor;
      agg.commissionMonth += comm;
      agg.pct = o.commissionPct; // آخرین پورسانتِ توافقی همان کسب‌وکار
      byBiz.set(o.businessId, agg);
      salesMonth += o.totalMinor;
      commissionMonth += comm;
      ordersMonth += 1;
      if (o.status === "DELIVERED") pendingSettleMinor += comm; // «در انتظار تسویه» زنده
    }

    return {
      monthStart,
      tiles: {
        salesMonthMinor: salesMonth,
        commissionMonthMinor: commissionMonth,
        pendingSettleMinor,
        businesses: businesses.length,
        ordersMonth,
      },
      businesses: businesses.map((b) => ({
        ...b,
        stats: byBiz.get(b.id) ?? { ordersMonth: 0, salesMonth: 0, commissionMonth: 0, pct: null },
      })),
    };
  }
}
