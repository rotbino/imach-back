import { IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

/**
 * Mobile number as dialled — several formats accepted here
 * (09…, 9…, +989…, 00989…, 989…) and normalized to the international
 * canonical dial + national number WITHOUT the leading 0 (e.g. 98912…)
 * in the service. The UI shows the dial code of the selected country.
 */
export const PHONE_DIALLED = /^\+?\d{10,14}$/;

export class RegisterUserDto {
  /** business display name — doubles as the user name; a farmer may type their own name */
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

  /** country chosen at signup → default catalog currency + phone dial code (ISO 3166-1 alpha-2) */
  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;

  /** UI language of the user — stored for future multilingual sessions (BCP-47 base, e.g. fa/en/ar) */
  @IsOptional()
  @IsString()
  @MaxLength(8)
  language?: string;

  /** referral code = slug of the business whose catalog / invite link brought this user (?ref=) */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  ref?: string;
}

export class LoginUserDto {
  @IsString()
  @Matches(PHONE_DIALLED)
  phone: string;

  @IsString()
  @MinLength(1)
  @MaxLength(72)
  password: string;

  /** country of the dial code the user picked in the login form (drives phone normalization) */
  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;
}
