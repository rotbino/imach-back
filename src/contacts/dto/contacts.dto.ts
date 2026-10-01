import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsString, Matches, MaxLength, ValidateNested } from "class-validator";

/** POST /contacts/sync — یک مخاطب خام از گوشی کاربر */
export class ContactItemDto {
  @IsString()
  @MaxLength(80)
  name!: string;

  /** خام قبول می‌شود؛ نرمال‌سازی 09xx سمت سرور انجام می‌گیرد */
  @IsString()
  @Matches(/^[\d+\-\s()]+$/, { message: "شماره موبایل نامعتبر است" })
  @MaxLength(24)
  phone!: string;
}

/** POST /contacts/sync — دسته‌ای تا ۵۰۰ مخاطب در هر فراخوان */
export class SyncContactsDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ContactItemDto)
  contacts!: ContactItemDto[];
}
