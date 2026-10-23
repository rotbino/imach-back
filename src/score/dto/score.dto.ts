import { IsString } from "class-validator";

/** GET /score | /score/referrals — کسب‌وکار فعال کاربر (مثل الگوی بازار) */
export class BusinessIdQueryDto {
  @IsString()
  businessId: string;
}
