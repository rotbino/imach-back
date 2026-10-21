import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { AppError } from "../common/errors/app-error";
import { PrismaService } from "../common/prisma/prisma.module";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { WalletService } from "./wallet.service";
import { SettingsService } from "../settings/settings.service";

class GetWalletDto {
  @IsString() businessId!: string;
}

class ChargeWalletDto {
  @IsString() businessId!: string;
  /** مبلغ به تومان — سرور خودش به minor ریال تبدیل می‌کند */
  @IsInt() @Min(10_000) @Max(500_000_000) amountToman!: number;
  @IsOptional() @IsString() gatewayRef?: string;
}

/**
 * طرح ۸ — کیف پول تومانی (U08/U12). کیف فقط در لحظهٔ مصرف دیده می‌شود
 * (قانون تشنگی): دکمهٔ شارژ در عمق پروفایل فروش و شیتِ کمپین، نه در
 * ناوبری. واحد پول واقعی کشور است — واژهٔ «اعتبار» وجود ندارد.
 */
@Controller("wallet")
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallets: WalletService,
    private readonly settings: SettingsService,
  ) {}

  /** موجودی + ۳۰ تراکنش آخر — نمایش تومانی سمت فرانت انجام می‌شود */
  @Get("get")
  async get(@Query() query: GetWalletDto, @CurrentUser() user: AuthUser) {
    await this.assertMine(query.businessId, user);
    const wallet = await this.wallets.ensure(query.businessId);
    return {
      balanceMinor: wallet.balanceMinor,
      txns: wallet.txns.map((t) => ({
        id: t.id,
        type: t.type,
        amountMinor: t.amountMinor,
        ref: t.ref,
        description: t.description,
        createdAt: t.createdAt,
      })),
    };
  }

  /**
   * شارژ کیف — اتصال درگاه واقعی (زرین‌پال/…) در فاز بعدی؛ فعلاً همان
   * قرارداد پاسخ درگاه پیاده شده: مبلغ تاییدشده + رسید. حداقل ۱۰ هزار
   * تومان (۱۰ فاکتور نمایش کمپین) تا دکمهٔ شارژ بی‌دلیل فشرده نشود.
   */
  @Post("charge")
  async charge(@Body() body: ChargeWalletDto, @CurrentUser() user: AuthUser) {
    // فاز ۸ — سوییچ ادمین: پرداخت فقط ایران؛ خاموش = مسیر دعوت/فعالیت
    if (!(await this.settings.paymentsEnabled())) {
      throw AppError.forbidden(
        "پرداخت درگاه فعلاً غیرفعال است — با دعوت از همکاران اعتبار بگیر"
      );
    }
    await this.assertMine(body.businessId, user);
    const amountMinor = body.amountToman * 10; // تومان → ریال
    const wallet = await this.wallets.charge(body.businessId, amountMinor, body.gatewayRef);
    return {
      ok: true,
      balanceMinor: wallet.balanceMinor,
      receipt: body.gatewayRef ?? `chg_${Date.now().toString(36)}`,
    };
  }

  /** مالکیت کیف — شارژ کیفِ دیگری ممنوع (پاداش/انتقال پول نیست) */
  private async assertMine(businessId: string, user: AuthUser) {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, ownerId: true },
    });
    if (!business || business.ownerId !== user.id) {
      throw AppError.badRequest("این کیف پول مال شما نیست", "WALLET_NOT_YOURS");
    }
  }
}
