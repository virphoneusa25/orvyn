const MINIMUM_NODE_VERSION = { major: 22, minor: 13, patch: 0 };

function assertSupportedNode(version = process.versions.node) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`Unable to parse Node.js version: ${version}`);

  const actual = match.slice(1).map(Number);
  const { major, minor, patch } = MINIMUM_NODE_VERSION;
  const supported = actual[0] > major ||
    (actual[0] === major && (actual[1] > minor ||
      (actual[1] === minor && actual[2] >= patch)));
  if (!supported) {
    throw new Error(
      `ORVYN requires Node.js >=${major}.${minor}.${patch}; found ${version}. ` +
      "Install a supported Node.js LTS release and restart ORVYN."
    );
  }
}

module.exports = { MINIMUM_NODE_VERSION, assertSupportedNode };

if (require.main === module) {
  try {
    assertSupportedNode();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
