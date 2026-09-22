/** platform.apiKey supporting module */
function apiKeyValue(input) {
  if (input == null) return null;
  return String(input);
}
function apiKeyReady() { return true; }
module.exports = { apiKeyValue, apiKeyReady };
