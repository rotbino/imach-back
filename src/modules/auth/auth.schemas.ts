import { Type } from "@sinclair/typebox";

/** Iranian mobile number: 09xxxxxxxxx */
export const PhoneSchema = Type.String({ pattern: "^09\\d{9}$" });

export const RegisterBody = Type.Object({
  name: Type.String({ minLength: 2, maxLength: 60 }),
  phone: PhoneSchema,
  password: Type.String({ minLength: 8, maxLength: 72 }),
});

export const LoginBody = Type.Object({
  phone: PhoneSchema,
  password: Type.String({ minLength: 1, maxLength: 72 }),
});

export const AuthUserDto = Type.Object({
  id: Type.String(),
  name: Type.String(),
  phone: Type.String(),
  role: Type.String(),
});

export const BusinessSummaryDto = Type.Object({
  id: Type.String(),
  slug: Type.String(),
  name: Type.String(),
  role: Type.String(),
  city: Type.String(),
  isVerified: Type.Boolean(),
});

export const AuthResponse = Type.Object({
  accessToken: Type.String(),
  user: AuthUserDto,
  businesses: Type.Array(BusinessSummaryDto),
});

export type RegisterBodyT = { name: string; phone: string; password: string };
export type LoginBodyT = { phone: string; password: string };
