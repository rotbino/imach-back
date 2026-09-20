import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class CreateBusinessDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name: string;

  @IsString()
  @MinLength(2)
  @MaxLength(30)
  city: string;

  /** نقش در بازار عمده — هر کدام را خواست تیک می‌زند (حداقل یکی) */
  @IsBoolean()
  sells: boolean;

  @IsBoolean()
  buys: boolean;
}

export class EditBusinessDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(30)
  city?: string;

  /** فعال‌سازی/غیرفعال‌سازی بازوها در هر لحظه از پنل */
  @IsOptional()
  @IsBoolean()
  sells?: boolean;

  @IsOptional()
  @IsBoolean()
  buys?: boolean;
}
