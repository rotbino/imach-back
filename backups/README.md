# Database Backups — Migration Safety

هر فولدر `YYYY-MM-DD/` یک بک‌آپ کامل و **بازسازی‌شده/تأییدشده** از دیتابیس `imach_online_db` است که پیش از شروع فازهای مهاجرت گرفته شده.

## ساختار هر بک‌آپ

| فایل | توضیح |
|---|---|
| `imach_online_db-<date>.tar.gz` | آرشیو کامل: dump هر ۲۶ کالکشن (EJSON بدون‌افت: ObjectId / Date / Decimal128 / Binary) + manifest |
| `manifest.json` | شمارش هر کالکشن، SHA-256 هر فایل، تعریف ایندکس‌ها، زمان بک‌آپ |
| `README.md` | همین راهنما (در ریشه `backups/`) |

## گرفتن بک‌آپ تازه

```bash
# از ریشه imach-back (نیازمند npm install — پکیج mongodb در devDependencies هست)
DATABASE_URL="mongodb+srv://..." node scripts/backup-db.mjs --out backups/migration/$(date +%F)
```

## بازگردانی

```bash
# بازگردانی به یک دیتابیس دیگر (امن — پیشنهادی برای تست)
node scripts/restore-db.mjs backups/migration/2026-10-05/imach_online_db-2026-10-05.tar.gz \
     --target-uri "mongodb+srv://..." --target-db imach_restore_test

# بازگردانی روی دیتابیس اصلی (مخرب — کالکشن‌های موجود را می‌ریزد)
node scripts/restore-db.mjs backups/migration/2026-10-05/imach_online_db-2026-10-05.tar.gz \
     --target-uri "mongodb+srv://..." --target-db imach_online_db --drop-existing
```

`restore-db.mjs` پس از بازگردانی، شمارش هر کالکشن را با manifest تطبیق می‌دهد و در صورت مغایرت با کد خطا خارج می‌شود.

## قانون‌ها (پرامپت مهاجرت §۷)

- پیش از هر migration اسکیمای مخرب → بک‌آپ تازه بگیر.
- migrationها تا جایی که منطقی است reversible باشند.
- پس از هر migration → integrity check (شمارش‌ها + روابط).
- هیچ جدول یا داده‌ای بدون دلیل حذف نشود.

> نکته امنیتی: این آرشیو حاوی داده واقعی کاربران است. طبق دستور صریح مالک برای ماندگاری بک‌آپ در گیت (ریپوی خصوصی، مقابله با ریست سندباکس) پوش می‌شود؛ اگر روزی ریپو عمومی شد این فولدر باید حذف و rotate شود.
