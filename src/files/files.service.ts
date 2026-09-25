/**
 * ─── Files service ───────────────────────────────────────────────────────────
 * One polymorphic File table decorates every entity that needs images
 * (خواسته‌ی کاربر): User avatar, Business logo, Listing gallery, licenses,
 * awards — the client picks the slot with fieldKey and reads it back with the
 * same key. Bytes live on the configured storage driver (Arvan today).
 *
 * Anti-orphan discipline (خواسته‌ی کاربر):
 *   • Frontend uploads only when the target model exists (or at submit time —
 *     never speculatively while the user is still typing the form).
 *   • Replace flows upload FIRST, delete the previous record only after the
 *     new bytes are safe — the old picture never disappears because an upload
 *     failed.
 *   • Storage deletes are best-effort; the DB row is the source of truth and
 *     the admin orphan cleaner reaps any leftover bytes' rows + staged junk.
 *
 * Reads return PUBLIC direct URLs — clients load bytes straight from the
 * cloud, no token, no proxying through this API.
 */

import { Injectable, HttpStatus, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { CacheService } from "../common/cache/cache.module";
import { storage, FILES_STAGING_TTL_DAYS } from "../common/config/env";
import { AppError } from "../common/errors/app-error";
import { assertBusinessOwner } from "../common/guards";
import { t, type Locale } from "../common/i18n/i18n";
import { PrismaService } from "../common/prisma/prisma.module";
import type { AuthUser } from "../common/decorators/auth.decorators";
import { buildStorage, type StorageDriver } from "./storage";

/** Entities files may decorate — the client cannot invent others. */
export const RELATED_MODELS = ["User", "Business", "Listing"] as const;
export type RelatedModel = (typeof RELATED_MODELS)[number];

/** Client-supplied ObjectIds are validated before touching Prisma (a 24-hex check turns what would be a 500 into a clean 404). */
const OID_RE = /^[0-9a-fA-F]{24}$/;
function oidOr404(id: string | null | undefined, what: string): string {
  if (!id || !OID_RE.test(id)) throw AppError.notFound(t("fa", "files.notFound", "فایل یافت نشد"));
  return id;
}

const ALLOWED_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "application/pdf",
] as const;

/** Proper folder names — "businesses", never "businesss" (naive plural). */
const MODEL_FOLDER: Record<RelatedModel, string> = {
  User: "users",
  Business: "businesses",
  Listing: "listings",
};

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "application/pdf": "pdf",
};

export interface ProcessedImage {
  main: Buffer;
  mainMime: string;
  mainExt: string;
  thumb: Buffer | null;
  width: number;
  height: number;
}

/** Public shape returned to clients — never leak storage keys. */
export interface FileDto {
  id: string;
  fieldKey: string;
  url: string;
  thumbUrl: string | null;
  description: string | null;
  size: number;
  mimeType: string;
  createdAt: Date;
}

