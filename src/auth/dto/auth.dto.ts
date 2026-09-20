import { IsString, Matches, MaxLength, MinLength } from "class-validator";

/** Iranian mobile number: 09xxxxxxxxx */
export const PHONE_REGEX = /^09\d{9}$/;

export class RegisterUserDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name: string;

  @IsString()
  @Matches(PHONE_REGEX)
  phone: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;
}

export class LoginUserDto {
  @IsString()
  @Matches(PHONE_REGEX)
  phone: string;

  @IsString()
  @MinLength(1)
  @MaxLength(72)
  password: string;
}
