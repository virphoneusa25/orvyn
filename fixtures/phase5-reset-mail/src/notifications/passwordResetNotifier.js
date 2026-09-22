const { sendMail } = require("../mail/mailer");
const { renderPasswordReset } = require("../mail/templates/passwordReset");

async function notifyPasswordReset(email, token) {
  if (!email || !String(email).includes("@")) {
    return { sent: false, reason: "invalid-recipient" };
  }
  const html = renderPasswordReset({ email, token });
  return sendMail({ to: email, subject: "Reset your password", html });
}
module.exports = { notifyPasswordReset };
