import { Body, Controller, Get, Post, Res, UseGuards } from "@nestjs/common";
import { createHash } from "crypto";
import type { FastifyReply } from "fastify";
import { CacheService } from "../common/cache/cache.module";
import { CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { AppError } from "../common/errors/app-error";
import { PrismaService } from "../common/prisma/prisma.module";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

export interface UnitDto {
  id: string;
  key: string;
  nameFa: string;
  nameEn: string;
  baseUnitKey: string | null;
  containsQty: number | null;
  qtyIsFixed: boolean;
  scope: string | null;
  isActive: boolean;
}

@Controller("units")
export class UnitsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  @Get("list")
  async list(@Res({ passthrough: true }) reply: FastifyReply) {
    const { value, hit } = await this.cache.wrap(
      "units:list",
      { ttlMs: 5 * 60_000, tags: ["goods"] },
      async () => {
        return this.prisma.unit.findMany({
          where: { isActive: true },
          orderBy: [{ scope: "asc" }, { key: "asc" }],
        });
      },
    );
    reply.header("x-cache", hit ? "HIT" : "MISS");
    return value as UnitDto[];
  }

  /**
   * مدل واحد (حکم مالک ۱۰۲۶ — «یک‌بار برای همیشه»): بسته‌بندی‌های شخصی کاربر
   * مثل برندها عمومی می‌شوند — find-or-create روی جدول Unit، تا کاربران بعدی
   * «کارتن ۱۰۰ عددی» را از لیست انتخاب کنند نه اینکه دوباره بسازند.
   *
   * • هر فراخوانی idempotent است: نام + پایه + تعدادِ یکسان → همان ردیف.
   * • پایه باید ریشه باشد (PIECE/KILOGRAM/…) — بسته‌بندیِ رویِ بسته‌بندی ممنوع.
   * • qtyIsFixed=true: تعداد جزو هویت «کارتن ۱۰۰ عددی» است و ثابت می‌ماند.
   */
  @Post("ensure")
  @UseGuards(JwtAuthGuard)
  async ensure(
    @Body() body: { nameFa: string; baseUnitKey: string; containsQty: number },
    @CurrentUser() user: AuthUser,
  ) {
    const name = (body.nameFa ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (name.length < 2) {
      throw AppError.badRequest("نام بسته‌بندی را کامل بنویس — مثلاً «گونی ۷۰ کیلویی»", "BAD_NAME");
    }
    const qty = Number(body.containsQty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 1_000_000) {
      throw AppError.badRequest("تعداد در بسته باید عددی بین ۱ تا یک میلیون باشد", "BAD_QTY");
    }
    const baseKey = (body.baseUnitKey ?? "").trim().toUpperCase();
    const base = await this.prisma.unit.findUnique({ where: { key: baseKey } });
    if (!base || !base.isActive) {
      throw AppError.badRequest("واحد پایهٔ نامعتبر", "BAD_BASE_UNIT");
    }
    // پایه باید خودش ریشه باشد — زنجیرهٔ بسته‌بندی روی بسته‌بندی نه (مدل مالک:
    // «کیسه بزرگ ۶۰ کیلویی» همان یک بسته با تعداد ۶۰ است، نه تودرتو)
    if (base.baseUnitKey) {
      throw AppError.badRequest("بسته‌بندی باید مستقیم روی واحد مصرف‌کننده باشد", "NESTED_UNIT");
    }

    // ۱) دوقلوی هم‌نام (نام + پایه + تعداد) → همان ردیف؛ سید و ساخت کاربر یکسان‌اند
    const twin = await this.prisma.unit.findFirst({
      where: { nameFa: name, baseUnitKey: base.key, containsQty: qty, isActive: true },
    });
    if (twin) return twin as UnitDto;

    // ۲) کلید قطعی — هم‌زمانی و تکرار دوباره همان ثبت
    const key = (
      `UP_${base.key}_${qty}_` +
      createHash("md5").update(`${name}|${base.key}|${qty}`).digest("hex").slice(0, 10)
    ).toUpperCase();
    const existing = await this.prisma.unit.findUnique({ where: { key } });
    if (existing) return existing as UnitDto;

    const created = await this.prisma.unit.create({
      data: {
        key,
        nameFa: name,
        // نام لاتین فعلاً همان فارسی است — باغبانی ادمین بعداً پرش می‌کند
        nameEn: name,
        baseUnitKey: base.key,
        containsQty: qty,
        qtyIsFixed: true,
        scope: "wholesale",
        creatorRole: "USER",
        createdById: user.id,
        isActive: true,
      },
    });
    this.cache.invalidateTag("goods");
    return created as UnitDto;
  }

  @Post("create")
  @UseGuards(JwtAuthGuard)
  async create(
    @Body() body: {
      key: string;
      nameFa: string;
      nameEn: string;
      baseUnitKey?: string | null;
      containsQty?: number | null;
      qtyIsFixed?: boolean;
      scope?: string | null;
    },
    @CurrentUser() user: AuthUser,
  ) {
    if (user.role !== "ADMIN") throw AppError.forbidden("فقط ادمین می‌تواند واحد اضافه کند");
    if (!body.key?.trim() || !body.nameFa?.trim() || !body.nameEn?.trim()) {
      throw AppError.badRequest("key, nameFa, nameEn الزامی است", "MISSING_FIELDS");
    }
    const key = body.key.trim().toUpperCase();
    const existing = await this.prisma.unit.findUnique({ where: { key } });
    if (existing) throw AppError.badRequest("این کلید واحد قبلاً ثبت شده", "DUPLICATE_KEY");

    const created = await this.prisma.unit.create({
      data: {
        key,
        nameFa: body.nameFa.trim(),
        nameEn: body.nameEn.trim(),
        baseUnitKey: body.baseUnitKey?.trim().toUpperCase() || null,
        containsQty: body.containsQty ?? null,
        qtyIsFixed: body.qtyIsFixed ?? false,
        scope: body.scope ?? undefined,
        isActive: true,
      },
    });
    this.cache.invalidateTag("goods");
    return created as UnitDto;
  }

  @Post("update")
  @UseGuards(JwtAuthGuard)
  async update(
    @Body() body: {
      id: string;
      nameFa?: string;
      nameEn?: string;
      baseUnitKey?: string | null;
      containsQty?: number | null;
      qtyIsFixed?: boolean;
      scope?: string | null;
      isActive?: boolean;
    },
    @CurrentUser() user: AuthUser,
  ) {
    if (user.role !== "ADMIN") throw AppError.forbidden("فقط ادمین می‌تواند واحد را ویرایش کند");
    if (!body.id || !/^[0-9a-fA-F]{24}$/.test(body.id)) {
      throw AppError.badRequest("id معتبر نیست", "BAD_ID");
    }
    const data: Record<string, unknown> = {};
    if (typeof body.nameFa === "string" && body.nameFa.trim()) data.nameFa = body.nameFa.trim();
    if (typeof body.nameEn === "string" && body.nameEn.trim()) data.nameEn = body.nameEn.trim();
    if (body.baseUnitKey !== undefined) data.baseUnitKey = body.baseUnitKey?.trim().toUpperCase() || null;
    if (body.containsQty !== undefined) data.containsQty = body.containsQty;
    if (body.qtyIsFixed !== undefined) data.qtyIsFixed = body.qtyIsFixed;
    if (body.scope !== undefined) data.scope = body.scope;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    if (Object.keys(data).length === 0) throw AppError.badRequest("هیچ فیلدی ارسال نشده", "NO_FIELDS");

    const updated = await this.prisma.unit.update({ where: { id: body.id }, data });
    this.cache.invalidateTag("goods");
    return updated as UnitDto;
  }
}
