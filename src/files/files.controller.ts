import { Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { CurrentLocale, CurrentUser, type AuthUser } from "../common/decorators/auth.decorators";
import { AppError } from "../common/errors/app-error";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { FilesService, RELATED_MODELS, type FileDto, type RelatedModel } from "./files.service";
import type { Locale } from "../common/i18n/i18n";

/**
 * ─── Files API ───────────────────────────────────────────────────────────────
 *   POST   /files/upload?model=&modelId=&key=&description=&replace=   (auth)
 *   GET    /files/getUrl?model=&modelId=&key=                          (public)
 *   GET    /files/getList?model=&modelId=&key=                         (public)
 *   DELETE /files/delete/:id                                           (auth)
 *
 * Uploads are multipart/form-data with a single `file` part. Reads are
 * PUBLIC and return direct cloud URLs — the browser loads bytes straight
 * from Arvan, no token, no proxy (خواسته‌ی کاربر: گت و سریع).
 */
@Controller("files")
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post("upload")
  @UseGuards(JwtAuthGuard)
  async upload(
    @Req() req: FastifyRequest,
    @Query("model") model: string,
    @Query("modelId") modelId: string | undefined,
    @Query("key") key: string | undefined,
    @Query("description") description: string | undefined,
    @Query("replace") replace: string | undefined,
    @CurrentUser() user: AuthUser,
    @CurrentLocale() locale: Locale
  ): Promise<FileDto> {
    if (!(RELATED_MODELS as readonly string[]).includes(model)) {
      throw AppError.badRequest("model must be User | Business | Listing", "BAD_MODEL");
    }
    const { fields, file } = await this.files.readMultipart(req);
    const fieldKey = key || fields.fieldKey;
    if (!fieldKey || fieldKey.length > 40 || !/^[a-zA-Z0-9_-]+$/.test(fieldKey)) {
      throw AppError.badRequest("key is required (letters, digits, - and _)", "BAD_KEY");
    }
    const replaceFlag = replace ?? fields.replace;
    return this.files.upload(
      user,
      {
        model: model as RelatedModel,
        modelId: modelId || fields.modelId || null,
        fieldKey,
        description: description ?? fields.description,
        replace: replaceFlag !== "false" && replaceFlag !== "0",
      },
      file,
      locale
    );
  }

  @Get("getUrl")
  async getUrl(@Query("model") model: string, @Query("modelId") modelId: string, @Query("key") key: string): Promise<FileDto> {
    return this.files.getUrl(model, modelId, key);
  }

  @Get("getList")
  async getList(@Query("model") model: string, @Query("modelId") modelId: string, @Query("key") key: string | undefined): Promise<{ items: FileDto[] }> {
    return { items: await this.files.listFiles(model, modelId, key) };
  }

  @Delete("delete/:id")
  @UseGuards(JwtAuthGuard)
  async remove(@Param("id") id: string, @CurrentUser() user: AuthUser, @CurrentLocale() locale: Locale): Promise<{ ok: true }> {
    return this.files.remove(user, id, locale);
  }
}
