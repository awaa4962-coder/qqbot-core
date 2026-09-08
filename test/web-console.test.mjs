import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

import { handleWebConsoleRequest } from "../bridge/web-console.mjs";

test("browser modules link correctly and every imported asset is explicitly served", async () => {
  const root = fileURLToPath(new URL("../launcher/QQFriendLauncher/Web/", import.meta.url));
  const script = `
    import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm';
    const root=path.resolve(process.argv[1]); const modules=new Map();
    function load(file) {
      file=path.resolve(file);
      if(!file.startsWith(root+path.sep)) throw new Error('module escaped web root');
      if(!modules.has(file)) modules.set(file,new vm.SourceTextModule(fs.readFileSync(file,'utf8'),{identifier:file}));
      return modules.get(file);
    }
    const entry=new vm.SourceTextModule("import './app.js'; import './diagnostics.js'; import './summaries.js';",{identifier:path.join(root,'entry.js')});
    await entry.link((specifier, module)=>load(path.resolve(path.dirname(module.identifier),specifier)));
    console.log(JSON.stringify([...modules.keys()].map(file=>path.relative(root,file).split(path.sep).join('/'))));
  `;
  const checked = spawnSync(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", script, root], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  const assets = JSON.parse(checked.stdout);
  assert.ok(assets.length >= 18);
  for (const name of assets) {
    const response = createResponse();
    await handleWebConsoleRequest(createRequest("127.0.0.1"), response, { enabled: true, pathname: "/console/" + name });
    assert.equal(response.statusCode, 200, name);
    assert.match(response.headers["Content-Type"], /javascript/);
  }
  assert.ok((await fs.readFile(path.join(root, "app.js"), "utf8")).split("\n").length < 600);
});

test("web console serves allowlisted assets only to loopback clients", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qqfriend-console-test-"));
  await fs.writeFile(path.join(root, "index.html"), "<h1>QQFriend</h1>", "utf8");
  try {
    const response = createResponse();
    const handled = await handleWebConsoleRequest(
      createRequest("127.0.0.1"),
      response,
      { enabled: true, pathname: "/console/", root }
    );
    assert.equal(handled, true);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.toString("utf8"), "<h1>QQFriend</h1>");
    assert.match(response.headers["Content-Security-Policy"], /default-src 'self'/);
    assert.equal(response.headers["X-Frame-Options"], "DENY");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("web console is hidden from non-loopback clients", async () => {
  const response = createResponse();
  const handled = await handleWebConsoleRequest(
    createRequest("192.0.2.10"),
    response,
    { enabled: true, pathname: "/console/" }
  );
  assert.equal(handled, true);
  assert.equal(response.statusCode, 404);
});

test("web console accepts a private Docker gateway only in container mode", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qqfriend-console-docker-test-"));
  await fs.writeFile(path.join(root, "index.html"), "<h1>Container</h1>", "utf8");
  try {
    const denied = createResponse();
    await handleWebConsoleRequest(createRequest("172.18.0.1"), denied, {
      enabled: true,
      pathname: "/console/",
      root,
      containerized: false,
    });
    assert.equal(denied.statusCode, 404);

    const allowed = createResponse();
    await handleWebConsoleRequest(createRequest("172.18.0.1"), allowed, {
      enabled: true,
      pathname: "/console/",
      root,
      containerized: true,
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.body.toString("utf8"), "<h1>Container</h1>");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("web console rejects unknown and traversal-like asset paths", async () => {
  for (const pathname of ["/console/../package.json", "/console/secrets", "/console/app.js.map"]) {
    const response = createResponse();
    const handled = await handleWebConsoleRequest(
      createRequest("::1"),
      response,
      { enabled: true, pathname }
    );
    assert.equal(handled, true);
    assert.equal(response.statusCode, 404);
  }
});

function createRequest(remoteAddress, method = "GET") {
  return { method, socket: { remoteAddress } };
}

function createResponse() {
  return {
    body: Buffer.alloc(0),
    headers: {},
    statusCode: 0,
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(value) {
      this.body = value === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    },
  };
}
