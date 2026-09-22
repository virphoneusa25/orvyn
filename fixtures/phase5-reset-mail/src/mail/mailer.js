const sent = [];
async function sendMail({ to, subject, html }) {
  if (!to || !to.includes("@")) return { sent: false, reason: "invalid-recipient" };
  sent.push({ to, subject, html, at: Date.now() });
  return { sent: true, id: "msg_" + sent.length };
}
function outbox() { return sent.slice(); }
function resetOutbox() { sent.length = 0; }
module.exports = { sendMail, outbox, resetOutbox };
