#!/usr/bin/env bash
# M7 — دود-تست سریع موتور امتیاز (تک‌فرمانی؛ سرور داخل همان فرمان بوت/خاموش می‌شود)
set -u
cd /home/z/my-project/imach-back
pkill -f "node dist/main" 2>/dev/null; sleep 1
MONGO=$(grep '^DATABASE_URL=' .env | cut -d= -f2- | sed 's/^"//; s/"$//')
DATABASE_URL="$MONGO" STORAGE_DRIVER=local UPLOAD_PATH="$PWD/uploads" setsid nohup node dist/main.js > /tmp/imach-back.log 2>&1 < /dev/null &
for i in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:4000/api/v1/getHealth && break; sleep 1; done
BASE=http://127.0.0.1:4000/api/v1
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "✔ $1"; }
bad(){ FAIL=$((FAIL+1)); echo "✖ $1"; }
jget(){ echo "$1" | python3 -c "import json,sys; d=json.load(sys.stdin); print($2)" 2>/dev/null; }

# ── ۱. کاربر تازه: sc1/sb1 (رویداد تولد) ⇒ امتیاز ۵/۵ ──
mkphone() { echo "9$(printf '%09d' $(( ($(date +%s)+$1) % 1000000000 )))"; }
P=$(mkphone 1)
R=$(curl -s -X POST $BASE/auth/quickRegister -H "content-type: application/json" -d "{\"phone\":\"$P\",\"country\":\"IR\"}")
TOKEN=$(jget "$R" "d['accessToken']")
BID=$(jget "$R" "d['businesses'][0]['id']")
SLUG=$(jget "$R" "d['businesses'][0]['slug']")
[ -n "$TOKEN" ] && ok "quickRegister ok ($P)" || bad "quickRegister failed"
S=$(curl -s "$BASE/score?businessId=$BID" -H "authorization: Bearer $TOKEN")
[ "$(jget "$S" "d['scoreSell']")" = "5" ] && ok "scoreSell=5 (رویداد تولد)" || bad "scoreSell=$(jget "$S" "d['scoreSell']")"
[ "$(jget "$S" "d['scoreBuy']")" = "5" ] && ok "scoreBuy=5" || bad "scoreBuy=$(jget "$S" "d['scoreBuy']")"
[ "$(jget "$S" "d['required']")" = "100" ] && ok "required=100 (AppSetting seed)" || bad "required=$(jget "$S" "d['required']")"
[ "$(jget "$S" "len([i for i in d['sell']['items'] if i['done']])")" = "1" ] && ok "فقط sc1 انجام‌شده" || bad "sell done count"
DN=$(jget "$S" "d['sell']['deskNext']['t']")
echo "$DN" | grep -q "اولین محصول" && ok "deskNext → sc2 (اولین محصول — حکم تولد M3)" || bad "deskNext=$DN"

# ── ۲. دعوت‌شدگان: خالی + لینک‌ها ──
RF=$(curl -s "$BASE/score/referrals?businessId=$BID" -H "authorization: Bearer $TOKEN")
[ "$(jget "$RF" "d['count']")" = "0" ] && ok "referrals count=0" || bad "referrals count"
[ "$(jget "$RF" "d['goal']")" = "5" ] && ok "goal=5" || bad "goal"
echo "$RF" | grep -q "buy:" && ok "لینک دعوت buy-list با ref" || bad "buy ref link"

# ── ۳. getMarketState: open (جایگزین referral) ──
MS=$(curl -s "$BASE/market/getMarketState?businessId=$BID" -H "authorization: Bearer $TOKEN")
echo "$MS" | grep -q '"open"' && ok "getMarketState → open" || bad "no open key"
echo "$MS" | grep -q '"referral"' && bad "referral هنوز هست!" || ok "referral حذف شد"
[ "$(jget "$MS" "d['open']['buy']['unlocked']")" = "False" ] && ok "خرید قفل (۵<۱۰۰)" || bad "buy unlocked?"

# ── ۴. suggestions قفل برای خریدار ۵ امتیازی ──
SG=$(curl -s "$BASE/market/getSuggestions?businessId=$BID" -H "authorization: Bearer $TOKEN")
[ "$(jget "$SG" "d.get('locked')")" = "True" ] && ok "suggestions locked=true" || bad "suggestions not locked"
[ "$(jget "$SG" "d.get('score')")" = "5" ] && ok "locked score=5" || bad "locked score"

