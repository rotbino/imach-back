import { Controller, Get, UseGuards } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.module";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { AdminGuard } from "../admin.guard";

/**
 * ─── Admin · overview counters ──────────────────────────────────────────────
 * Live numbers for the panel home. The two amber numbers (provisional goods,
 * pending brands) are the gardening queue — everything the community added
 * that still awaits an admin verdict.
 */
@Controller("admin/overview")
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminOverviewController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("getStats")
  async getStats() {
    const [
      goods,
      provisional,
      userGoods,
      pendingBrands,
      listings,
      buyListings,
      businesses,
      users,
      brands,
      categories,
    ] = await Promise.all([
      this.prisma.good.count(),
      this.prisma.good.count({ where: { status: "PROVISIONAL" } }),
      this.prisma.good.count({ where: { creatorRole: "USER" } }),
      this.prisma.brand.count({ where: { status: "PROVISIONAL" } }),
      this.prisma.listing.count(),
      this.prisma.listing.count({ where: { mode: "BUY" } }),
      this.prisma.business.count(),
      this.prisma.user.count(),
      this.prisma.brand.count(),
      this.prisma.category.count(),
    ]);
    return {
      goods,
      provisional,
      userGoods,
      pendingBrands,
      listings,
      buyListings,
      businesses,
      users,
      brands,
      categories,
    };
  }
}
