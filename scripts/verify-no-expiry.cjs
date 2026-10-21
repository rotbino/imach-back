// Verify: JWT_EXPIRES_IN="never" → token WITHOUT `exp` claim, still verifies.
// Uses the compiled env.js + the same jsonwebtoken library the app uses.
const { jwtExpiresInSeconds, env } = require("../dist/common/config/env.js");
const jwt = require("jsonwebtoken");

const assert = (cond, msg) => {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("ok  :", msg);
};

assert(jwtExpiresInSeconds("never") === undefined, '"never" → undefined');
assert(jwtExpiresInSeconds("7d") === 604800, '"7d" → 604800');
assert(jwtExpiresInSeconds("15m") === 900, '"15m" → 900');
assert(env.JWT_EXPIRES_IN === "never", `.env is read as "never" (got: ${env.JWT_EXPIRES_IN})`);

// sign exactly like issueSession does when expiresIn === undefined
const payload = { id: "abc", phone: "989120000000", role: "USER" };
const token = jwt.sign(payload, env.JWT_SECRET, {});
const decoded = jwt.decode(token);
assert(decoded.exp === undefined, "token carries NO exp claim");
assert(decoded.iat > 0, "token carries iat (issued-at)");

// verify still works — and would keep working forever (no exp check happens)
const verified = jwt.verify(token, env.JWT_SECRET);
assert(verified.id === "abc", "token verifies fine");

console.log("\nALL PASS — JWT is now without expiration.");
