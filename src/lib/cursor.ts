/**
 * Cursor pagination built on the `_id` field (ObjectId is time-ordered →
 * stable, index-friendly, and does not skip rows under concurrent writes —
 * unlike offset pagination). This is what keeps listing queries fast at
 * millions of records.
 *
 * Prisma expects the hex string for @db.ObjectId filters; it converts to
 * ObjectId itself, so no bson dependency is needed here.
 */

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

import { errors } from "./errors.js";

const OID_RE = /^[a-f\d]{24}$/i;

export const encodeCursor = (id: string): string => Buffer.from(id, "utf8").toString("base64url");

export function decodeCursor(raw: string | undefined): string | null {
  if (!raw) return null;
  let id: string;
  try {
    id = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw errors.badRequest("Malformed pagination cursor", "BAD_CURSOR");
  }
  if (!OID_RE.test(id)) {
    throw errors.badRequest("Malformed pagination cursor", "BAD_CURSOR");
  }
  return id;
}

/** Prisma WHERE fragment for "rows strictly before the cursor" (desc order). */
export function cursorBefore(cursor: string | null): { id?: { lt: string } } {
  return cursor ? { id: { lt: cursor } } : {};
}

/** Trims an over-fetched page (limit+1) into a Page. */
export function toPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? encodeCursor(last.id) : null };
}
