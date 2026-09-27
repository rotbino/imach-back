import { Body, Controller, Get, Post, Res, UseGuards } from "@nestjs/common";
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
        scope: body.scope ?? null,
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
