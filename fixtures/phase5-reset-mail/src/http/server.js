const http = require("http");
const { router } = require("./router");
function createServer(config) {
  return http.createServer((req, res) => router(req, res, config));
}
module.exports = { createServer };
