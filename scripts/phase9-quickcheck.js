/* تست سریع تابلوی تأمین هاشمی برای کاربر دمو (read-only) */
const BASE = "http://localhost:4000/api/v1";
const HASHEMI = "6abe2511578b46707877ed0f";

async function main() {
  const login = await (
    await fetch(BASE + "/auth/loginUser", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "989196421264", password: "123456", country: "IR" }),
    })
  ).json();
  const r = await fetch(`${BASE}/market/getSupplyBoard?goodId=${HASHEMI}&businessId=${login.businesses[0].id}`, {
    headers: { Authorization: `Bearer ${login.accessToken}` },
  });
  const board = await r.json();
  console.log("status:", r.status, "keys:", Object.keys(board));
  const rows = board.rows ?? board.items ?? board.suppliers ?? [];
  for (const row of rows) {
    const name = row.business?.name ?? row.name ?? row.bizName ?? "?";
    console.log(" ", name, "|", row.priceMinor ?? row.price, "|", row.city, "|", row.updatedAtDaysAgo ?? row.daysAgo, "|", row.followedByMe ? "دنبال‌شده" : "", row.boughtFrom ? "خریده‌ام" : "");
  }
  // خلاصه‌ی لیست خرید
  const list = await (await fetch(`${BASE}/market/getWatchedGoods?businessId=${login.businesses[0].id}`, { headers: { Authorization: `Bearer ${login.accessToken}` } })).json();
  console.log("\nلیست خرید:");
  for (const row of list.rows ?? []) {
    console.log(" ", row.good?.nameFa ?? row.name, "| supp=" + row.supplierCount, "| vol=" + (row.volume ?? row.buyVolume), "|", row.frequency ?? "");
  }
}
main().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
