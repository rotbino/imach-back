import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.module";
import { AppError } from "../common/errors/app-error";
import { ensurePage } from "../common/pages";

/**
 * فاز ۵ مهاجرت — موتور قیمت‌گذاری: قیمت پایه ثابت؛ تخفیف‌ها روی آن می‌نشیند.
 *
 *   قیمت پایه − (تخفیف مشتری + تخفیف حجمی) = قیمت نهایی
 *
 * سه سطح با اولویت «خاص‌تر برنده»: کالا (ITEM) › گروه کالا (GROUP) › کاتالوگ
 * (CATALOG). هر سطح دو بخش مستقل دارد:
 *   · custPct {p, h, q} — تخفیف مشتری به تفکیک نوع (گذری/همکار/قراردادی)
 *   · tiers [{from, to|null, pct}] — پله‌های حجمی بر حجمِ «همان کالا» در سفارش
 * كلید override غایب به سطح بالاتر fall-through می‌کند (الگوی Prototype:
 * گذریِ گروه همان کاتالوگ می‌ماند).
 *
 * سطح ITEM ورودی سه‌گانه دارد (درصد / مبلغ تخفیف / قیمت نهایی — به تومان)؛
 * سرور همیشه pct نتیجه‌شده را در custPct نگه می‌دارد (منبع واحد محاسبه) و
 * مبنای ورودی در itemTri برای بازنمایی دقیق فرم ذخیره می‌شود.
 */

/** سقف درصد تخفیف — همان clamp Prototype (۰ تا ۹۰) */
const MAX_PCT = 90;
/** حداکثر تعداد پله‌های حجمی در هر سطح */
const MAX_TIERS = 6;

export type CustKey = "p" | "h" | "q";
export type CustPct = Partial<Record<CustKey, number>>;
export type Tier = { from: number; to: number | null; pct: number };
export type TriInput = { kind: "pct" | "amt" | "fin"; valueToman: number };
export type ItemTri = Partial<Record<CustKey, TriInput>>;

const isCustKey = (v: string): v is CustKey => v === "p" || v === "h" || v === "q";

const clampPct = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(MAX_PCT, Math.round(n * 10) / 10);
};

/** نرمال‌سازی پله‌ها: مرتب بر from، بدون هم‌پوشانی، to=null فقط در آخری */
const normTiers = (raw: unknown): Tier[] => {
  if (!Array.isArray(raw)) return [];
  const rows: Tier[] = [];
  for (const r of raw) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    const from = Number(o.from);
    const to = o.to == null ? null : Number(o.to);
    const pct = clampPct(o.pct);
    if (!Number.isFinite(from) || from <= 0) continue;
    if (to != null && (!Number.isFinite(to) || to <= from)) continue;
    rows.push({ from: Math.round(from), to: to == null ? null : Math.round(to), pct });
  }
  rows.sort((a, b) => a.from - b.from);
  const out: Tier[] = [];
  for (const t of rows.slice(0, MAX_TIERS)) {
    // اگر ردیف قبلی باز است و این ردیف داخلش می‌افتد، قبلی را همین‌جا می‌بندیم
    const prev = out[out.length - 1];
    if (prev && prev.to == null) prev.to = t.from;
    else if (prev && prev.to != null && t.from < prev.to) t.from = prev.to;
    out.push(t);
  }
  return out;
};

const normCustPct = (raw: unknown): CustPct => {
  const out: CustPct = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isCustKey(k)) out[k] = clampPct(v);
  }
  return out;
};

const normItemTri = (raw: unknown): ItemTri => {
  const out: ItemTri = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isCustKey(k) || typeof v !== "object" || v === null) continue;
    const o = v as Record<string, unknown>;
    const kind = o.kind === "amt" || o.kind === "fin" ? o.kind : "pct";
    const valueToman = Number(o.valueToman);
    if (!Number.isFinite(valueToman) || valueToman < 0) continue;
    out[k] = { kind, valueToman: Math.round(valueToman * 10) / 10 };
  }
  return out;
};

