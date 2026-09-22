import { Type } from "class-transformer";
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

/** GET /notifications/getNotifications */
export class NotificationsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class PushKeysDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  p256dh: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  auth: string;
}

/** POST /notifications/subscribePush — اشتراک مرورگر برای Web Push */
export class SubscribePushDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  endpoint: string;

  @ValidateNested()
  @Type(() => PushKeysDto)
  keys: PushKeysDto;
}

/** POST /notifications/unsubscribePush */
export class UnsubscribePushDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  endpoint: string;
}
