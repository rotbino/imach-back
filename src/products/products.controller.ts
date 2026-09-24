import { Body, Controller, Get, Put, Query, UseGuards } from "@nestjs/common";
import { CurrentLocale, CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { assertBusinessOwner } from "../common/guards";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AdminGuard } from "../admin/admin.guard";
import type { Locale } from "../common/i18n/i18n";
import { PrismaService } from "../common/prisma/prisma.module";
import { ProductsService } from "./products.service";
import { AdminMergeDto, GetProductsQueryDto } from "./dto/product.dto";

/**
 * ─── Products API ────────────────────────────────────────────────────────────
 *   GET  /products/getProducts   (auth) — the picker feed
 *   PUT  /products/adminMerge    (admin) — collapse fragmented identities
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
    private readonly products: ProductsService
  ) {}

  @Get("getProducts")
  async getProducts(
    @Query() query: GetProductsQueryDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    await assertBusinessOwner(this.prisma, user, query.businessId, locale);
    return this.products.listForPicker({
      q: query.q,
      categoryId: query.categoryId,
      goodId: query.goodId,
      businessId: query.businessId,
      cursor: query.cursor,
      limit: query.limit,
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
