/*
 * Copyright (c) 2026 TEX8.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:https";
import { resolve, sep } from "node:path";

const [fixtureRootArgument, certificatePath, privateKeyPath, portArgument] =
  process.argv.slice(2);
if (
  !fixtureRootArgument ||
  !certificatePath ||
  !privateKeyPath ||
  !/^[0-9]{2,5}$/.test(portArgument ?? "")
) {
  throw new Error(
    "usage: serve_catalog_fixture.mjs <fixture-root> <certificate> <private-key> <port>",
  );
}

const fixtureRoot = resolve(fixtureRootArgument);
const port = Number(portArgument);
const allowedPrefix = `${fixtureRoot}${sep}`;
const server = createServer(
  {
    cert: readFileSync(certificatePath),
    key: readFileSync(privateKeyPath),
    minVersion: "TLSv1.2",
  },
  (request, response) => {
    try {
      if (request.method !== "GET") {
        response.writeHead(405, { "content-type": "text/plain" });
        response.end("Method not allowed");
        return;
      }
      const url = new URL(request.url ?? "/", "https://127.0.0.1");
      const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const path = resolve(fixtureRoot, relativePath);
      if (!path.startsWith(allowedPrefix)) {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("Not found");
        return;
      }
      const metadata = statSync(path);
      if (!metadata.isFile() || metadata.size <= 0 || metadata.size > 64 * 1024 * 1024) {
        throw new Error("fixture file is invalid");
      }
      const data = readFileSync(path);
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": String(data.length),
        "content-type": "application/json",
        "x-content-type-options": "nosniff",
      });
      response.end(data);
      process.stdout.write(
        `TEX8_CATALOG_FIXTURE request=${url.pathname} bytes=${data.length}\n`,
      );
    } catch {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found");
    }
  },
);

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`TEX8_CATALOG_FIXTURE_READY port=${port}\n`);
});
