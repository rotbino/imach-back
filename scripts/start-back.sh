#!/bin/bash
# iMach backend starter — survives between tool calls (nohup, plain spawn)
# Usage: bash /home/z/my-project/imach-back/scripts/start-back.sh
cd /home/z/my-project/imach-back

# MONGO_URL شامل & است — سورس مستقیم با bash خراب می‌شود؛ با dotenv بخوان
MONGO=$(node -e "require('dotenv').config(); process.stdout.write(process.env.MONGO_URL || '')")
if [ -z "$MONGO" ]; then echo "FATAL: MONGO_URL empty"; exit 1; fi

pkill -f "node dist/main" 2>/dev/null
sleep 0.5

# سندباکس: STORAGE درایور local (cred آروان نیست) + DATABASE_URL از MONGO_URL
DATABASE_URL="$MONGO" STORAGE_DRIVER=local UPLOAD_PATH="/home/z/my-project/imach-back/uploads" \
  nohup node dist/main.js > /tmp/imach-back.log 2>&1 &

echo "backend pid $!"
