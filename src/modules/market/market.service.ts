import { prisma } from "../../lib/prisma.js";
import { cache, TTL } from "../../lib/cache.js";
import { errors } from "../../lib/errors.js";
import { assertBusinessOwner } from "../../lib/guards.js";
import { decodeCursor, cursorBefore, toPage } from "../../lib/cursor.js";
import { matchingService } from "../matching/matching.service.js";
import type { AuthUser } from "../../plugins/auth.js";
import type { SendOfferBodyT } from "./market.schemas.js";

const OFFER_INCLUDE = {
  listing: {
    select: {
      id: true,
      price: true,
      minOrder: true,
      good: { select: { id: true, name: true, category: true, unit: true } },
    },
  },
  seller: { select: { id: true, slug: true, name: true, role: true, city: true, isVerified: true } },
} as const;

const INQUIRY_INCLUDE = {
  listing: {
    select: {
      id: true,
      price: true,
      good: { select: { id: true, name: true, category: true, unit: true } },
    },
  },
  buyer: { select: { id: true, slug: true, name: true, role: true, city: true, isVerified: true } },
} as const;

function invalidateBuyerSide(businessId: string): void {
  cache.invalidateTag(`market:board:${businessId}`);
  cache.invalidateTag(`market:sugg:${businessId}`);
}

