function renderPasswordReset({ email, token }) {
  return `<p>Reset for ${email}</p><p>token=${token}</p>`;
}
module.exports = { renderPasswordReset };
