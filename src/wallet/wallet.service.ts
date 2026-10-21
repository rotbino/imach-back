import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.module";

/** نرخ‌ها و ثابت‌های پولی طرح ۸ — همه به minor ریال (تومان = ÷۱۰) */
export const REFERRAL_REWARD_MINOR = 50_000; // +۵٬۰۰۰ تومان پاداش دعوت
export const PROMO_VIEW_MINOR = 10_000; // ۱٬۰۰۰ تومان هر نمایش هدفمند
export const PROMO_FOLLOW_MINOR = 50_000; // ۵٬۰۰۰ تومان هر ذخیرهٔ حاصل

/**
 * کیف پول تومانی — الگوی اینستاگرام: پول واقعی به‌ازای نتیجه، نه «اعتبار».
 * همهٔ تغییرات موجودی فقط از همین کلاس می‌گذرند تا یک منبع حقیقت بماند:
 * شارژ درگاه، پاداش دعوت، قفل بودجهٔ کمپین و برگشتِ آن.
 */
@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  /** کیفِ موجود را برمی‌گرداند یا می‌سازد (لحظهٔ اولین مصرف — بدون فرم) */
  async ensure(businessId: string) {
    return this.prisma.wallet.upsert({
      where: { businessId },
      create: { businessId },
      update: {},
      include: { txns: { orderBy: { createdAt: "desc" }, take: 30 } },
    });
  }

  /** شارژ درگاه — در نسخهٔ واقعی پاسخ درگاه؛ اینجا رسید موفق ساخته می‌شود */
  async charge(businessId: string, amountMinor: number, gatewayRef?: string) {
    const wallet = await this.ensure(businessId);
    const [updated] = await this.prisma.$transaction([
      this.prisma.wallet.update({
        where: { id: wallet.id },
        data: { balanceMinor: { increment: amountMinor } },
      }),
      this.prisma.walletTxn.create({
        data: {
          walletId: wallet.id,
          type: "CHARGE",
          amountMinor,
          ref: gatewayRef ?? `chg_${Date.now().toString(36)}`,
          description: "شارژ کیف پول",
        },
      }),
    ]);
    return updated;
  }

  /** پاداش دعوت (+۵٬۰۰۰ تومان پس از اولین ذخیرهٔ معرفی‌شده) — یک‌بار برای هر معرفی */
  async grantReferralReward(referrerBusinessId: string, newUserId: string) {
    const wallet = await this.ensure(referrerBusinessId);
    // یکتایی پاداش: ref = شناسهٔ کاربرِ تازه‌وارد
    const dup = await this.prisma.walletTxn.findFirst({
      where: { walletId: wallet.id, type: "REFERRAL_REWARD", ref: newUserId },
      select: { id: true },
    });
    if (dup) return false;
    await this.prisma.$transaction([
      this.prisma.wallet.update({
        where: { id: wallet.id },
        data: { balanceMinor: { increment: REFERRAL_REWARD_MINOR } },
      }),
      this.prisma.walletTxn.create({
        data: {
          walletId: wallet.id,
          type: "REFERRAL_REWARD",
          amountMinor: REFERRAL_REWARD_MINOR,
          ref: newUserId,
          description: "پاداش دعوت — اولین ذخیرهٔ معرفی‌شده",
        },
      }),
    ]);
    return true;
  }
}
