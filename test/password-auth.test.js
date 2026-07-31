import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { afterEach, test } from "node:test";
import { createPasswordGate } from "../src/password-auth.js";

const resources = [];

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(
      ({ server, gate }) =>
        new Promise((resolve) => {
          gate.close();
          server.close(resolve);
          server.closeAllConnections?.();
        })
    )
  );
});

async function startServer() {
  const server = createServer((request, response) => {
    response.end("protected");
  });
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n");
  });
  const gate = await createPasswordGate("correct horse battery staple");
  gate.protectServer(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  resources.push({ server, gate });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test("redirects unauthenticated requests to the login page", async () => {
  const origin = await startServer();
  const response = await fetch(`${origin}/session/demo`, {
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    "/__seniman_meja/login?next=%2Fsession%2Fdemo"
  );
});

test("login creates a session that gates protected requests", async () => {
  const origin = await startServer();
  const failed = await fetch(`${origin}/__seniman_meja/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: "wrong", next: "/session/2" }),
  });
  assert.equal(failed.status, 401);
  assert.equal(failed.headers.get("set-cookie"), null);

  const login = await fetch(`${origin}/__seniman_meja/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      password: "correct horse battery staple",
      next: "/session/2",
    }),
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("location"), "/session/2");
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];

  const protectedResponse = await fetch(`${origin}/session/2`, {
    headers: { Cookie: cookie },
  });
  assert.equal(protectedResponse.status, 200);
  assert.equal(await protectedResponse.text(), "protected");
});

test("rejects unauthenticated WebSocket upgrades", async () => {
  const origin = await startServer();
  const { hostname, port } = new URL(origin);
  const response = await new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname);
    let data = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.once("end", () => resolve(data));
    socket.once("connect", () => {
      socket.write(
        "GET / HTTP/1.1\r\n" +
        `Host: ${hostname}:${port}\r\n` +
        `Origin: ${origin}\r\n` +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: dGVzdC13ZWJzb2NrZXQta2V5\r\n\r\n"
      );
    });
  });
  assert.match(response, /^HTTP\/1\.1 401 Unauthorized\r\n/);
});
