import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import { AppError } from "../common/errors/app-error";
import { CurrentLocale, CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PrismaService } from "../common/prisma/prisma.module";
import type { Locale } from "../common/i18n/i18n";
import { SyncContactsDto } from "./dto/contacts.dto";

/** ObjectId hex guard — keeps invalid params away from Prisma. */
const isObjectId = (v: string | undefined): v is string => /^[a-f\d]{24}$/i.test(v ?? "");

/**
 * نرمال‌سازی موبایل ایرانی — همه‌ی صورت‌های رایج به 09xxxxxxxxx:
 * 09123456789 · 9123456789 · +989123456789 · 989123456789 · 00989123456789
 * خروجی null یعنی قابل نجات نیست و سمت کلاینت نادیده گرفته می‌شود.
 */
export function normalizeIrMobile(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("0098")) d = d.slice(4);
  else if (d.startsWith("98") && d.length === 12) d = d.slice(2);
  if (d.startsWith("9") && d.length === 10) d = `0${d}`;
  return /^09\d{9}$/.test(d) ? d : null;
}

/**
 * گیت اشتراک مخاطبین — موتور شبکه‌سازی iMach:
 * کاربر با اجازه‌ی خودش دفترچه‌ی تلفنش را می‌سپارد؛ ما شبکه‌ی خصوصی‌اش را
 * می‌دانیم و او می‌بیند چه کسی عضو است و چه کسی نیست. برای هر مخاطب یک
 * اقدام زمینه‌ای: «ارسال کاتالوگ» (بازوی فروش) یا «ارسال لیست خرید» (بازوی خرید).
 *
 * عضویت ذخیره نمی‌شود — در زمان خواندن با User.phone تطبیق می‌خورد تا با
 * عضو شدنِ دیرهنگام‌ها هم پرچم «عضو iMach» تازه بماند.
 */
@Controller("contacts")
@UseGuards(JwtAuthGuard)
export class ContactsController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * همگام‌سازی دسته‌ای مخاطبین — آپسرت با کلید (userId, phone).
   * هر فراخوان حداکثر ۵۰۰ مخاطب؛ شماره‌های خراب بی‌سروصدا رد می‌شوند و
   * شمارش‌شان در پاسخ برمی‌گردد.
   */
  @Post("sync")
  @HttpCode(HttpStatus.OK)
  async sync(@Body() body: SyncContactsDto, @CurrentUser() user: AuthUser) {
    const seen = new Map<string, string>();
    for (const item of body.contacts) {
      const phone = normalizeIrMobile(item.phone ?? "");
      if (!phone) continue;
      const name = (item.name ?? "").trim().slice(0, 80) || phone;
      if (!seen.has(phone)) seen.set(phone, name);
    }

    if (seen.size > 0) {
      await this.prisma.$transaction((tx) =>
        Promise.all(
          [...seen.entries()].map(([phone, name]) =>
            tx.contact.upsert({
              where: { userId_phone: { userId: user.id, phone } },
              create: { userId: user.id, name, phone },
              update: { name },
            })
          )
        )
      );
    }

    return { saved: seen.size, received: body.contacts.length };
  }

  /**
   * مخاطبین کاربر جاری + وضعیت عضویت زنده + کسب‌وکار عضو (برای لینک دادن).
   * اعضا اول، بعد ترتیب الفبای فارسی.
   */
  @Get("getContacts")
  async getContacts(@CurrentUser() user: AuthUser) {
    const rows = await this.prisma.contact.findMany({
      where: { userId: user.id },
      orderBy: { name: "asc" },
      take: 2000,
    });

    const phones = [...new Set(rows.map((r) => r.phone))];
    const members = phones.length
      ? await this.prisma.user.findMany({
          where: { phone: { in: phones }, id: { not: user.id } },
          select: {
            id: true,
            phone: true,
            businesses: {
              select: { id: true, slug: true, name: true, city: true },
              orderBy: { createdAt: "asc" as const },
              take: 1,
            },
          },
        })
      : [];
    const memberByPhone = new Map(members.map((m) => [m.phone, m.businesses[0] ?? null]));

    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      member: memberByPhone.get(r.phone) ?? null,
      lastInvitedAt: r.lastInvitedAt,
    }));
    items.sort((a, b) => (b.member ? 1 : 0) - (a.member ? 1 : 0) || a.name.localeCompare(b.name, "fa"));
    return items;
  }

  /** ثبت دعوت — ممیزی حلقه‌ی رشد؛ «این مخاطب دعوت شده» */
  @Post("invite/:id")
  @HttpCode(HttpStatus.OK)
  async invite(@Param("id") id: string, @CurrentUser() user: AuthUser, @CurrentLocale() _locale: Locale) {
    if (!isObjectId(id)) throw AppError.notFound("Contact not found");
    const contact = await this.prisma.contact.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (!contact) throw AppError.notFound("Contact not found");
    await this.prisma.contact.update({ where: { id: contact.id }, data: { lastInvitedAt: new Date() } });
    return { ok: true };
  }
}
