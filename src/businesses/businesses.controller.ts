import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { CacheService } from "../common/cache/cache.module";
import { CurrentLocale, CurrentUser, makeSlug, type AuthUser } from "../common/decorators/auth.decorators";
import { AppError } from "../common/errors/app-error";
import { assertBusinessOwner, uniqueSlug } from "../common/guards";
import type { Locale } from "../common/i18n/i18n";
import { PrismaService } from "../common/prisma/prisma.module";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CreateBusinessDto, EditBusinessDto, ExploreQueryDto } from "./dto/business.dto";

const LISTING_SELECT = {
  id: true,
  mode: true,
  price: true,
  stock: true,
  minOrder: true,
  volume: true,
  frequency: true,
  good: { select: { id: true, name: true, category: true, unit: true } },
} as const;

type ListingDtoT = {
  id: string;
  mode: string;
  price: number | null;
  stock: number | null;
  minOrder: number | null;
  volume: number | null;
  frequency: string | null;
  good: { id: string; name: string; category: string; unit: string };
};

function invalidateBusiness(cache: CacheService, businessId: string, slug?: string): void {
  cache.invalidateTag(`business:${businessId}`);
  if (slug) cache.invalidateTag(`business:slug:${slug}`);
  cache.invalidateTag(`market:board:${businessId}`);
  cache.invalidateTag(`market:sugg:${businessId}`);
  cache.invalidateTag(`market:ssugg:${businessId}`);
  cache.invalidateTag(`market:home:${businessId}`);
}

