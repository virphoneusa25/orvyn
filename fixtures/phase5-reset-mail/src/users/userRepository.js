const USERS = [
  { id: "user_42", email: "ada@example.test", name: "Ada" },
  { id: "user_7", email: "alan@example.test", name: "Alan" },
];
function findUserByEmail(email) { return USERS.find((u) => u.email === email) || null; }
function findUserById(id) { return USERS.find((u) => u.id === id) || null; }
module.exports = { findUserByEmail, findUserById, USERS };
