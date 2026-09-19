import { Type } from "@sinclair/typebox";

export const UnitEnumSchema = Type.Union([
  Type.Literal("KILOGRAM"),
  Type.Literal("TON"),
  Type.Literal("CARTON"),
  Type.Literal("SACK"),
  Type.Literal("PIECE"),
  Type.Literal("LITER"),
  Type.Literal("BRANCH"),
]);

export const RoleEnumSchema = Type.Union([
  Type.Literal("RETAILER"),
  Type.Literal("WHOLESALER"),
  Type.Literal("PRODUCER"),
  Type.Literal("MARKETER"),
]);

export const FrequencyEnumSchema = Type.Union([
  Type.Literal("WEEKLY"),
  Type.Literal("MONTHLY"),
  Type.Literal("OCCASIONAL"),
]);

export const TradeModeEnumSchema = Type.Union([
  Type.Literal("SELL"),
  Type.Literal("BUY"),
  Type.Literal("BOTH"),
]);

export const GoodDto = Type.Object({
  id: Type.String(),
  name: Type.String(),
  category: Type.String(),
  unit: Type.String(),
});

export const GoodPageDto = Type.Object({
  items: Type.Array(GoodDto),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});
