import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { goodSearchText, normalizeFa } from "../../common/catalog/catalog";
import { CacheService } from "../../common/cache/cache.module";
import { CurrentLocale, CurrentUser, type AuthUser } from "../../common/decorators/auth.decorators";
import { AppError } from "../../common/errors/app-error";
import { t, type Locale } from "../../common/i18n/i18n";
import { cursorBefore, decodeCursor, toPage, type Page } from "../../common/pagination/cursor";
import { PrismaService } from "../../common/prisma/prisma.module";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import {
  AdminBrandsQueryDto,
  AdminCreateBrandDto,
  AdminEditBrandDto,
  AdminMergeBrandDto,
} from "./dto";
import { AdminGuard } from "../admin.guard";

/**
 * ─── Admin · brands ─────────────────────────────────────────────────────────
 * Same gardening contract as goods, one folder over: brands are auto-resolved
 * from listing forms (twins are common — قلم/قلم‌آور), so the queue is
 * list → approve / merge / delete, plus manual creation from the panel.
 * User-created brands land PROVISIONAL but stay usable everywhere; admin
 * additions land ACTIVE with the creator trail pointing at the admin.
 */

const ADMIN_BRAND_SELECT = {
  id: true,
  name: true,
  source: true,
  status: true,
  creatorRole: true,
  createdBy: { select: { id: true, name: true } },
  ownerId: true,
  owner: { select: { id: true, name: true, slug: true } },
  _count: { select: { listings: true, products: true } },
} as const;

type AdminBrandRow = {
  id: string;
  name: string;
  source: string;
  status: string;
  creatorRole: string | null;
  createdBy: { id: string; name: string } | null;
  ownerId: string | null;
  owner: { id: string; name: string; slug: string } | null;
  _count: { listings: number; products: number };
};

@Controller("admin/brands")
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminBrandsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService
  ) {}

  @Get("list")
  async list(@Query() q: AdminBrandsQueryDto): Promise<Page<AdminBrandRow>> {
    const limit = Math.min(Math.max(q.limit ?? 30, 1), 100);
    const text = q.q?.trim();
    const rows = await this.prisma.brand.findMany({
      where: {
        ...(text ? { searchText: { contains: normalizeFa(text) } } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...cursorBefore(decodeCursor(q.cursor)),
      },
      select: ADMIN_BRAND_SELECT,
      orderBy: { id: "desc" }, // newest first — gardening candidates surface on top
      take: limit + 1,
    });
    return toPage(rows, limit);
  }

  @Post("create")
  async create(
    @Body() body: AdminCreateBrandDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const name = body.name.trim();
    const searchText = goodSearchText({ nameFa: name });
    const dup = await this.prisma.brand.findUnique({ where: { searchText }, select: { id: true } });
    if (dup) throw AppError.conflict(t(locale, "admin.brandExists", "برندی با همین نام وجود دارد"), "BRAND_EXISTS");

    const created = await this.prisma.brand.create({
      data: {
        name,
        searchText,
        status: "ACTIVE",
        creatorRole: "ADMIN",
        createdById: user.id,
      },
      select: ADMIN_BRAND_SELECT,
    });
    this.cache.invalidateTag("goods");
    return created;
  }

  @Patch("edit/:id")
  async edit(
    @Param("id") id: string,
    @Body() body: AdminEditBrandDto,
    @CurrentLocale() locale: Locale
  ) {
    const row = await this.prisma.brand.findUnique({ where: { id }, select: { id: true, searchText: true } });
    if (!row) throw AppError.notFound(t(locale, "admin.brandNotFound", "برند یافت نشد"));

    const data: Record<string, unknown> = {};

    // ── ویرایش نام
    if (body.name !== undefined) {
      const name = body.name.trim();
      if (name.length < 1) throw AppError.badRequest("نام برند خالی است", "BAD_NAME");
      const searchText = goodSearchText({ nameFa: name });
      // اگر searchText عوض شد، مطمئن شو یکتاست
      if (searchText !== row.searchText) {
        const dup = await this.prisma.brand.findUnique({ where: { searchText }, select: { id: true } });
        if (dup && dup.id !== id) throw AppError.conflict("برندی با همین نام وجود دارد", "BRAND_EXISTS");
      }
      data.name = name;
      data.searchText = searchText;
    }

    // ── تغییر وضعیت
    if (body.status) data.status = body.status;

    // ── تخصیص مالک
    if (body.ownerId !== undefined) {
      if (body.ownerId === null) {
        data.ownerId = null;
      } else {
        // اعتبارسنجی: Business وجود دارد
        if (!/^[0-9a-fA-F]{24}$/.test(body.ownerId)) {
          throw AppError.badRequest("ownerId معتبر نیست", "BAD_OWNER_ID");
        }
        const biz = await this.prisma.business.findUnique({ where: { id: body.ownerId }, select: { id: true } });
        if (!biz) throw AppError.notFound("کسب‌وکار یافت نشد");
        data.ownerId = body.ownerId;
      }
    }

    if (Object.keys(data).length === 0) throw AppError.badRequest("هیچ فیلدی ارسال نشده", "NO_FIELDS");

    const updated = await this.prisma.brand.update({
      where: { id },
      data,
      select: ADMIN_BRAND_SELECT,
    });
    this.cache.invalidateTag("goods");
    return updated;
  }

  @Post("merge/:id")
  async merge(
    @Param("id") id: string,
    @Body() body: AdminMergeBrandDto,
    @CurrentLocale() locale: Locale
  ) {
    if (id === body.targetId) {
      throw AppError.badRequest(t(locale, "admin.mergeSelf", "ادغام برند با خودش ممکن نیست"), "MERGE_SELF");
    }
    const [source, target] = await Promise.all([
      this.prisma.brand.findUnique({ where: { id }, select: { id: true } }),
      this.prisma.brand.findUnique({ where: { id: body.targetId }, select: { id: true } }),
    ]);
    if (!source || !target) throw AppError.notFound(t(locale, "admin.brandNotFound", "برند یافت نشد"));

    await this.prisma.$transaction([
      this.prisma.listing.updateMany({ where: { brandId: source.id }, data: { brandId: target.id } }),
      this.prisma.product.updateMany({ where: { brandId: source.id }, data: { brandId: target.id } }),
      this.prisma.brand.delete({ where: { id: source.id } }),
    ]);
    this.cache.invalidateTag("goods");
    return { ok: true, movedTo: target.id };
  }

  @Delete("delete/:id")
  async remove(@Param("id") id: string, @CurrentLocale() locale: Locale) {
    const [listingCount, productCount] = await Promise.all([
      this.prisma.listing.count({ where: { brandId: id } }),
      this.prisma.product.count({ where: { brandId: id } }),
    ]);
    if (listingCount > 0 || productCount > 0) {
      throw AppError.conflict(
        t(locale, "admin.brandInUse", "این برند در حال استفاده است — اول ادغامش کنید"),
        "BRAND_IN_USE"
      );
    }
    await this.prisma.brand.delete({ where: { id } });
    this.cache.invalidateTag("goods");
    return { ok: true };
  }
}
