import { IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

/**
 * Mobile number as dialled — several formats accepted here
 * (09…, 9…, +989…, 00989…, 989…) and normalized to the international
 * canonical dial + national number WITHOUT the leading 0 (e.g. 98912…)
 * in the service. The UI shows the dial code of the selected country.
 */
export const PHONE_DIALLED = /^\+?\d{10,14}$/;

export class RegisterUserDto {
  /**
   * Person identity — canonical since the two-step signup. Stored on the USER
   * and kept strictly separate from the BUSINESS name (a farmer may name their
   * business «مزرعه احمد» while their person name stays احمد رضایی).
   */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  lastName?: string;

  /** Legacy combined name — still accepted (deploy-window tolerance) and split server-side. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

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

export class CheckPhoneDto {
  @IsString()
  @Matches(PHONE_DIALLED)
  phone: string;

  /** country of the dial code (drives phone normalization) */
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

  /** country of the dial code the user picked in the login form (drives phone normalization) */
  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;
}

/**
 * Quick register — only mobile, no password, no name.
 * The user enters their phone and gets an immediate session; their Business
 * is auto-created with a placeholder name. They fill the rest from the
 * catalog header later (خواسته‌ی کاربر: «ثبت‌نام را راحت کنم»).
 *
 * If the phone is already registered AND has a real password, this endpoint
 * refuses — the user must login instead (security: nobody can hijack a
 * password-protected account by «quick-registering» the same number).
 */
export class QuickRegisterDto {
  @IsString()
  @Matches(PHONE_DIALLED)
  phone: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  ref?: string;
}

/**
 * Set password — for users who quick-registered without one, or who want
 * to change theirs. Requires authentication (the session must already
 * exist; this is NOT a forgot-password reset).
 */
export class SetPasswordDto {
  /** for quick-registered users, current password is empty — so optional */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(72)
  currentPassword?: string;

  @IsString()
  @MinLength(6)
  @MaxLength(72)
  newPassword: string;
}

/** Change the phone number on the authenticated account (rare; risky). */
export class ChangePhoneDto {
  @IsString()
  @Matches(PHONE_DIALLED)
  phone: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;
}
