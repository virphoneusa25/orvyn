/** analytics.cohort supporting module */
function cohortValue(input) {
  if (input == null) return null;
  return String(input);
}
function cohortReady() { return true; }
module.exports = { cohortValue, cohortReady };
