/** catalog.facet supporting module */
function facetValue(input) {
  if (input == null) return null;
  return String(input);
}
function facetReady() { return true; }
module.exports = { facetValue, facetReady };