@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  // ── خواندن وضعیت کامل (صفحهٔ تخفیف‌ها) ───────────────────────────────

  /** قواعد + کالاهای فروشِ کسب‌وکار — همهٔ داده‌های صفحهٔ sc-discount */
  async getState(businessId: string) {
    const [rules, business, listings] = await Promise.all([
      this.prisma.discountRule.findMany({ where: { businessId, isActive: true } }),
      this.prisma.business.findUnique({
        where: { id: businessId },
        select: { id: true, customCategories: true },
      }),
      this.prisma.listing.findMany({
        where: { businessId, mode: { in: ["SELL", "BOTH"] }, isActive: true },
        select: {
          id: true,
          priceMinor: true,
          currency: true,
          variantLabel: true,
          minOrder: true,
          catalogCategoryId: true,
          good: { select: { nameFa: true, nameEn: true, unit: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: 200,
      }),
    ]);
    if (!business) throw AppError.notFound("Business not found");

    const ruleOf = (scope: string, refId: string) =>
      rules.find((r) => r.scope === scope && (r.refId ?? "") === refId) ?? null;

    // refId="" نشانهٔ سطح کاتالوگ است (unique/upsert-safe)
    const cat = ruleOf("CATALOG", "");
    const catalog = cat
      ? {
          custPct: (cat.custPct as CustPct | null) ?? {},
          tiers: (cat.tiers as Tier[] | null) ?? [],
        }
      : null;

    // دسته‌های شخصی کاتالوگ (Business.customCategories) + قاعدهٔ هر دسته
    const cats = Array.isArray(business.customCategories)
      ? (business.customCategories as Array<{ id: string; name: string }>)
      : [];
    const groups = cats.map((c) => {
      const rule = ruleOf("GROUP", c.id);
      const items = listings.filter((l) => l.catalogCategoryId === c.id);
      return {
        refId: c.id,
        name: c.name,
        itemCount: items.length,
        custPct: rule ? ((rule.custPct as CustPct | null) ?? {}) : null,
        tiers: rule ? ((rule.tiers as Tier[] | null) ?? []) : null,
      };
    });

    const items = listings.map((l) => {
      const rule = ruleOf("ITEM", l.id);
      return {
        listingId: l.id,
        name: l.variantLabel ? `${l.good.nameFa} — ${l.variantLabel}` : l.good.nameFa,
        priceMinor: l.priceMinor,
        unit: l.good.unit,
        minOrder: l.minOrder,
        catalogCategoryId: l.catalogCategoryId,
        rule: rule
          ? {
              custPct: (rule.custPct as CustPct | null) ?? {},
              tiers: (rule.tiers as Tier[] | null) ?? [],
              itemTri: (rule.itemTri as ItemTri | null) ?? null,
            }
          : null,
      };
    });

    return { catalog, groups, items };
  }

  // ── ذخیرهٔ سطح‌ها ────────────────────────────────────────────────────

  /** قاعدهٔ سطح کاتالوگ — یکتا برای هر کسب‌وکار (upsert) */
  async saveCatalog(businessId: string, custPct: unknown, tiers: unknown) {
    const data = {
      custPct: normCustPct(custPct) as object,
      tiers: normTiers(tiers) as object,
    };
    return this.prisma.discountRule.upsert({
      where: { businessId_scope_refId: { businessId, scope: "CATALOG", refId: "" } },
      create: { businessId, scope: "CATALOG", refId: "", ...data },
      update: data,
    });
  }

  /** قاعدهٔ سطح گروه — refId باید یکی از customCategories خود کسب‌وکار باشد */
  async saveGroup(businessId: string, refId: string, custPct: unknown, tiers: unknown) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { customCategories: true },
    });
    if (!business) throw AppError.notFound("Business not found");
    const cats = Array.isArray(business.customCategories)
      ? (business.customCategories as Array<{ id: string }>)
      : [];
    if (!cats.some((c) => c.id === refId)) {
      throw AppError.badRequest("گروه کالا یافت نشد");
    }
    const data = {
      custPct: normCustPct(custPct) as object,
      tiers: normTiers(tiers) as object,
    };
    return this.prisma.discountRule.upsert({
      where: { businessId_scope_refId: { businessId, scope: "GROUP", refId } },
      create: { businessId, scope: "GROUP", refId, ...data },
      update: data,
    });
  }

  /**
   * قاعدهٔ سطح کالا — دو حالت:
   *   CATALOG → حذف قاعده (بازگشت به تنظیمات کاتالوگ)
   *   CUSTOM  → ورودی سه‌گانه (درصد/مبلغ/قیمت نهایی به تومان) + پله‌های حجمی
   * سرور pct هر نوع را از مبنای ورودی می‌سازد و در custPct نگه می‌دارد.
   */
  async saveItem(
    businessId: string,
    listingId: string,
    mode: "CATALOG" | "CUSTOM",
    tri?: unknown,
    tiers?: unknown
  ) {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: { businessId: true, priceMinor: true },
    });
    if (!listing || listing.businessId !== businessId) {
      throw AppError.forbidden("این کالا متعلق به این کسب‌وکار نیست");
    }

    if (mode === "CATALOG") {
      await this.prisma.discountRule.deleteMany({
        where: { businessId, scope: "ITEM", refId: listingId },
      });
      return { ok: true, reset: true };
    }

    const itemTri = normItemTri(tri);
    const baseToman = (listing.priceMinor ?? 0) / 10;
    if (baseToman <= 0 && Object.keys(itemTri).some((k) => itemTri[k as CustKey]?.kind !== "pct")) {
      throw AppError.badRequest("قیمت پایهٔ کالا ثبت نشده — ابتدا قیمت را وارد کن");
    }
    const custPct: CustPct = {};
    for (const k of Object.keys(itemTri) as CustKey[]) {
      const tri = itemTri[k]!;
      let pct: number;
      if (tri.kind === "pct") pct = tri.valueToman;
      else if (tri.kind === "amt") pct = baseToman > 0 ? (tri.valueToman / baseToman) * 100 : 0;
      else pct = baseToman > 0 ? ((baseToman - tri.valueToman) / baseToman) * 100 : 0;
      // fin می‌تواند منفی شود اگر قیمت نهایی > پایه — همان clamp صفر
      custPct[k] = clampPct(pct);
    }

    const data = {
      custPct: custPct as object,
      tiers: normTiers(tiers) as object,
      itemTri: itemTri as object,
    };
    await this.prisma.discountRule.upsert({
      where: { businessId_scope_refId: { businessId, scope: "ITEM", refId: listingId } },
      create: { businessId, scope: "ITEM", refId: listingId, ...data },
      update: data,
    });
    return { ok: true, custPct, tiers: data.tiers };
  }

  /** عملیات گروهی — RESET (پاک‌کردن قواعد اختصاصی) یا SAME (تخفیف یکسان) */
  async bulk(
    businessId: string,
    listingIds: string[],
    action: "RESET" | "SAME",
    custPct?: unknown
  ) {
    const ids = [...new Set(listingIds)].slice(0, 50);
    if (ids.length === 0) throw AppError.badRequest("کالایی انتخاب نشده");
    const owned = await this.prisma.listing.findMany({
      where: { id: { in: ids }, businessId },
      select: { id: true },
    });
    const ownedIds = owned.map((l) => l.id);
    if (ownedIds.length === 0) throw AppError.forbidden("کالای متعلق به این کسب‌وکار نیست");

    if (action === "RESET") {
      const res = await this.prisma.discountRule.deleteMany({
        where: { businessId, scope: "ITEM", refId: { in: ownedIds } },
      });
      return { affected: res.count, action };
    }
    const pct = normCustPct(custPct);
    const data = { custPct: pct as object };
    await Promise.all(
      ownedIds.map((refId) =>
        this.prisma.discountRule.upsert({
          where: { businessId_scope_refId: { businessId, scope: "ITEM", refId } },
          create: { businessId, scope: "ITEM", refId, ...data },
          update: data,
        })
      )
    );
    return { affected: ownedIds.length, action };
  }

  // ── پیش‌نمایش قیمت (تب سوم + شیت تخفیف کالا) ────────────────────────

  /** قیمت مؤثر: پایه − (تخفیف مشتری + پلهٔ حجم) با شکست منبع هر عدد */
  async preview(businessId: string, listingId: string, custType: CustKey, qty: number) {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: {
        id: true,
        businessId: true,
        priceMinor: true,
        variantLabel: true,
        catalogCategoryId: true,
        good: { select: { nameFa: true, unit: true } },
      },
    });
    if (!listing || listing.businessId !== businessId) {
      throw AppError.forbidden("این کالا متعلق به این کسب‌وکار نیست");
    }

    const [itemRule, groupRule, catRule] = await Promise.all([
      this.prisma.discountRule.findUnique({
        where: { businessId_scope_refId: { businessId, scope: "ITEM", refId: listingId } },
      }),
      listing.catalogCategoryId
        ? this.prisma.discountRule.findUnique({
            where: { businessId_scope_refId: { businessId, scope: "GROUP", refId: listing.catalogCategoryId } },
          })
        : null,
      this.prisma.discountRule.findUnique({
        where: { businessId_scope_refId: { businessId, scope: "CATALOG", refId: "" } },
      }),
    ]);

    // تخفیف مشتری: کالا › گروه › کاتالوگ (کلید غایب → سطح بالاتر)
    let custPct = 0;
    let custFrom: "ITEM" | "GROUP" | "CATALOG" | "NONE" = "NONE";
    for (const [rule, lvl] of [
      [itemRule, "ITEM"],
      [groupRule, "GROUP"],
      [catRule, "CATALOG"],
    ] as const) {
      const pct = rule ? ((rule.custPct as CustPct | null) ?? {})[custType] : undefined;
      if (pct != null) {
        custPct = pct;
        custFrom = lvl;
        break;
      }
    }

    // پله‌های حجمی: کل آرایه از خاص‌ترین سطحِ دارای پله
    const tierSource =
      itemRule && Array.isArray(itemRule.tiers) && (itemRule.tiers as Tier[]).length
        ? { tiers: itemRule.tiers as Tier[], from: "ITEM" as const }
        : groupRule && Array.isArray(groupRule.tiers) && (groupRule.tiers as Tier[]).length
          ? { tiers: groupRule.tiers as Tier[], from: "GROUP" as const }
          : catRule && Array.isArray(catRule.tiers) && (catRule.tiers as Tier[]).length
            ? { tiers: catRule.tiers as Tier[], from: "CATALOG" as const }
            : null;

    let tierPct = 0;
    let tierLabel: string | null = null;
    if (tierSource && qty > 0) {
      const t = tierSource.tiers.find((x) => qty >= x.from && (x.to == null || qty < x.to));
      if (t) {
        tierPct = t.pct;
        tierLabel = t.to == null ? `${t.from}+` : `${t.from}–${t.to}`;
      }
    }

    const baseMinor = listing.priceMinor ?? 0;
    const totalPct = Math.min(MAX_PCT, custPct + tierPct);
    const finalMinor = Math.round(baseMinor * (1 - totalPct / 100));

    return {
      listingId,
      goodName: listing.variantLabel ? `${listing.good.nameFa} — ${listing.variantLabel}` : listing.good.nameFa,
      unit: listing.good.unit,
      baseMinor,
      custType,
      custPct,
      custFrom,
      tierPct,
      tierLabel,
      tierFrom: tierSource?.from ?? null,
      totalPct,
      finalMinor,
      orderTotalMinor: finalMinor * qty,
      hasItemRule: !!itemRule,
    };
  }

  // ── نوع مشتری (روی یال فالو) ────────────────────────────────────────

  /** نوع مشتری یک خریدار از دید این فروشنده — PASSING | PARTNER | CONTRACT.
   *  طبق جریان شیت دنبال‌کنندگانِ پروتوتایپ (05-followers-types)، فروشنده باید
   *  بتواند نوعِ هر دنبال‌کنندهٔ قیمت را — حتی خریداری که فقط از تابلو تماشا
   *  می‌کند و هنوز کاتالوگ را فالو نکرده — تعیین کند. پس در نبودِ یال، همان
   *  جا یالِ مشتری ساخته می‌شود (بدون اعلان؛ صرفاً لبهٔ رابطه). تطبیق آگاهانه —
   *  مستند در MIGRATION-MAP §فاز۵. */
  async setCustType(businessId: string, buyerId: string, type: "PASSING" | "PARTNER" | "CONTRACT") {
    const pageId = await ensurePage(this.prisma, businessId, "SELL");
    const buyerBiz = await this.prisma.business.findUnique({
      where: { id: buyerId },
      select: { id: true },
    });
    if (!buyerBiz) throw AppError.notFound("Business not found");
    const buyerPageId =
      (await this.prisma.page.findFirst({
        where: { businessId: buyerId, type: "BUY" },
        select: { id: true },
      }))?.id ?? (await ensurePage(this.prisma, buyerId, "BUY"));

    const res = await this.prisma.follow.updateMany({
      where: { supplierPageId: pageId, followerPageId: buyerPageId },
      data: { custType: type },
    });
    if (res.count === 0) {
      // خریدار هنوز کاتالوگ را فالو نکرده (مثلاً فقط دیده‌بانِ تابلو است) —
      // یالِ رابطه می‌سازیم تا نوع مشتری‌اش برای موتور قیمت ثبت شود.
      // (پیام خطای قبلی: "این خریدار کاتالوگ شما را دنبال نمی‌کند")
      await this.prisma.follow.create({
        data: { supplierPageId: pageId, followerPageId: buyerPageId, source: "ORGANIC", custType: type },
      });
    }
    return { ok: true, buyerId, type };
  }
}
