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
    const rows = applyPriceUnit(parseImportWorkbook(file.buffer), priceUnit);
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
}