@Injectable()
export class FilesService implements OnModuleInit, OnModuleDestroy {
  private readonly driver: StorageDriver;
  private reaperTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService
  ) {
    this.driver = buildStorage(); // fail fast at boot on missing credentials
  }

  /**
   * ضدسیستم‌فایل‌کثیف (خواسته‌ی کاربر: «اصلا نباید فایل اضافی در سرور بمونه»):
   * ردیف‌های staged (relatedId=null) که تا سقف TTL به مدلی نچسبیده‌اند — به
   * همراه بایت‌های‌شان — خودکار حذف می‌شوند؛ یک بار دیرهنگامِ بعد از بوت و
   * بعد هر ۶ ساعت. حذف idempotent است، پس چند اینستنس هم تداخل نمی‌کنند.
   */
  onModuleInit(): void {
    const bootDelay = setTimeout(() => {
      void this.reapStaged();
    }, 45_000);
    bootDelay.unref?.();
    this.reaperTimer = setInterval(() => {
      void this.reapStaged();
    }, 6 * 60 * 60 * 1000);
    this.reaperTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.reaperTimer) clearInterval(this.reaperTimer);
  }

  /** حذف کامل (بایت + ردیف) آپلودهای stagged رسوب‌کرده — خودکار و بی‌صدا. */
  private async reapStaged(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - FILES_STAGING_TTL_DAYS * 86_400_000);
      const rows = await this.prisma.file.findMany({
        where: { relatedId: null, createdAt: { lt: cutoff } },
        select: { id: true, storageKey: true, thumbStorageKey: true },
        take: 500,
      });
      for (const f of rows) {
        try {
          await this.driver.delete(f.storageKey);
          if (f.thumbStorageKey) await this.driver.delete(f.thumbStorageKey).catch(() => undefined);
        } catch {
          /* bytes best-effort — row removal is the contract */
        }
        await this.prisma.file.delete({ where: { id: f.id } }).catch(() => undefined);
      }
      if (rows.length > 0) {
        // ثانیه‌ای بعد، دسته‌ی بعدی (تخلیه‌ی تدریجی انباشتگاه‌های بزرگ)
        const next = setTimeout(() => void this.reapStaged(), 5_000);
        next.unref?.();
      }
    } catch {
      /* the reaper must never wake the users up */
    }
  }

  // ─── Image pipeline (sharp) ────────────────────────────────────────────────

  /**
   * Resize/compress once, store twice (main + thumbnail) — خواسته‌ی کاربر:
   * «فشرده یا تغییر سایز … به دو صورت فایل بزرگ و فایل تامبنیل». Thumbnails
   * feed lists and small tiles; the main image feeds detail views.
   */
  private async processFile(buffer: Buffer, mime: string): Promise<ProcessedImage> {
    if (!mime.startsWith("image/")) {
      // video/pdf pass through untouched (10 MB cap already enforced)
      return { main: buffer, mainMime: mime, mainExt: MIME_EXT[mime] ?? "bin", thumb: null, width: 0, height: 0 };
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sharp = require("sharp") as typeof import("sharp").default;
      const meta = await sharp(buffer).metadata();
      const hasAlpha = !!meta.hasAlpha;
      const fmt = hasAlpha ? "png" : "jpeg";

      const mainPipeline = sharp(buffer).rotate(); // respect EXIF orientation
      const main = await mainPipeline
        .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
        .toFormat(hasAlpha ? "png" : "jpeg", hasAlpha ? { compressionLevel: 9 } : { quality: 82, mozjpeg: true })
        .toBuffer();

      const thumb = await sharp(buffer)
        .rotate()
        .resize(400, 400, { fit: "inside", withoutEnlargement: true })
        .toFormat(hasAlpha ? "png" : "jpeg", hasAlpha ? { compressionLevel: 9 } : { quality: 78, mozjpeg: true })
        .toBuffer();

      const outMeta = await sharp(main).metadata();
      return { main, mainMime: hasAlpha ? "image/png" : "image/jpeg", mainExt: fmt === "png" ? "png" : "jpg", thumb, width: outMeta.width ?? 0, height: outMeta.height ?? 0 };
    } catch {
      // Corrupt image or unsupported format — keep the original bytes rather
      // than rejecting (sharp handles jpeg/png/webp/gif/tiff broadly).
      return { main: buffer, mainMime: mime, mainExt: MIME_EXT[mime] ?? "bin", thumb: null, width: 0, height: 0 };
    }
  }

  // ─── Keys & folders ────────────────────────────────────────────────────────

  /**
   * Folder architecture (per-entity, backup-friendly):
   *   users/{userId}/avatar|staging/… · businesses/{businessId}/logo/… ·
   *   listings/{listingId}/gallery/…
   * Object stores are flat — prefixes cost nothing at millions scale and make
   * per-entity backup + lifecycle rules trivial. Per-USER usage is answered
   * from the DB (ownerId index), never by scanning storage.
   */
  private keyFor(ownerId: string, model: RelatedModel, modelId: string | null, fieldKey: string, ext: string): string {
    const stamp = Date.now().toString(36);
    const rand = randomBytes(5).toString("hex");
    const folder = modelId
      ? `${MODEL_FOLDER[model]}/${modelId}`
      : `${MODEL_FOLDER.User}/${ownerId}/staging`;
    return `${folder}/${fieldKey}/${stamp}-${rand}.${ext}`;
  }

  // ─── Upload ────────────────────────────────────────────────────────────────

  /**
   * Resolve WHERE the file attaches and WHO may write there. Returns the
   * validated target. User → self only; Business → owner via
   * assertBusinessOwner; Listing → owner of the parent business.
   */
  private async resolveTarget(user: AuthUser, model: RelatedModel, modelId: string | null, locale: Locale) {
    if (!modelId) return null; // staged upload — no entity to check yet
    if (model === "User") {
      if (modelId !== user.id && user.role !== "ADMIN") {
        throw new AppError("FORBIDDEN", t(locale, "files.forbidden", "شما اجازه‌ی این کار را ندارید"), HttpStatus.FORBIDDEN);
      }
      return { id: modelId };
    }
    if (model === "Business") {
      return assertBusinessOwner(this.prisma, user, oidOr404(modelId, "Business not found"), locale);
    }
    // Listing
    const listing = await this.prisma.listing.findUnique({ where: { id: oidOr404(modelId, "Listing not found") }, select: { id: true, businessId: true } });
    if (!listing) throw AppError.notFound("Listing not found");
    await assertBusinessOwner(this.prisma, user, listing.businessId, locale);
    return listing;
  }

  /**
   * Parse a multipart request into fields + file buffer (Fastify).
   *
   * ترتیب‌نسبیِ فیلدها نباید مهم باشد: مرورگرها FormData را به همان ترتیبِ
   * append می‌فرستند و بعضی کلاینت‌ها فایل را اول می‌گذارند، بعضی آخر.
   * req.file() فقط فیلدهای «قبل از فایل» را می‌دهد و بقیه را می‌باخت —
   * ریشه‌ی باگِ «عکس آپلود می‌شود ولی هیچ‌وقت به کالا نمی‌چسبد» و
   * «ویرایش، عکس قبلی را برای همیشه پاک می‌کرد» (replace گم می‌شد).
   * اینجا کل استریم با req.parts() مصرف می‌شود تا modelId/replace/description
   * از هر موقعیتی بیایند، گرفته شوند (خواسته‌ی کاربر: رکورد بی‌صاحب ممنوع).
   */
  async readMultipart(req: FastifyRequest): Promise<{ fields: Record<string, string>; file: { buffer: Buffer; mimetype: string; filename: string } }> {
    const fastifyReq = req as FastifyRequest & {
      parts: (opts?: unknown) => AsyncIterable<MultipartPart>;
      isMultipart: () => boolean;
    };
    if (!fastifyReq.isMultipart()) {
      throw AppError.badRequest(t("fa", "files.notMultipart", "فایل ارسال نشده است"), "NOT_MULTIPART");
    }

    const fields: Record<string, string> = {};
    let file: { buffer: Buffer; mimetype: string; filename: string } | null = null;
    try {
      for await (const part of fastifyReq.parts()) {
        if (part.type === "file") {
          if (file) {
            // پلاگین files:1 است؛ محض احتیاط، فایل اضافه را هدر نده — ببلع
            await part.toBuffer().catch(() => undefined);
            continue;
          }
          const buffer = await part.toBuffer();
          file = { buffer, mimetype: part.mimetype, filename: part.filename };
        } else if (typeof part.value === "string") {
          fields[part.fieldname] = part.value;
        }
      }
    } catch {
      // بدنه‌ی بریده (PrematureClose) = آپلود ناقص — رکورد نیم‌بند نساز
      throw AppError.badRequest(
        t("fa", "files.truncated", "آپلود ناقص بود — دوباره تلاش کنید"),
        "MULTIPART_TRUNCATED"
      );
    }
    if (!file) {
      throw AppError.badRequest(t("fa", "files.notMultipart", "فایل ارسال نشده است"), "NOT_MULTIPART");
    }
    return { fields, file };
  }

  async upload(
    user: AuthUser,
    input: { model: RelatedModel; modelId?: string | null; fieldKey: string; description?: string | null; replace?: boolean },
    file: { buffer: Buffer; mimetype: string; filename: string },
    locale: Locale
  ): Promise<FileDto> {
    if (file.buffer.length > storage.MAX_FILE_SIZE) {
      throw AppError.badRequest(
        t(locale, "files.tooLarge", `حجم فایل نباید از ${Math.floor(storage.MAX_FILE_SIZE / 1024 / 1024)} مگابایت بیشتر باشد`),
        "FILE_TOO_LARGE"
      );
    }
    if (!(ALLOWED_MIME as readonly string[]).includes(file.mimetype)) {
      throw AppError.badRequest(t(locale, "files.badType", "این نوع فایل پشتیبانی نمی‌شود"), "FILE_TYPE_NOT_ALLOWED");
    }

    const modelId = input.modelId || null;
    await this.resolveTarget(user, input.model, modelId, locale);

    const processed = await this.processFile(file.buffer, file.mimetype);
    const key = this.keyFor(user.id, input.model, modelId, input.fieldKey, processed.mainExt);
    const url = await this.driver.put(key, processed.main, processed.mainMime);

    let thumbUrl: string | null = null;
    let thumbKey: string | null = null;
    if (processed.thumb) {
      thumbKey = `${key}.thumb.jpg`; // always jpeg — thumbs feed <img> tiles
      thumbUrl = await this.driver.put(thumbKey, processed.thumb, "image/jpeg").catch(() => null);
      if (!thumbUrl) thumbKey = null;
    }

    const row = await this.prisma.file.create({
      data: {
        ownerId: user.id,
        relatedModel: input.model,
        relatedId: modelId,
        fieldKey: input.fieldKey,
        description: input.description?.trim().slice(0, 300) || null,
        name: file.filename.slice(0, 200),
        mimeType: processed.mainMime,
        size: processed.main.length,
        url,
        thumbUrl,
        storageKey: key,
        thumbStorageKey: thumbKey,
        metadata: { originalSize: file.buffer.length, width: processed.width, height: processed.height },
      },
    });

    // Replace semantics (خواسته‌ی کاربر): آپلود جدید اول، بعد حذف قبلی‌ها —
    // single-file slots (avatar/logo/…) never accumulate rows; galleries opt
    // out with replace=false.
    if (input.replace !== false && modelId) {
      await this.removeSiblings(input.model, modelId, input.fieldKey, row.id);
    }
    await this.bustCaches(input.model, modelId);

    return this.toDto(row);
  }

  /** Delete every other file in the same slot (storage best-effort). */
  private async removeSiblings(model: RelatedModel, modelId: string, fieldKey: string, keepId: string): Promise<void> {
    const stale = await this.prisma.file.findMany({
      where: { relatedModel: model, relatedId: modelId, fieldKey, id: { not: keepId } },
      select: { id: true, storageKey: true, thumbStorageKey: true },
    });
    for (const f of stale) {
      try {
        await this.driver.delete(f.storageKey);
        if (f.thumbStorageKey) await this.driver.delete(f.thumbStorageKey).catch(() => undefined);
      } catch {
        /* storage cleanup is best-effort — row removal is what matters */
      }
      await this.prisma.file.delete({ where: { id: f.id } }).catch(() => undefined);
    }
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  toDto(row: {
    id: string;
    fieldKey: string;
    url: string;
    thumbUrl: string | null;
    description: string | null;
    size: number;
    mimeType: string;
    createdAt: Date;
  }): FileDto {
    return {
      id: row.id,
      fieldKey: row.fieldKey,
      url: row.url,
      thumbUrl: row.thumbUrl,
      description: row.description,
      size: row.size,
      mimeType: row.mimeType,
      createdAt: row.createdAt,
    };
  }

  /** Public read by slot — the endpoint the client uses before <img src>. */
  async getUrl(model: string, modelId: string, key: string): Promise<FileDto> {
    if (!(RELATED_MODELS as readonly string[]).includes(model)) throw AppError.badRequest("bad model", "BAD_MODEL");
    if (!OID_RE.test(modelId)) throw AppError.notFound(t("fa", "files.notFound", "فایل یافت نشد"));
    const row = await this.prisma.file.findFirst({
      where: { relatedModel: model, relatedId: modelId, fieldKey: key },
      orderBy: { createdAt: "desc" },
    });
    if (!row) throw AppError.notFound(t("fa", "files.notFound", "فایل یافت نشد"));
    return this.toDto(row);
  }

  /** Public list of a slot (galleries) — or the whole entity when key omitted. */
  async listFiles(model: string, modelId: string, key?: string): Promise<FileDto[]> {
    if (!(RELATED_MODELS as readonly string[]).includes(model)) throw AppError.badRequest("bad model", "BAD_MODEL");
    if (!OID_RE.test(modelId)) return [];
    const rows = await this.prisma.file.findMany({
      where: { relatedModel: model, relatedId: modelId, ...(key ? { fieldKey: key } : {}) },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    return rows.map((r) => this.toDto(r));
  }

  /**
   * Batch gallery map for list payloads (catalog tiles, my listings) — one
   * `in` query for the whole page, not one per row.
   */
  async galleryMap(listingIds: string[]): Promise<Map<string, FileDto[]>> {
    const map = new Map<string, FileDto[]>();
    if (listingIds.length === 0) return map;
    const rows = await this.prisma.file.findMany({
      where: { relatedModel: "Listing", relatedId: { in: listingIds }, fieldKey: "gallery" },
      orderBy: { createdAt: "asc" },
      take: 500,
    });
    for (const r of rows) {
      const list = map.get(r.relatedId!) ?? [];
      list.push(this.toDto(r));
      map.set(r.relatedId!, list);
    }
    return map;
  }

  // ─── Delete ────────────────────────────────────────────────────────────────

  /** Frontend «remove» (e.g. profile X) — owner, entity owner, or admin. */
  async remove(user: AuthUser, fileId: string, locale: Locale): Promise<{ ok: true }> {
    oidOr404(fileId, "File not found");
    const row = await this.prisma.file.findUnique({ where: { id: fileId } });
    if (!row) throw AppError.notFound(t(locale, "files.notFound", "فایل یافت نشد"));

    let allowed = user.role === "ADMIN" || row.ownerId === user.id;
    if (!allowed && row.relatedModel === "Business" && row.relatedId) {
      try {
        await assertBusinessOwner(this.prisma, user, row.relatedId, locale);
        allowed = true;
      } catch {
        /* not the business owner */
      }
    }
    if (!allowed && row.relatedModel === "Listing" && row.relatedId) {
      const listing = await this.prisma.listing.findUnique({ where: { id: row.relatedId }, select: { businessId: true } });
      if (listing) {
        await assertBusinessOwner(this.prisma, user, listing.businessId, locale);
        allowed = true;
      }
    }
    if (!allowed) {
      throw new AppError("FORBIDDEN", t(locale, "files.forbidden", "شما اجازه‌ی این کار را ندارید"), HttpStatus.FORBIDDEN);
    }

    try {
      await this.driver.delete(row.storageKey);
      if (row.thumbStorageKey) await this.driver.delete(row.thumbStorageKey).catch(() => undefined);
    } catch {
      /* best-effort — the DB row is authoritative */
    }
    await this.prisma.file.delete({ where: { id: row.id } });
    await this.bustCaches(row.relatedModel as RelatedModel, row.relatedId);
    return { ok: true };
  }

  // ─── Cache coherence ───────────────────────────────────────────────────────

  /**
   * Logo/gallery/avatar swaps must reach the cached vitrine IMMEDIATELY
   * (خواسته‌ی کاربر: «بلافاصله بعد از ثبت کالا عکس در کاتالوگ دیده بشه»).
   * The public profile is keyed+tagged by slug, everything else by id — both
   * go, plus the market boards that may carry the same picture.
   */
  private async bustCaches(model: RelatedModel, modelId: string | null): Promise<void> {
    try {
      const businessId =
        model === "Business" && modelId
          ? modelId
          : model === "Listing" && modelId
            ? (await this.prisma.listing.findUnique({ where: { id: modelId }, select: { businessId: true } }))?.businessId
            : null;
      if (!businessId) return;
      const biz = await this.prisma.business.findUnique({ where: { id: businessId }, select: { slug: true } });
      if (biz) this.cache.invalidateTag(`business:slug:${biz.slug}`);
      this.cache.invalidateTag(`business:${businessId}`);
      this.cache.invalidateTag(`market:board:${businessId}`);
      this.cache.invalidateTag(`market:home:${businessId}`);
      this.cache.invalidateTag(`market:sugg:${businessId}`);
      this.cache.invalidateTag(`market:ssugg:${businessId}`);
    } catch {
      /* non-blocking */
    }
  }

  // ─── Admin: orphans & usage ────────────────────────────────────────────────

  /**
   * Orphans = rows whose entity is gone (dangling) or never finished
   * attaching (staged past TTL). Dangling checks run bounded (recent 1000) so
   * the endpoint stays cheap at millions of rows.
   */
  async listOrphans(limit = 100) {
    const cutoff = new Date(Date.now() - FILES_STAGING_TTL_DAYS * 86_400_000);

    const staged = await this.prisma.file.findMany({
      where: { relatedId: null, createdAt: { lt: cutoff } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const recent = await this.prisma.file.findMany({
      where: { relatedId: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 1000,
      select: { id: true, relatedModel: true, relatedId: true, fieldKey: true, url: true, thumbUrl: true, size: true, mimeType: true, description: true, createdAt: true, storageKey: true, thumbStorageKey: true, ownerId: true },
    });

    const dangling: typeof recent = [];
    const businessIds = new Set<string>();
    const listingIds = new Set<string>();
    const userIds = new Set<string>();
    for (const f of recent) {
      if (f.relatedModel === "Business") businessIds.add(f.relatedId!);
      else if (f.relatedModel === "Listing") listingIds.add(f.relatedId!);
      else if (f.relatedModel === "User") userIds.add(f.relatedId!);
    }
    const [bizRows, listingRows, userRows] = await Promise.all([
      businessIds.size ? this.prisma.business.findMany({ where: { id: { in: [...businessIds] } }, select: { id: true } }) : [],
      listingIds.size ? this.prisma.listing.findMany({ where: { id: { in: [...listingIds] } }, select: { id: true } }) : [],
      userIds.size ? this.prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true } }) : [],
    ]);
    const bizSet = new Set(bizRows.map((r) => r.id));
    const listingSet = new Set(listingRows.map((r) => r.id));
    const userSet = new Set(userRows.map((r) => r.id));
    for (const f of recent) {
      const ok =
        f.relatedModel === "Business" ? bizSet.has(f.relatedId!) : f.relatedModel === "Listing" ? listingSet.has(f.relatedId!) : userSet.has(f.relatedId!);
      if (!ok) dangling.push(f);
    }

    return { staged: staged.map((r) => this.toDto(r)), dangling: dangling.map((r) => this.toDto(r)) };
  }

  /** Delete orphan rows (+ best-effort bytes) by id, or all orphans when ids omitted. */
  async deleteOrphans(ids?: string[]): Promise<{ deleted: number }> {
    const { staged, dangling } = await this.listOrphans(1000);
    const all = [...staged, ...dangling];
    const targets = ids && ids.length > 0 ? all.filter((f) => ids.includes(f.id)) : all;
    for (const f of targets) {
      if (!OID_RE.test(f.id)) continue;
      // storage keys never leave the service — refetch by id
      const row = await this.prisma.file.findUnique({ where: { id: f.id }, select: { storageKey: true, thumbStorageKey: true } });
      if (row) {
        try {
          await this.driver.delete(row.storageKey);
          if (row.thumbStorageKey) await this.driver.delete(row.thumbStorageKey).catch(() => undefined);
        } catch {
          /* best-effort */
        }
      }
      await this.prisma.file.delete({ where: { id: f.id } }).catch(() => undefined);
    }
    return { deleted: targets.length };
  }

  /** Per-user storage usage (خواسته‌ی کاربر: «هر کاربر چقدر حجم مصرف کرده»). */
  async usage(limit = 50) {
    const grouped = await this.prisma.file.groupBy({
      by: ["ownerId"],
      _sum: { size: true },
      _count: { id: true },
      orderBy: { _sum: { size: "desc" } },
      take: limit,
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: grouped.map((g) => g.ownerId) } },
      select: { id: true, name: true, phone: true },
    });
    const nameOf = new Map(users.map((u) => [u.id, u]));
    return grouped.map((g) => ({
      ownerId: g.ownerId,
      name: nameOf.get(g.ownerId)?.name ?? "—",
      phone: nameOf.get(g.ownerId)?.phone ?? "",
      files: g._count.id,
      bytes: g._sum.size ?? 0,
    }));
  }
}

/** یک پارت multipart از @fastify/multipart — فیلد یا فایل (هر ترتیبی) */
interface MultipartPart {
  type?: "field" | "file";
  fieldname?: string;
  value?: unknown;
  mimetype?: string;
  filename?: string;
  toBuffer: () => Promise<Buffer>;
}