export const marketService = {
  /**
   * The core loop: buyer hits "درخواست قیمت" on a BUY listing.
   * The engine ranks suppliers, creates an Inquiry for each matched seller
   * and a persisted Offer for the buyer — atomically in one transaction.
   */
  async createQuoteRequest(user: AuthUser, listingId: string, note?: string) {
    const need = await prisma.listing.findUnique({ where: { id: listingId }, include: { good: true } });
    if (!need) throw errors.notFound("Listing");
    const business = await assertBusinessOwner(user, need.businessId);

    if (need.mode === "SELL" || need.volume === null) {
      throw errors.badRequest("استعلام قیمت فقط برای کالاهای خرید قابل انجام است", "NOT_A_BUY_LISTING");
    }

    const matches = await matchingService.suppliersForNeed(
      business.id,
      business.city,
      need.goodId,
      need.volume
    );
    if (matches.length === 0) return { created: 0, offers: [] };

    const created = await prisma.$transaction(async (tx) => {
      const offers = [];
      for (const m of matches) {
        await tx.inquiry.create({
          data: {
            buyerId: business.id,
            sellerId: m.sellerId,
            listingId: m.listingId,
            volume: need.volume as number,
            note: note?.trim() || null,
          },
        });
        offers.push(
          await tx.offer.create({
            data: {
              buyerId: business.id,
              sellerId: m.sellerId,
              listingId: m.listingId,
              price: m.price,
              minOrder: m.minOrder,
              score: m.score,
              isSpecial: m.isSpecial,
              note: note?.trim() || null,
            },
            include: OFFER_INCLUDE,
          })
        );
      }
      return offers;
    });

    invalidateBuyerSide(business.id);
    return { created: created.length, offers: created };
  },

  /** Offers received by a buyer (per business), newest first, cursor-paginated. */
  async myOffers(user: AuthUser, businessId: string, cursor?: string, limit = 50) {
    await assertBusinessOwner(user, businessId);
    const rows = await prisma.offer.findMany({
      where: { buyerId: businessId, ...cursorBefore(decodeCursor(cursor)) },
      include: OFFER_INCLUDE,
      orderBy: { id: "desc" },
      take: Math.min(limit, 100) + 1,
    });
    return toPage(rows, Math.min(limit, 100));
  },

  /** Inquiries received by a seller. */
  async incomingInquiries(user: AuthUser, businessId: string, cursor?: string, limit = 30) {
    await assertBusinessOwner(user, businessId);
    const cap = Math.min(limit, 100);
    const [rows, unread] = await Promise.all([
      prisma.inquiry.findMany({
        where: { sellerId: businessId, ...cursorBefore(decodeCursor(cursor)) },
        include: INQUIRY_INCLUDE,
        orderBy: { id: "desc" },
        take: cap + 1,
      }),
      prisma.inquiry.count({ where: { sellerId: businessId, isRead: false } }),
    ]);
    return { ...toPage(rows, cap), unreadCount: unread };
  },

  async markInquiryRead(user: AuthUser, inquiryId: string) {
    const inquiry = await prisma.inquiry.findUnique({ where: { id: inquiryId }, select: { id: true, sellerId: true } });
    if (!inquiry) throw errors.notFound("Inquiry");
    await assertBusinessOwner(user, inquiry.sellerId);
    await prisma.inquiry.update({ where: { id: inquiry.id }, data: { isRead: true } });
    cache.invalidateTag(`market:inq:${inquiry.sellerId}`);
    return { ok: true };
  },

  /** Seller answers an inquiry with a concrete price → becomes an Offer for the buyer. */
  async sendOffer(user: AuthUser, body: SendOfferBodyT) {
    const inquiry = await prisma.inquiry.findUnique({
      where: { id: body.inquiryId },
      include: { listing: { select: { minOrder: true, price: true } } },
    });
    if (!inquiry) throw errors.notFound("Inquiry");
    await assertBusinessOwner(user, inquiry.sellerId);

    const offer = await prisma.offer.create({
      data: {
        buyerId: inquiry.buyerId,
        sellerId: inquiry.sellerId,
        listingId: inquiry.listingId,
        price: body.price,
        minOrder: inquiry.listing.minOrder ?? 0,
        score: 0, // manual answer — no engine score
        isSpecial: false,
        note: body.note?.trim() || null,
      },
      include: OFFER_INCLUDE,
    });

    await prisma.inquiry.update({
      where: { id: inquiry.id },
      data: { status: "ANSWERED", isRead: true },
    });

    invalidateBuyerSide(inquiry.buyerId);
    cache.invalidateTag(`market:inq:${inquiry.sellerId}`);
    return offer;
  },

  async follows(user: AuthUser, businessId: string) {
    await assertBusinessOwner(user, businessId);
    const rows = await prisma.follow.findMany({
      where: { buyerId: businessId },
      select: {
        supplierId: true,
        createdAt: true,
        supplier: { select: { slug: true, name: true, role: true, city: true, isVerified: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return rows;
  },

  async follow(user: AuthUser, body: { businessId: string; supplierId: string }) {
    const business = await assertBusinessOwner(user, body.businessId);
    if (body.supplierId === business.id) {
      throw errors.badRequest("نمی‌توانید کسب‌وکار خودتان را فالو کنید", "SELF_FOLLOW");
    }
    const supplier = await prisma.business.findUnique({ where: { id: body.supplierId }, select: { id: true } });
    if (!supplier) throw errors.notFound("Supplier");

    await prisma.follow.upsert({
      where: { buyerId_supplierId: { buyerId: business.id, supplierId: body.supplierId } },
      create: { buyerId: business.id, supplierId: body.supplierId },
      update: {},
    });
    invalidateBuyerSide(business.id);
    return { ok: true };
  },

  async unfollow(user: AuthUser, body: { businessId: string; supplierId: string }) {
    const business = await assertBusinessOwner(user, body.businessId);
    await prisma.follow.deleteMany({ where: { buyerId: business.id, supplierId: body.supplierId } });
    invalidateBuyerSide(business.id);
    return { ok: true };
  },

  /**
   * Live price board: latest sell listing of every followed supplier with the
   * most recent PriceLog for trend detection. Short TTL — it is "live" by design.
   */
  async priceBoard(user: AuthUser, businessId: string) {
    await assertBusinessOwner(user, businessId);
    const { value, hit } = await cache.wrap(
      `market:board:${businessId}`,
      { ttlMs: TTL.SHORT, tags: [`market:board:${businessId}`] },
      async () => {
        const follows = await prisma.follow.findMany({
          where: { buyerId: businessId },
          select: { supplierId: true },
        });
        if (follows.length === 0) return [];

        const listings = await prisma.listing.findMany({
          where: {
            businessId: { in: follows.map((f) => f.supplierId) },
            mode: { in: ["SELL", "BOTH"] },
            price: { not: null },
          },
          select: {
            id: true,
            price: true,
            stock: true,
            minOrder: true,
            updatedAt: true,
            good: { select: { id: true, name: true, category: true, unit: true } },
            business: { select: { id: true, slug: true, name: true, role: true, city: true, isVerified: true } },
            priceLogs: { orderBy: { createdAt: "desc" }, take: 1, select: { oldPrice: true, newPrice: true, createdAt: true } },
          },
          orderBy: { updatedAt: "desc" },
          take: 200,
        });
        return listings;
      }
    );
    return { value, hit };
  },

  /** Suggested buyers for my sell catalog (sell-arm widget). */
  async suggestions(user: AuthUser, businessId: string) {
    const business = await assertBusinessOwner(user, businessId);
    const { value, hit } = await cache.wrap(
      `market:sugg:${businessId}`,
      { ttlMs: TTL.MINUTE, tags: [`market:sugg:${businessId}`] },
      () => matchingService.buyersForSeller(business.id, business.city)
    );
    return { value, hit };
  },
};
