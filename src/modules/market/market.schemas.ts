import { Type } from "@sinclair/typebox";

export const QuoteRequestBody = Type.Object({
  note: Type.Optional(Type.String({ maxLength: 300 })),
});

export const SendOfferBody = Type.Object({
  inquiryId: Type.String({ minLength: 1 }),
  price: Type.Number({ minimum: 1, maximum: 1e12 }),
  note: Type.Optional(Type.String({ maxLength: 300 })),
});

export const FollowBody = Type.Object({
  businessId: Type.String({ minLength: 1 }),
  supplierId: Type.String({ minLength: 1 }),
});

export const BusinessIdQuery = Type.Object({
  businessId: Type.String({ minLength: 1 }),
});

export type QuoteRequestBodyT = { note?: string };
export type SendOfferBodyT = { inquiryId: string; price: number; note?: string };
export type FollowBodyT = { businessId: string; supplierId: string };
