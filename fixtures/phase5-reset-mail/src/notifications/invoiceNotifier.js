async function notifyInvoice(email) { return { sent: Boolean(email && email.includes("@")) }; }
module.exports = { notifyInvoice };
