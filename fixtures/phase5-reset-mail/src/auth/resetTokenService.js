const crypto = require("crypto");
const tokens = new Map();
function issueResetToken(userId) {
  const token = crypto.randomBytes(16).toString("hex");
  tokens.set(token, { userId, exp: Date.now() + 3600_000 });
  return token;
}
function consumeResetToken(token) {
  const row = tokens.get(token);
  if (!row || row.exp < Date.now()) return null;
  tokens.delete(token);
  return row.userId;
}
module.exports = { issueResetToken, consumeResetToken };
