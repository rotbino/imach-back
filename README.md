# iMach API — NestJS 12 + Fastify 5 + Prisma + MongoDB

B2B wholesale marketplace API. Built for millions of records (cursor
pagination on ObjectId, compound indexes, tag-based cache) with a
modular NestJS architecture and Fastify for raw speed.

## Stack

| Layer     | Choice                                  |
| --------- | --------------------------------------- |
| Framework | NestJS 12 (latest stable)               |
| HTTP      | Fastify 5 adapter (`@nestjs/platform-fastify`) |
| ORM       | Prisma + MongoDB Atlas                  |
| Auth      | Access JWT (Bearer) + rotating refresh token (httpOnly cookie, sha256-at-rest) |
| Rate limit| `@nestjs/throttler` — 300/min global, 15/min on auth |
| Cache     | In-process TTL + tag invalidation (`x-cache: HIT/MISS` header) |
| Docs      | OpenAPI at `/docs` (`SWAGGER_ENABLED`)  |

## Run

```bash
cp .env.example .env    # fill real values
yarn install            # or: npm install — auto-generates the Prisma client (postinstall)
npm run db:push         # sync schema to MongoDB (indexes included)
npm run seed            # optional demo dataset
npm run start:dev       # http://localhost:4000/api/v1
```

> The repo is locked with `yarn.lock`. If you must use npm, expect minor
> dependency drift. If TypeScript ever floods you with implicit-any errors
> (TS7006) in Prisma-heavy files, the generated client is missing — run
> `npm run db:generate`.

## Endpoints — action naming

Endpoints use explicit action names (`editUser`-style) so client and
server read identically. All under `/api/v1`:

| Module     | Endpoint                                          |
| ---------- | ------------------------------------------------- |
| auth       | `POST auth/registerUser` · `POST auth/loginUser` · `POST auth/refreshSession` · `POST auth/logoutUser` · `GET auth/getMe` |
| goods      | `GET goods/getGoods` · `GET goods/getCategories`  |
| businesses | `GET businesses/getMyBusinesses` · `POST businesses/createBusiness` · `GET businesses/getBusiness/:slug` · `PATCH businesses/editBusiness/:id` |
| listings   | `GET listings/getMyListings` · `PUT listings/saveListing` · `DELETE listings/deleteListing/:id` |
| market     | `POST market/requestQuote/:listingId` · `GET market/getOffers` · `POST market/sendOffer` · `GET market/getInquiries` · `POST market/markInquiryRead/:id` · `GET market/getFollows` · `POST market/followSupplier` · `POST market/unfollowSupplier/:supplierId` · `GET market/getPriceBoard` · `GET market/getSuggestions` |
| health     | `GET getHealth`                                   |

## Conventions

- **Error shape** — always `{ error: "STABLE_CODE", message: "human text" }`.
  Clients match on `error` (language-independent), show `message`.
- **i18n base** — request locale resolved from `Accept-Language`
  (`fa` default, `ar`/`en` supported); services translate via `t()`.
- **No enums in MongoDB** — connector limitation; values are validated
  at the DTO boundary instead.
- **Clean code rule** — leftover/dead code from refactors is deleted,
  never disabled: the project stays small and reviewable.
