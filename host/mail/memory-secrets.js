const saved = new Map();

function setPassword(account, password) {
  saved.set(account, password);
}

function getPassword(account) {
  return saved.has(account) ? saved.get(account) : null;
}

function deletePassword(account) {
  saved.delete(account);
}

module.exports = { setPassword, getPassword, deletePassword, SERVICE: "memory" };
