const { createServer } = require("./http/server");
const { loadConfig } = require("./config/loadConfig");
module.exports = { start: () => createServer(loadConfig()) };
