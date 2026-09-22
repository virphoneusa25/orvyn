const { test } = require("node:test");
const assert = require("node:assert/strict");
const { notifyPasswordReset } = require("../src/notifications/passwordResetNotifier");
const { handlePasswordReset } = require("../src/auth/passwordResetController");
const { outbox, resetOutbox } = require("../src/mail/mailer");
const { USERS } = require("../src/users/userRepository");

function fakeReq(email) {
  const { Readable } = require("stream");
  const req = Readable.from([JSON.stringify({ email })]);
  req.method = "POST";
  return req;
}

test("password reset emails are delivered to the user address", async () => {
  resetOutbox();
  const res = { statusCode: 0, end() {} };
  await handlePasswordReset(fakeReq(USERS[0].email), res);
  const mail = outbox().find((m) => m.to === USERS[0].email);
  assert.ok(mail, "expected a reset email in the outbox");
  assert.match(mail.html, /token=/);
});
