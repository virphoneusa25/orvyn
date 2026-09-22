/** support.tag supporting module */
function tagValue(input) {
  if (input == null) return null;
  return String(input);
}
function tagReady() { return true; }
module.exports = { tagValue, tagReady };
