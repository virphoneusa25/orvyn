function loginUser(email, password) { return { ok: Boolean(email && password) }; }
module.exports = { loginUser };
