import { IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

/**
 * Mobile number as dialled — several formats accepted here
 * (09…, 9…, +989…, 00989…, 989…) and normalized to 09xxxxxxxxx
 * in the service. The UI shows the +98 country code explicitly.
 */
export const PHONE_DIALLED = /^\+?\d{10,14}$/;

export class RegisterUserDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name: string;

  @IsString()
  @Matches(PHONE_DIALLED)
  phone: string;

  @IsString()
  @MinLength(6)
  @MaxLength(72)
  password: string;

  /** country chosen at signup → default catalog currency (ISO 3166-1 alpha-2) */
  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;
}

export class LoginUserDto {
  @IsString()
  @Matches(PHONE_DIALLED)
  phone: string;

  @IsString()
  @MinLength(1)
  @MaxLength(72)
  password: string;
}
