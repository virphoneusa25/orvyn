/** catalog.inventory supporting module */
function inventoryValue(input) {
  if (input == null) return null;
  return String(input);
}
function inventoryReady() { return true; }
module.exports = { inventoryValue, inventoryReady };
