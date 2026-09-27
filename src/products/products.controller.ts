import { Body, Controller, Get, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { CurrentLocale, CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { assertBusinessOwner } from "../common/guards";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AdminGuard } from "../admin/admin.guard";
import { FilesService } from "../files/files.service";
import { AppError } from "../common/errors/app-error";
import { t, type Locale } from "../common/i18n/i18n";
import { PrismaService } from "../common/prisma/prisma.module";
import { ProductsService } from "./products.service";
import { AdminMergeDto, ImportCommitDto, GetProductsQueryDto } from "./dto/product.dto";
import { applyPriceUnit, parseImportWorkbook } from "./import-file";

/**
 * ─── Products API ────────────────────────────────────────────────────────────
 *   GET  /products/getProducts      (auth)  — the picker feed
 *   POST /products/importPreview    (auth)  — Excel/CSV → classified preview, NO writes
 *   POST /products/importCommit     (auth)  — confirmed rows → same engine as the form
 *   PUT  /products/adminMerge       (admin) — collapse fragmented identities
 *
 * The picker is read-mostly and user-specific (sellers count + «داریش» are
 * per-caller) → NOT cached; the underlying queries are one indexed page plus
 * two bounded per-page aggregates.
 */
@Controller("products")
@UseGuards(JwtAuthGuard)
export class ProductsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly files: FilesService
  ) {}

  @Get("getProducts")
  async getProducts(
    @Query() query: GetProductsQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    // پنل باغبانیِ ادمین بدون businessId هم جست‌وجو می‌کند؛ با businessId فقط مالکش
    if (query.businessId) {
      await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    } else if (user.role !== "ADMIN") {
      throw AppError.badRequest(t(locale, "products.businessIdRequired", "businessId الزامی است"), "BUSINESS_ID_REQUIRED");
    }
    return this.products.listForPicker({
      q: query.q,
      categoryId: query.categoryId,
      goodId: query.goodId,
      brandId: query.brandId,
      barcode: query.barcode,
      businessId: query.businessId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  /**
   * POST /products/importPreview — multipart (file + businessId + mode +
   * priceUnit). Parses the workbook and returns the classified preview;
   * nothing is written (خواسته‌ی کاربر: اول سلیقه و وضوح).
   */
  @Post("importPreview")
  async importPreview(
    @Req() req: FastifyRequest,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const { fields, file } = await this.files.readMultipart(req);
    const businessId = fields.businessId ?? "";
    const mode = fields.mode === "BUY" ? "BUY" : "SELL";
    const priceUnit = fields.priceUnit === "rial" ? "rial" : "toman";
    await assertBusinessOwner(this.prisma, user, businessId, locale);
    if (!file.buffer?.length) {
      throw AppError.badRequest(locale === "en" ? "No file received" : "فایلی دریافت نشد", "NO_FILE");
    }
    const rows = applyPriceUnit(parseImportWorkbook(file.buffer).rows, priceUnit);
    return this.products.importPreview({ businessId, mode, rows });
  }

  /** POST /products/importCommit — JSON rows (from the confirmed preview). */
  @Post("importCommit")
  async importCommit(
    @Body() body: ImportCommitDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    await assertBusinessOwner(this.prisma, user, body.businessId, locale);
    return this.products.importCommit(user, {
      businessId: body.businessId,
      mode: body.mode as "SELL" | "BUY",
      rows: body.rows,
      locale,
      replaceDuplicates: body.replaceDuplicates ?? false,
    });
  }

  @Put("adminMerge")
  @UseGuards(AdminGuard)
  async adminMerge(
    @Body() body: AdminMergeDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    return this.products.adminMerge(user, { intoId: body.intoId, fromIds: body.fromIds, locale });
  }

  /**
   * POST /products/setProductImage — ست کردن عکس مرجع Product.
   * وقتی کاربر برای کالای مرجعی که عکس ندارد عکس آپلود می‌کند، آن عکس
   * روی Product.imageUrl ست می‌شود تا از آن به بعد در لیست مرجع دیده شود.
   */
  @Post("setProductImage")
  @UseGuards(JwtAuthGuard)
  async setProductImage(
    @Body() body: { productId: string; imageUrl: string },
    @CurrentUser() user: AuthUser
  ) {
    return this.products.setProductImage(user, body);
  }

  /**
   * POST /products/bulkCreate — admin bulk-creates products from a JSON array.
   * Each item: { brandId, goodName, label, barcode?, imageUrl?, attrs? }
   *
   * If goodName doesn't match an existing Good, it's auto-created in "سایر › جدید".
   * If attrs reference keys not in the Good's Category, they're added silently.
   * If a Product with the same brandId + searchText already exists, it's skipped.
   *
   * Returns: { saved, skipped, failed, items: [{ productId, label }] }
   */
  @Post("bulkCreate")
  @UseGuards(JwtAuthGuard, AdminGuard)
  async bulkCreate(
    @Body() body: {
      items: {
        brandId: string;
        goodName: string;
        label: string;
        barcode?: string;
        imageUrl?: string;
        attrs?: Record<string, string>;
      }[];
    },
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw AppError.badRequest("items باید آرایه‌ای غیرخالی باشد", "BAD_ITEMS");
    }
    if (body.items.length > 500) {
      throw AppError.badRequest("حداکثر ۵۰۰ کالا در هر درخواست", "TOO_MANY");
    }

    const { goodSearchText, normalizeFa } = await import("../common/catalog/catalog");
    let saved = 0;
    let skipped = 0;
    let failed = 0;
    const results: { productId?: string; label: string; status: "saved" | "skipped" | "failed"; error?: string }[] = [];

    // ── cache brand lookups
    const brandCache = new Map<string, { id: string; name: string } | null>();
    for (const item of body.items) {
      try {
        const label = (item.label || "").trim();
        if (label.length < 2) { failed++; results.push({ label, status: "failed", error: "label too short" }); continue; }

        // ── resolve brand
        let brand = brandCache.get(item.brandId);
        if (!brandCache.has(item.brandId)) {
          brand = await this.prisma.brand.findUnique({ where: { id: item.brandId }, select: { id: true, name: true } });
          brandCache.set(item.brandId, brand);
        }
        if (!brand) { failed++; results.push({ label, status: "failed", error: "brand not found" }); continue; }

        // ── resolve good (by name search)
        const st = goodSearchText({ nameFa: item.goodName.trim() });
        let good = await this.prisma.good.findFirst({ where: { searchText: st }, select: { id: true, categoryId: true, unit: true } });
        if (!good) {
          // auto-create good in "سایر › جدید"
          const otherCat = await this.prisma.category.findFirst({ where: { slug: "jadid" }, select: { id: true, unit: true } });
          if (!otherCat) { failed++; results.push({ label, status: "failed", error: "category 'jadid' not found" }); continue; }
          good = await this.prisma.good.create({
            data: {
              nameFa: item.goodName.trim(),
              searchText: st,
              unit: otherCat.unit || "PIECE",
              categoryId: otherCat.id,
              status: "ACTIVE",
              source: "USER",
              creatorRole: "ADMIN",
              createdById: user.id,
            },
            select: { id: true, categoryId: true, unit: true },
          });
        }

        // ── build searchText for product
        const searchText = normalizeFa(label);

        // ── check duplicate (same brand + good + searchText)
        const existing = await this.prisma.product.findFirst({
          where: { goodId: good.id, brandId: brand.id, searchText },
          select: { id: true },
        });
        if (existing) { skipped++; results.push({ label, status: "skipped" }); continue; }

        // ── check barcode uniqueness if provided
        if (item.barcode?.trim()) {
          const bcDup = await this.prisma.product.findFirst({
            where: { barcode: item.barcode.trim(), status: { not: "MERGED" } },
            select: { id: true },
          });
          if (bcDup) { failed++; results.push({ label, status: "failed", error: "barcode already exists" }); continue; }
        }

        // ── if attrs provided, check if Category has them — if not, add silently
        if (item.attrs && Object.keys(item.attrs).length > 0) {
          const cat = await this.prisma.category.findUnique({ where: { id: good.categoryId }, select: { attrs: true } });
          const catAttrs = (cat?.attrs as Array<Record<string, unknown>>) ?? [];
          const catKeys = new Set(catAttrs.map((a) => a.key as string));
          let modified = false;
          for (const k of Object.keys(item.attrs)) {
            if (!catKeys.has(k)) {
              catAttrs.push({ key: k, fa: k, en: k, type: "text" });
              modified = true;
            }
          }
          if (modified) {
            await this.prisma.category.update({ where: { id: good.categoryId }, data: { attrs: JSON.parse(JSON.stringify(catAttrs)) } });
          }
        }

        // ── create product
        const product = await this.prisma.product.create({
          data: {
            goodId: good.id,
            brandId: brand.id,
            label,
            searchText,
            barcode: item.barcode?.trim() || null,
            imageUrl: item.imageUrl?.trim() || null,
            status: "ACTIVE",
            creatorRole: "ADMIN",
            createdById: user.id,
          },
          select: { id: true, label: true },
        });
        saved++;
        results.push({ productId: product.id, label, status: "saved" });
      } catch (err) {
        failed++;
        results.push({ label: item.label || "?", status: "failed", error: String(err) });
      }
    }

    // invalidate cache
    this.products["cache"]?.invalidateTag("goods");

    return { saved, skipped, failed, items: results };
  }
}
