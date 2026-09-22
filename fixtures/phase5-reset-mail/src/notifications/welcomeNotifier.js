async function notifyWelcome(email) { return { sent: Boolean(email && email.includes("@")) }; }
module.exports = { notifyWelcome };
