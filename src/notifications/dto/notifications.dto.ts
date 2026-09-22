import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";

/** GET /notifications/getNotifications */
export class NotificationsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
