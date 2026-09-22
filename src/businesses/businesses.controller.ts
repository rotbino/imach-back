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
import { provinceOf } from "../common/geo/cities";
import type { Locale } from "../common/i18n/i18n";
import { PrismaService } from "../common/prisma/prisma.module";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ensurePage } from "../common/pages";
import { CreateBusinessDto, EditBusinessDto, ExploreQueryDto } from "./dto/business.dto";
import { currencyOfCountry } from "../common/catalog/catalog";

const LISTING_SELECT = {
  id: true,
  mode: true,
  priceMinor: true,
  currency: true,
  attrs: true,
  stock: true,
  minOrder: true,
  volume: true,
  frequency: true,
  brand: { select: { id: true, name: true } },
  good: {
    select: {
      id: true,
      nameFa: true,
      nameEn: true,
      unit: true,
      category: { select: { slug: true, nameFa: true, nameEn: true } },
    },
  },
} as const;

type ListingDtoT = {
  id: string;
  mode: string;
  priceMinor: number | null;
  currency: string | null;
  attrs: unknown;
  stock: number | null;
  minOrder: number | null;
  volume: number | null;
  frequency: string | null;
  brand: { id: string; name: string } | null;
  good: {
    id: string;
    nameFa: string;
    nameEn: string | null;
    unit: string;
    category: { slug: string; nameFa: string; nameEn: string };
  };
};

function invalidateBusiness(cache: CacheService, businessId: string, slug?: string): void {
  cache.invalidateTag(`business:${businessId}`);
  if (slug) cache.invalidateTag(`business:slug:${slug}`);
  cache.invalidateTag(`market:board:${businessId}`);
  cache.invalidateTag(`market:ssugg:${businessId}`);
  cache.invalidateTag(`market:buyreq:${businessId}`);
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
        country: true,
        currency: true,
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
    // catalog currency = the country the owner chose at signup
    const owner = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { country: true, referredById: true, refArm: true },
    });
    const country = owner?.country ?? "IR";
    const business = await this.prisma.business.create({
      data: {
        slug,
        name: body.name.trim(),
        city: body.city.trim(),
        province: provinceOf(body.city.trim()),
        country,
        currency: currencyOfCountry(country),
        phone: user.phone, // از ثبت‌نام می‌آید؛ دیگر پرسیده نمی‌شود
        ownerId: user.id,
        // هر کسب‌وکار با دو محیط خود متولد می‌شود: کاتالوگ فروش + میز خرید
        pages: { create: [{ type: "SELL" }, { type: "BUY" }] },
      },
    });
    invalidateBusiness(this.cache, business.id, business.slug);

    // ── Referral auto-follow ───────────────────────────────────────────────
    // The user signed up through someone's catalog / invite link; now that
    // they finally own pages, the two-way relationship is born:
    //   refArm SELL (catalog invite) → the referred becomes the referrer's
    //   CUSTOMER (their BUY page follows the referrer's SELL page).
    //   refArm BUY (purchase-desk invite) → the referred becomes the
    //   referrer's SUPPLIER (the referrer's BUY page follows their SELL page).
    if (owner?.referredById) {
      try {
        const refBiz = await this.prisma.business.findFirst({
          where: { ownerId: owner.referredById },
          select: { id: true },
          orderBy: { createdAt: "asc" },
        });
        if (refBiz && refBiz.id !== business.id) {
          if (owner.refArm === "BUY") {
            const refBuyPageId = await ensurePage(this.prisma, refBiz.id, "BUY");
            const mySellPageId = await ensurePage(this.prisma, business.id, "SELL");
            await this.prisma.follow.upsert({
              where: {
                followerPageId_supplierPageId: { followerPageId: refBuyPageId, supplierPageId: mySellPageId },
              },
              create: { followerPageId: refBuyPageId, supplierPageId: mySellPageId, viaRef: true },
              update: {},
            });
          } else {
            const myBuyPageId = await ensurePage(this.prisma, business.id, "BUY");
            const refSellPageId = await ensurePage(this.prisma, refBiz.id, "SELL");
            await this.prisma.follow.upsert({
              where: {
                followerPageId_supplierPageId: { followerPageId: myBuyPageId, supplierPageId: refSellPageId },
              },
              create: { followerPageId: myBuyPageId, supplierPageId: refSellPageId, viaRef: true },
              update: {},
            });
          }
        }
      } catch {
        // attribution is best-effort — business creation must never fail for it
      }
    }

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
            country: true,
            currency: true,
            isVerified: true,
            isDemo: true,
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
        ...(body.city ? { city: body.city.trim(), province: provinceOf(body.city.trim()) } : {}),
        ...(body.activityType !== undefined ? { activityType: body.activityType } : {}),
      },
    });
    invalidateBusiness(this.cache, updated.id, business.slug); // old slug tag + new data
    return updated;
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
        ? { mode: { in: ["SELL", "BOTH"] }, priceMinor: { not: null } }
        : { mode: { in: ["BUY", "BOTH"] }, volume: { not: null } },
      select: {
        id: true,
        mode: true,
        priceMinor: true,
        currency: true,
        stock: true,
        minOrder: true,
        volume: true,
        frequency: true,
        updatedAt: true,
        good: {
          select: {
            id: true,
            nameFa: true,
            nameEn: true,
            unit: true,
            category: { select: { slug: true, nameFa: true, nameEn: true } },
          },
        },
        business: {
          select: {
            id: true,
            slug: true,
            name: true,
            city: true,
            isVerified: true,
            activityType: true,
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
