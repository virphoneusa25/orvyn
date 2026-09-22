/** catalog.category supporting module */
function categoryValue(input) {
  if (input == null) return null;
  return String(input);
}
function categoryReady() { return true; }
module.exports = { categoryValue, categoryReady };
