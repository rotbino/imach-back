import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { normalizeFa } from "../common/catalog/catalog";
import { CacheService } from "../common/cache/cache.module";
import { CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { AppError } from "../common/errors/app-error";
import { PrismaService } from "../common/prisma/prisma.module";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

/**
 * ─── Brand Owner Panel ─────────────────────────────────────────────────────
 *
 * The business that owns a brand can manage its Products (SKUs):
 *   - List all products under their brands
 *   - Create new products (brand + good + attrs → Product)
 *   - Edit product label, barcode, image
 *   - See which sellers are listing their products
 *
 * Admin can also access these endpoints (impersonation).
 */

const PRODUCT_SELECT = {
  id: true,
  label: true,
  searchText: true,
  barcode: true,
  imageUrl: true,
  status: true,
  brandId: true,
  brand: { select: { id: true, name: true } },
  goodId: true,
  good: {
    select: {
      id: true,
      nameFa: true,
      nameEn: true,
      unit: true,
      category: { select: { id: true, slug: true, nameFa: true, nameEn: true } },
    },
  },
  _count: { select: { listings: true } },
} as const;

@Controller("brand")
@UseGuards(JwtAuthGuard)
export class BrandController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * GET /brand/my-brands — brands owned by the caller's businesses.
   * Returns brand list with product counts.
   */
  @Get("my-brands")
  async myBrands(@CurrentUser() user: AuthUser) {
    // Find businesses owned by this user
    const businesses = await this.prisma.business.findMany({
      where: { ownerId: user.id },
      select: { id: true, name: true, slug: true },
    });
    if (businesses.length === 0) return [];

    const brands = await this.prisma.brand.findMany({
      where: { ownerId: { in: businesses.map((b) => b.id) } },
      select: {
        id: true,
        name: true,
        status: true,
        _count: { select: { products: true, listings: true } },
        owner: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { name: "asc" },
    });
    return brands;
  }

  /**
   * GET /brand/products — list all products under the caller's brands.
   * Optional ?brandId= to filter by a specific brand.
   */
  @Get("products")
  async products(@CurrentUser() user: AuthUser, @Param("brandId") brandId?: string) {
    // Find brand IDs owned by this user's businesses
    const businesses = await this.prisma.business.findMany({
      where: { ownerId: user.id },
      select: { id: true },
    });
    const bizIds = businesses.map((b) => b.id);
    if (bizIds.length === 0) return [];

    const brands = await this.prisma.brand.findMany({
      where: { ownerId: { in: bizIds } },
      select: { id: true },
    });
    const brandIds = brands.map((b) => b.id);
    if (brandIds.length === 0) return [];

    const where = {
      brandId: { in: brandIds },
      ...(brandId ? { brandId } : {}),
      status: { not: "MERGED" },
    };

    const rows = await this.prisma.product.findMany({
      where,
      select: PRODUCT_SELECT,
      orderBy: { id: "desc" },
      take: 200,
    });
    return rows;
  }

  /**
   * POST /brand/products/create — create a new Product under the caller's brand.
   * The caller must own the brand.
   */
  @Post("products/create")
  async createProduct(
    @Body() body: {
      brandId: string;
      goodId: string;
      label: string;
      barcode?: string;
      imageUrl?: string;
    },
    @CurrentUser() user: AuthUser,
  ) {
    // Verify brand ownership
    const businesses = await this.prisma.business.findMany({
      where: { ownerId: user.id },
      select: { id: true },
    });
    const bizIds = businesses.map((b) => b.id);

    const brand = await this.prisma.brand.findFirst({
      where: { id: body.brandId, ownerId: { in: bizIds } },
      select: { id: true, name: true },
    });
    if (!brand) throw AppError.forbidden("شما مالک این برند نیستید");

    // Verify good exists
    const good = await this.prisma.good.findUnique({
      where: { id: body.goodId },
      select: { id: true, nameFa: true, unit: true },
    });
    if (!good) throw AppError.notFound("نوع کالا یافت نشد");

    const label = body.label.trim() || `${brand.name} ${good.nameFa}`;
    const searchText = normalizeFa(label);

    // Check for duplicate (same good + brand + searchText)
    const existing = await this.prisma.product.findFirst({
      where: { goodId: body.goodId, brandId: body.brandId, searchText },
      select: { id: true },
    });
    if (existing) throw AppError.conflict("این محصول قبلاً ثبت شده", "PRODUCT_EXISTS");

    // Check barcode uniqueness if provided
    if (body.barcode?.trim()) {
      const barcodeDup = await this.prisma.product.findFirst({
        where: { barcode: body.barcode.trim(), status: { not: "MERGED" } },
        select: { id: true },
      });
      if (barcodeDup) throw AppError.conflict("این بارکد قبلاً برای محصول دیگری ثبت شده", "BARCODE_EXISTS");
    }

    const product = await this.prisma.product.create({
      data: {
        goodId: body.goodId,
        brandId: body.brandId,
        label,
        searchText,
        barcode: body.barcode?.trim() || null,
        imageUrl: body.imageUrl?.trim() || null,
        status: "ACTIVE",
        creatorRole: "BRAND_OWNER",
        createdById: user.id,
      },
      select: PRODUCT_SELECT,
    });

    this.cache.invalidateTag("goods");
    return product;
  }

  /**
   * POST /brand/products/update — edit a product's label, barcode, image.
   * The caller must own the brand of this product.
   */
  @Post("products/update")
  async updateProduct(
    @Body() body: {
      productId: string;
      label?: string;
      barcode?: string | null;
      imageUrl?: string | null;
    },
    @CurrentUser() user: AuthUser,
  ) {
    // Verify ownership
    const businesses = await this.prisma.business.findMany({
      where: { ownerId: user.id },
      select: { id: true },
    });
    const bizIds = businesses.map((b) => b.id);

    const product = await this.prisma.product.findUnique({
      where: { id: body.productId },
      select: { id: true, brandId: true, goodId: true, searchText: true },
    });
    if (!product) throw AppError.notFound("محصول یافت نشد");

    const brand = await this.prisma.brand.findFirst({
      where: { id: product.brandId ?? "", ownerId: { in: bizIds } },
      select: { id: true },
    });
    if (!brand) throw AppError.forbidden("شما مالک این محصول نیستید");

    const data: Record<string, unknown> = {};

    if (body.label !== undefined) {
      const label = body.label.trim();
      if (label.length < 2) throw AppError.badRequest("عنوان کوتاه است", "SHORT_LABEL");
      const searchText = normalizeFa(label);
      if (searchText !== product.searchText) {
        // Check dedup
        const dup = await this.prisma.product.findFirst({
          where: { searchText, goodId: product.goodId, status: { not: "MERGED" } },
          select: { id: true },
        });
        // Allow if it's the same product
        if (dup && dup.id !== product.id) {
          throw AppError.conflict("محصولی با همین عنوان وجود دارد", "LABEL_EXISTS");
        }
      }
      data.label = label;
      data.searchText = searchText;
    }

    if (body.barcode !== undefined) {
      if (body.barcode) {
        // Check uniqueness
        const dup = await this.prisma.product.findFirst({
          where: { barcode: body.barcode.trim(), status: { not: "MERGED" } },
          select: { id: true },
        });
        if (dup && dup.id !== product.id) {
          throw AppError.conflict("این بارکد قبلاً ثبت شده", "BARCODE_EXISTS");
        }
        data.barcode = body.barcode.trim();
      } else {
        data.barcode = null;
      }
    }

    if (body.imageUrl !== undefined) {
      data.imageUrl = body.imageUrl?.trim() || null;
    }

    if (Object.keys(data).length === 0) {
      throw AppError.badRequest("هیچ فیلدی ارسال نشده", "NO_FIELDS");
    }

    const updated = await this.prisma.product.update({
      where: { id: product.id },
      data,
      select: PRODUCT_SELECT,
    });

    this.cache.invalidateTag("goods");
    return updated;
  }

  /**
   * GET /brand/products/:productId/sellers — who is selling this product?
   * Returns businesses that have active listings on this product.
   */
  @Get("products/:productId/sellers")
  async sellers(@Param("productId") productId: string, @CurrentUser() user: AuthUser) {
    // Verify ownership
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, brandId: true },
    });
    if (!product) throw AppError.notFound("محصول یافت نشد");

    if (product.brandId) {
      const businesses = await this.prisma.business.findMany({
        where: { ownerId: user.id },
        select: { id: true },
      });
      const bizIds = businesses.map((b) => b.id);
      const brand = await this.prisma.brand.findFirst({
        where: { id: product.brandId, ownerId: { in: bizIds } },
        select: { id: true },
      });
      if (!brand) throw AppError.forbidden("شما مالک این محصول نیستید");
    }

    const listings = await this.prisma.listing.findMany({
      where: { productId, isActive: true },
      select: {
        id: true,
        mode: true,
        priceMinor: true,
        currency: true,
        stock: true,
        minOrder: true,
        volume: true,
        business: {
          select: { id: true, name: true, slug: true, city: true },
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    return listings;
  }

  /**
   * GET /brand/lookup-barcode?barcode=XXX — look up a barcode:
   *   1. In our own DB (Product table)
   *   2. If not found, query Open Food Facts (free API)
   *   Returns: { found: boolean, source: "db"|"off"|"none", product?: {...} }
   */
  @Get("lookup-barcode")
  async lookupBarcode(@Query("barcode") barcode: string) {
    if (!barcode || barcode.length < 4) {
      return { found: false, source: "none" as const };
    }

    // ── 1. Check our own DB
    const existing = await this.prisma.product.findFirst({
      where: { barcode, status: { not: "MERGED" } },
      select: {
        id: true,
        label: true,
        barcode: true,
        imageUrl: true,
        brand: { select: { id: true, name: true } },
        good: { select: { id: true, nameFa: true, nameEn: true, unit: true } },
      },
    });
    if (existing) {
      return { found: true, source: "db" as const, product: existing };
    }

    // ── 2. Query Open Food Facts
    try {
      const url = `https://world.openfoodfacts.org/api/v0/product/${encodeURIComponent(barcode)}.json`;
      const res = await fetch(url, { headers: { "User-Agent": "iMach/1.0 (contact@imach.ir)" } });
      if (!res.ok) return { found: false, source: "none" as const };
      const data = await res.json() as { status?: number; product?: { product_name?: string; product_name_fa?: string; brands?: string; image_url?: string; image_front_url?: string; quantity?: string } };
      if (data.status !== 1 || !data.product) {
        return { found: false, source: "none" as const };
      }
      const p = data.product;
      return {
        found: true,
        source: "off" as const,
        product: {
          id: null,
          label: p.product_name_fa || p.product_name || "",
          barcode,
          imageUrl: p.image_front_url || p.image_url || null,
          brand: p.brands ? { id: null, name: p.brands.split(",")[0].trim() } : null,
          good: null,
        },
      };
    } catch {
      return { found: false, source: "none" as const };
    }
  }
}