# ── ۵. ادمین: آستانه را موقتاً ۵ کن → موتور باز می‌شود ──
# (توکن ادمین inline — JWT_SECRET از .env خود بک + پیداکردن یک ADMIN از Atlas)
ADMIN=$(node -e "
const fs = require('fs');
const { MongoClient } = require('mongodb');
const jwt = require('jsonwebtoken');
const env = fs.readFileSync('.env', 'utf8');
const secret = env.match(/^JWT_SECRET=\"?([^\"]*)\"?/m)[1];
const mongo = env.match(/^DATABASE_URL=\"?([^\"]*)\"?/m)[1];
(async () => {
  const client = new MongoClient(mongo);
  await client.connect();
  const users = client.db().collection('User');
  const admin = (await users.findOne({ role: 'ADMIN' })) ?? (await users.findOne({}));
  console.log(jwt.sign({ id: String(admin._id), phone: admin.phone, role: admin.role }, secret, { expiresIn: '30m' }));
  await client.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
" 2>/dev/null)
if [ -n "$ADMIN" ]; then
  W=$(curl -s -X PUT "$BASE/admin/settings/network.openScore" -H "authorization: Bearer $ADMIN" -H "content-type: application/json" -d '{"value":5}')
  echo "$W" | grep -q "network.openScore" && ok "ادمین openScore=5 نوشت" || bad "admin write: $(echo $W | head -c 120)"
  SG2=$(curl -s "$BASE/market/getSuggestions?businessId=$BID" -H "authorization: Bearer $TOKEN")
  [ "$(jget "$SG2" "d.get('locked')")" != "True" ] && ok "با آستانهٔ ۵ → موتور باز" || bad "still locked: $(echo $SG2 | head -c 120)"
  curl -s -X PUT "$BASE/admin/settings/network.openScore" -H "authorization: Bearer $ADMIN" -H "content-type: application/json" -d '{"value":100}' > /dev/null
  ok "آستانه به ۱۰۰ برگشت"
else
  bad "admin token نشد — بخش ۵ رد شد"
fi

# ── ۶. ثبت‌نام با ?ref → referredBy + پاداش کیف + دعوت‌شده ──
P2=$(mkphone 2)
R2=$(curl -s -X POST $BASE/auth/quickRegister -H "content-type: application/json" -d "{\"phone\":\"$P2\",\"country\":\"IR\",\"ref\":\"$SLUG\"}")
T2=$(jget "$R2" "d['accessToken']")
B2=$(jget "$R2" "d['businesses'][0]['id']")
[ -n "$T2" ] && ok "کاربر دوم با ?ref ثبت‌نام کرد" || bad "register ref failed"
RF2=$(curl -s "$BASE/score/referrals?businessId=$BID" -H "authorization: Bearer $TOKEN")
[ "$(jget "$RF2" "d['count']")" = "1" ] && ok "دعوت‌شده دیده شد (count=1)" || bad "referrals count=1? $(echo $RF2 | head -c 200)"
[ "$(jget "$RF2" "d['items'][0]['arm']")" = "SELL" ] && ok "arm=SELL (لینک کاتالوگ)" || bad "arm"
echo "$RF2" | grep -q "REFERRAL" ; EARLIER=$(jget "$RF2" "d['earnedMinor']")
[ "$EARLIER" = "50000" ] && ok "پاداش ۵۰٬۰۰۰ minor ثبت شد" || bad "earnedMinor=$EARLIER"
# فالوی تولد: خریدارِ تازه → کاتالوک معرف (sc5 در جریان است)
S2=$(curl -s "$BASE/score?businessId=$BID" -H "authorization: Bearer $TOKEN")
CUST=$(jget "$S2" "len([i for i in d['sell']['items'] if i['done']])")
echo "── sell done after referral: $CUST ──"

pkill -f "node dist/main" 2>/dev/null
echo ""
echo "══ DOD-SMOKE: $PASS pass / $FAIL fail ══"
[ $FAIL -eq 0 ] && echo "ALL GREEN ✅" || echo "HAS FAILURES ✖"
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