/** Business = the seller AND buyer identity of a user. */
@Controller("businesses")
export class BusinessesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService
  ) {}

  @Get("getMyBusinesses")
  @UseGuards(JwtAuthGuard)
  getMyBusinesses(@CurrentUser() user: AuthUser) {
    return this.prisma.business.findMany({
      where: { ownerId: user.id },
      select: {
        id: true,
        slug: true,
        name: true,
        activityType: true,
        city: true,
        isVerified: true,
        _count: { select: { listings: true } },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  @Post("createBusiness")
  @HttpCode(201)
  @UseGuards(JwtAuthGuard)
  async createBusiness(
    @Body() body: CreateBusinessDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const slug = await uniqueSlug(this.prisma, makeSlug(body.name), locale);
    const business = await this.prisma.business.create({
      data: {
        slug,
        name: body.name.trim(),
        city: body.city.trim(),
        phone: user.phone, // از ثبت‌نام می‌آید؛ دیگر پرسیده نمی‌شود
        ownerId: user.id,
      },
    });
    invalidateBusiness(this.cache, business.id, business.slug);
    return business;
  }

  /**
   * Public profile by slug — heavily re-read (every catalog visit) → cached.
   * Phone is deliberately NOT here: contact is the registration gate of the
   * viral loop (see getContact) — strangers must sign up to call.
   */
  @Get("getBusiness/:slug")
  async getBusiness(@Param("slug") slug: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const { value, hit } = await this.cache.wrap(
      `business:profile:${slug}`,
      { ttlMs: 60_000, tags: [`business:slug:${slug}`] },
      async () => {
        const business = await this.prisma.business.findUnique({
          where: { slug },
          select: {
            id: true,
            slug: true,
            name: true,
            activityType: true,
            city: true,
            isVerified: true,
            isDemo: true,
            _count: { select: { followers: true, following: true } },
            listings: {
              select: LISTING_SELECT,
              orderBy: { updatedAt: "desc" },
            },
          },
        });
        return business;
      }
    );

    if (!value) throw AppError.notFound("Business not found");
    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  }

  /**
   * The viral gate: only an authenticated user may reveal the phone number
   * behind a catalog / buy-list. Reading the number = being a member.
   */
  @Get("getContact/:slug")
  @UseGuards(JwtAuthGuard)
  async getContact(
    @Param("slug") slug: string,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await this.prisma.business.findUnique({
      where: { slug },
      select: { id: true, name: true, phone: true },
    });
    if (!business) throw AppError.notFound("Business not found");
    return { phone: business.phone, name: business.name };
  }

  @Patch("editBusiness/:id")
  @UseGuards(JwtAuthGuard)
  async editBusiness(
    @Param("id") id: string,
    @Body() body: EditBusinessDto,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ) {
    const business = await assertBusinessOwner(this.prisma, user, id, locale);
    const updated = await this.prisma.business.update({
      where: { id: business.id },
      data: {
        ...(body.name ? { name: body.name.trim() } : {}),
        ...(body.city ? { city: body.city.trim() } : {}),
        ...(body.activityType !== undefined ? { activityType: body.activityType } : {}),
      },
    });
    invalidateBusiness(this.cache, updated.id, business.slug); // old slug tag + new data
    return updated;
  }

  /**
   * Public social proof — the buyers following this business.
   * Feeds the follower/following lists on the arm views (like Instagram).
   */
  @Get("getFollowers/:slug")
  async getFollowersBySlug(@Param("slug") slug: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const { value, hit } = await this.cache.wrap(
      `business:followers:${slug}`,
      { ttlMs: 60_000, tags: [`business:slug:${slug}`] },
      async () => {
        const biz = await this.prisma.business.findUnique({ where: { slug }, select: { id: true } });
        if (!biz) return null;
        const rows = await this.prisma.follow.findMany({
          where: { supplierId: biz.id },
          select: {
            createdAt: true,
            buyer: { select: { slug: true, name: true, city: true, isVerified: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 100,
        });
        return rows.map((r) => ({ ...r.buyer, since: r.createdAt }));
      }
    );
    if (!value) throw AppError.notFound("Business not found");
    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  }

  /** Public — the businesses this business follows (its suppliers). */
  @Get("getFollowing/:slug")
  async getFollowingBySlug(@Param("slug") slug: string, @Res({ passthrough: true }) reply: FastifyReply) {
    const { value, hit } = await this.cache.wrap(
      `business:following:${slug}`,
      { ttlMs: 60_000, tags: [`business:slug:${slug}`] },
      async () => {
        const biz = await this.prisma.business.findUnique({ where: { slug }, select: { id: true } });
        if (!biz) return null;
        const rows = await this.prisma.follow.findMany({
          where: { buyerId: biz.id },
          select: {
            createdAt: true,
            supplier: { select: { slug: true, name: true, city: true, isVerified: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 100,
        });
        return rows.map((r) => ({ ...r.supplier, since: r.createdAt }));
      }
    );
    if (!value) throw AppError.notFound("Business not found");
    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value;
  }

  /**
   * اکسپلور — کالاهای خرید و فروشِ همه کسب‌وکارها.
   * الگوریتم v۰ (عمدا ساده؛ بعدا با نوع کالاها و حجم کاربر کامل می‌شود):
   *   ۱) شهرِ کسب‌وکار جاری کاربر اول
   *   ۲) سمت خرید: حجمِ بزرگ‌تر اول — سمت فروش: تازه‌ترین قیمت
   * عمومی است (مثل کاتالوگ‌ها) تا مهمان‌ها هم بازار را ببینند و عضو شوند.
   */
  @Get("getExplore")
  async getExplore(@Query() query: ExploreQueryDto) {
    const sellSide = query.mode !== "BUY";
    const rows = await this.prisma.listing.findMany({
      where: sellSide
        ? { mode: { in: ["SELL", "BOTH"] }, price: { not: null } }
        : { mode: { in: ["BUY", "BOTH"] }, volume: { not: null } },
      select: {
        id: true,
        mode: true,
        price: true,
        stock: true,
        minOrder: true,
        volume: true,
        frequency: true,
        updatedAt: true,
        good: { select: { id: true, name: true, category: true, unit: true } },
        business: {
          select: {
            id: true,
            slug: true,
            name: true,
            city: true,
            isVerified: true,
            activityType: true,
            _count: { select: { followers: true } },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 300,
    });

    const city = query.city?.trim();
    rows.sort((a, b) => {
      if (city) {
        const da = a.business.city === city ? 0 : 1;
        const db = b.business.city === city ? 0 : 1;
        if (da !== db) return da - db;
      }
      const va = a.volume ?? 0;
      const vb = b.volume ?? 0;
      if (va !== vb) return vb - va;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });
    return rows.slice(0, 100);
  }
}
