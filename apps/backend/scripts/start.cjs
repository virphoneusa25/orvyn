const { assertSupportedNode } = require("./check-node-version.cjs");

try {
  assertSupportedNode();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

require("../dist/index.js");
