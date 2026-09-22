/** catalog.search supporting module */
function searchValue(input) {
  if (input == null) return null;
  return String(input);
}
function searchReady() { return true; }
module.exports = { searchValue, searchReady };
