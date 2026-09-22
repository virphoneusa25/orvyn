const { handlePasswordReset } = require("../auth/passwordResetController");
function router(req, res, config) {
  if (req.url === "/auth/password-reset" && req.method === "POST") return handlePasswordReset(req, res, config);
  res.statusCode = 404; res.end("not found");
}
module.exports = { router };
