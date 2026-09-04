#!/usr/bin/env node
// Minimal fake /api/health server for scripts/engine/tests. Listens on
// process.env.PORT (0 = OS-assigned; prints the actual port as the first
// line of stdout so the test can capture it) and responds to GET /api/health
// with either 200 {"status":"ok",...} or 500 {"status":"error"} depending on
// the MODE_FILE contents ("ok" or anything else), re-read on every request
// so a test can flip behavior mid-run by rewriting the file.

import http from "node:http";
import fs from "node:fs";

const modeFile = process.argv[2];
if (!modeFile) {
  console.error("usage: health-stub-server.mjs <mode-file>");
  process.exit(2);
}

const server = http.createServer((req, res) => {
  if (req.url !== "/api/health") {
    res.writeHead(404);
    res.end();
    return;
  }
  let mode = "fail";
  try {
    mode = fs.readFileSync(modeFile, "utf8").trim();
  } catch {
    // default fail
  }
  if (mode === "ok") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "0.0.0-stub", serverVersion: "0.0.0-stub" }));
  } else {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "error" }));
  }
});

server.listen(Number(process.env.PORT || 0), "127.0.0.1", () => {
  console.log(server.address().port);
});
