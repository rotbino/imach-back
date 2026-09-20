import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
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
import { CreateBusinessDto, EditBusinessDto } from "./dto/business.dto";

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
            _count: { select: { followers: true } },
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
}
