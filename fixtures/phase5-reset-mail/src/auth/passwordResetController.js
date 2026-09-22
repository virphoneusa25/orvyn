const { findUserByEmail } = require("../users/userRepository");
const { issueResetToken } = require("./resetTokenService");
const { notifyPasswordReset } = require("../notifications/passwordResetNotifier");

async function handlePasswordReset(req, res) {
  const body = await readJson(req);
  const user = findUserByEmail(body.email);
  if (!user) { res.statusCode = 202; res.end("{}"); return; }
  const token = issueResetToken(user.id);
  // BUG: passes user.id instead of user.email — reset mail never leaves.
  await notifyPasswordReset(user.id, token);
  res.statusCode = 202;
  res.end("{}");
}
function readJson(req) {
  return new Promise((resolve) => {
    let d = ""; req.on("data", (c) => d += c); req.on("end", () => {
      try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); }
    });
  });
}
module.exports = { handlePasswordReset };
