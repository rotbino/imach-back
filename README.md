# iMach — API (imach-back)

بک‌اند بازار عمده‌فروشی **iMach** — اتصال خریدارها و تامین‌کننده‌های زنجیره تامین.

**Stack:** Node.js ≥ 20 · Fastify 5 · TypeScript (strict) · Prisma · MongoDB (Atlas) · JWT

## معماری

```
src/
├─ app.ts                 # Fastify factory: helmet, cors, rate-limit, jwt, swagger, error handler
├─ server.ts              # bootstrap + graceful shutdown
├─ config/env.ts          # env validation با TypeBox (fail-fast)
├─ plugins/auth.ts        # requireAuth decorator (Bearer JWT)
├─ lib/
│  ├─ prisma.ts           # single PrismaClient
│  ├─ cache.ts            # TTL cache با tag-based invalidation (+ LRU)
│  ├─ cursor.ts           # cursor pagination روی _id (مقیاس میلیون‌ها رکورد)
│  ├─ errors.ts           # AppError + مپینگ مرکزی خطاها
│  ├─ guards.ts           # مالکیت + slug یکتا
│  ├─ cities.ts           # گراف نزدیکی جغرافیایی + امتیاز تطبیق
│  └─ password.ts         # bcrypt
└─ modules/
   ├─ auth/               # register/login/refresh(چرخشی)/logout/me
   ├─ goods/              # کاتالوگ مرجع کالاها (کش‌شده)
   ├─ businesses/         # کسب‌وکار (فروشنده و خریدار، یک مدل)
   ├─ listings/           # آگهی = واحد قابل‌معامله (business × good, unique)
   ├─ market/             # استعلام، پیشنهاد، فالو، تابلوی قیمت، پیشنهادها
   └─ matching/           # موتور تطبیق: کالا + شهر + حجم → score 0..100
```

## اصول کلیدی

| محور | تصمیم |
| --- | --- |
| **مقیاس** | Cursor pagination (`_id` monotonic) + compound index مطابق هر مسیر داغ + bounded scan در matching |
| **سرعت** | کش TTL با `tag-based invalidation` (خواندن پرتکرار: کاتالوگ، پروفایل، تابلو) + هدر `x-cache: HIT/MISS` برای مشاهده |
| **امنیت** | bcrypt، access token کوتاه‌عمر در حافظه کلاینت، **refresh token چرخشی** (فقط sha256 در دیتابیس)، helmet، rate-limit (auth: 15/min، global: 300/min)، CORS configurable |
| **تمیزکاری** | لایه ماژولی (routes/service/schemas)، TypeBox = اعتبارسنجی + JSON Schema + Swagger از یک منبع، error handler مرکزی با کد خطا |

## اجرا

```bash
cp .env.example .env        # مقادیر واقعی را بگذار
npm install
npm run db:push             # ساخت کالکشن‌ها و ایندکس‌ها روی MongoDB
npm run seed                # دیتای دمو (۱۸ کالا، ۱۱ کسب‌وکار)
npm run dev                 # http://localhost:4000
```

- Swagger UI: `http://localhost:4000/docs`
- Health: `GET /api/v1/health`

### حساب‌های دمو (seed)

همه با رمز `ImachDemo1234`:
`09120000001` (خورشید مارکت) · `09120000002` (طبیعت‌دانه پخش) · … تا `09120000011`

## API v1

| متد | مسیر | توضیح |
| --- | --- | --- |
| POST | `/auth/register` | ثبت‌نام (name, phone, password) |
| POST | `/auth/login` | ورود → access token + کوکی httpOnly |
| POST | `/auth/refresh` | چرخش refresh token |
| POST | `/auth/logout` | ابطال توکن جاری |
| GET | `/auth/me` | کاربر + کسب‌وکارهایش |
| GET | `/goods` · `/goods/categories` | کاتالوگ مرجع (کش ۵ دقیقه) |
| GET | `/businesses/mine` | کسب‌وکارهای من |
| POST | `/businesses` | ساخت کسب‌وکار (slug خودکار) |
| GET | `/businesses/:slug` | پروفایل عمومی + آگهی‌ها (کش) |
| PATCH | `/businesses/:id` | ویرایش (فقط مالک) |
| GET/PUT/DELETE | `/listings…` | آگهی من / upsert (تغییر قیمت → PriceLog) / حذف |
| POST | `/market/listings/:id/quote-request` | **موتور تطبیق**: Inquiry + Offer برای تامین‌کننده‌های مرتبط |
| GET | `/market/offers` | پیشنهادهای دریافتی خریدار (cursor) |
| POST | `/market/offers` | پاسخ دستی فروشنده به یک Inquiry |
| GET | `/market/inquiries` | درخواست‌های فروشنده (+unreadCount) |
| POST | `/market/inquiries/:id/read` | خوانده شد |
| GET/POST/DELETE | `/market/follows…` | فالو تامین‌کننده |
| GET | `/market/board` | تابلوی قیمت فالو‌شده‌ها (+trend از PriceLog) |
| GET | `/market/suggestions` | خریدارهای پیشنهادی برای کالاهای فروش من |

## بازارهای تخصصی (آینده)

مدل‌های `Market` / `MarketGoodRule` / `MarketMembership` در اسکیما **پیش‌بینی شده‌اند**:
هر بازار از آگهی‌ها تغذیه می‌شود (قانون تغذیه روی رابطه بازار×کالای مرجع)، بدون کپی داده و بدون دست زدن به هسته.

## نکات دیپلوی

- پشت reverse proxy اجرا کنید (`trustProxy: true` فعال است).
- در production: `SWAGGER_ENABLED=false`، `CORS_ORIGINS` دقیق، `JWT_SECRET` قوی و چرخشی.
- برای مقیاس افقی: کش درون‌حافظه با Redis جایگزین می‌شود (همان اینترفیس `cache.wrap`).
