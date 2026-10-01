import { Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { AdminGuard } from "../admin.guard";
import { FilesService, type FileDto } from "../../files/files.service";

/**
 * ─── Admin · file garden ─────────────────────────────────────────────────────
 *   GET    /admin/files/getOrphans          — staged-past-TTL + dangling rows
 *   POST   /admin/files/purgeOrphans        — sweep them all (بدون آرگومان)
 *   POST   /admin/files/purgeOrphans?ids=a,b — sweep a picked subset
 *   DELETE /admin/files/orphans/:id         — reap one
 *   GET    /admin/files/getUsage            — per-user storage rollup
 *
 * The frontend uploads late (never before its model exists), but users still
 * abandon flows — the cleaner is the janitor of last resort
 * (خواسته‌ی کاربر: «دیدن فایل‌های سرگردان و پاک کردن یک‌باره یا تک‌تک»).
 */
@Controller("admin/files")
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminFilesController {
  constructor(private readonly files: FilesService) {}

  @Get("getOrphans")
  async orphans(): Promise<{ staged: FileDto[]; dangling: FileDto[] }> {
    return this.files.listOrphans();
  }

  @Post("purgeOrphans")
  async purge(@Query("ids") ids: string | undefined): Promise<{ deleted: number }> {
    const idList = ids ? ids.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    return this.files.deleteOrphans(idList);
  }

  @Delete("orphans/:id")
  async purgeOne(@Param("id") id: string): Promise<{ deleted: number }> {
    return this.files.deleteOrphans([id]);
  }

  @Get("getUsage")
  async usage() {
    return { items: await this.files.usage() };
  }
}
