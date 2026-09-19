import { Type } from "@sinclair/typebox";
import { RoleEnumSchema } from "../goods/goods.schemas.js";

export const CreateBusinessBody = Type.Object({
  name: Type.String({ minLength: 2, maxLength: 60 }),
  role: RoleEnumSchema,
  city: Type.String({ minLength: 2, maxLength: 30 }),
  phone: Type.Optional(Type.String({ maxLength: 14 })),
});

export const UpdateBusinessBody = Type.Partial(
  Type.Object({
    name: Type.String({ minLength: 2, maxLength: 60 }),
    role: RoleEnumSchema,
    city: Type.String({ minLength: 2, maxLength: 30 }),
    phone: Type.Optional(Type.String({ maxLength: 14 })),
  })
);

export const ListingDto = Type.Object({
  id: Type.String(),
  mode: Type.String(),
  price: Type.Union([Type.Number(), Type.Null()]),
  stock: Type.Union([Type.Integer(), Type.Null()]),
  minOrder: Type.Union([Type.Integer(), Type.Null()]),
  volume: Type.Union([Type.Number(), Type.Null()]),
  frequency: Type.Union([Type.String(), Type.Null()]),
  good: Type.Object({
    id: Type.String(),
    name: Type.String(),
    category: Type.String(),
    unit: Type.String(),
  }),
});

export const BusinessProfileDto = Type.Object({
  id: Type.String(),
  slug: Type.String(),
  name: Type.String(),
  role: Type.String(),
  city: Type.String(),
  phone: Type.Union([Type.String(), Type.Null()]),
  isVerified: Type.Boolean(),
  isDemo: Type.Boolean(),
  listings: Type.Array(ListingDto),
});

export type CreateBusinessBodyT = { name: string; role: string; city: string; phone?: string };
export type UpdateBusinessBodyT = { name?: string; role?: string; city?: string; phone?: string };
