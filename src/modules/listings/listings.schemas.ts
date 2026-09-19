import { Type } from "@sinclair/typebox";
import { FrequencyEnumSchema, TradeModeEnumSchema } from "../goods/goods.schemas.js";

export const UpsertListingBody = Type.Object({
  businessId: Type.String({ minLength: 1 }),
  goodId: Type.String({ minLength: 1 }),
  mode: TradeModeEnumSchema,
  sell: Type.Optional(
    Type.Object({
      price: Type.Number({ minimum: 1, maximum: 1e12 }),
      stock: Type.Integer({ minimum: 0, maximum: 1e9 }),
      minOrder: Type.Integer({ minimum: 0, maximum: 1e9 }),
    })
  ),
  buy: Type.Optional(
    Type.Object({
      volume: Type.Number({ minimum: 0.1, maximum: 1e9 }),
      frequency: FrequencyEnumSchema,
    })
  ),
});

export type UpsertListingBodyT = {
  businessId: string;
  goodId: string;
  mode: "SELL" | "BUY" | "BOTH";
  sell?: { price: number; stock: number; minOrder: number };
  buy?: { volume: number; frequency: string };
};
