import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const COOKIE_NAME = "seniman_meja_session";
const LOGIN_PATH = "/__seniman_meja/login";
const LOGOUT_PATH = "/__seniman_meja/logout";
const MAX_PASSWORD_BYTES = 1024;
const MAX_LOGIN_BODY_BYTES = 8 << 10;
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const LOGIN_ATTEMPTS_PER_MINUTE = 5;

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function safeNextPath(value) {
  return value && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/";
}

function requestUrl(request) {
  return new URL(request.url || "/", "http://seniman-meja.local");
}

function parseCookies(header) {
  const cookies = new Map();
  for (const item of (header || "").split(";")) {
    const separator = item.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function isSecureRequest(request) {
  if (request.socket.encrypted) {
    return true;
  }
  return (request.headers["x-forwarded-proto"] || "")
    .split(",", 1)[0]
    .trim()
    .toLowerCase() === "https";
}

function sessionCookie(request, token, maxAge) {
  const attributes = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (isSecureRequest(request)) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

function loginPage(next, message = "") {
  const escapedNext = escapeHtml(safeNextPath(next));
  const status = message
    ? `<p class="error" role="alert">${escapeHtml(message)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in · seniman-meja</title>
  <style>
    :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #101318; color: #d8dee9; }
    main { width: min(360px, calc(100% - 32px)); padding: 24px; border: 1px solid #343b46; border-radius: 8px; background: #171b22; }
    h1 { margin: 0 0 20px; font-size: 18px; font-weight: 600; }
    label { display: block; margin-bottom: 8px; font-size: 13px; }
    input, button { width: 100%; min-height: 42px; border-radius: 5px; font: inherit; }
    input { padding: 8px 10px; border: 1px solid #4b5563; background: #0f1217; color: inherit; }
    input:focus { outline: 2px solid #78a9ff; outline-offset: 1px; }
    button { margin-top: 14px; border: 0; background: #78a9ff; color: #0b1020; font-weight: 700; cursor: pointer; }
    .error { margin: 0 0 14px; color: #ff8f8f; font-size: 13px; }
  </style>
</head>
<body>
  <main>
    <h1>seniman-meja</h1>
    ${status}
    <form method="post" action="${LOGIN_PATH}">
      <input type="hidden" name="next" value="${escapedNext}">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
      <button type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>`;
}

function sendHtml(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function redirect(response, location, headers = {}) {
  response.writeHead(303, {
    "Cache-Control": "no-store",
    Location: location,
    ...headers,
  });
  response.end();
}

async function readLoginBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_LOGIN_BODY_BYTES) {
      throw new Error("login request is too large");
    }
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function rejectUpgrade(socket, statusCode, statusText) {
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
    "Connection: close\r\n" +
    "Content-Length: 0\r\n\r\n"
  );
}

export async function promptForPassword(
  input = process.stdin,
  output = process.stdout
) {
  if (!input.isTTY || !output.isTTY || !input.setRawMode) {
    throw new Error(
      "an interactive terminal is required to enter the web password"
    );
  }

  output.write("seniman-meja password: ");
  const previousRawMode = input.isRaw;
  const wasPaused = input.isPaused();
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let password = "";
    const finish = (error) => {
      input.off("data", onData);
      input.setRawMode(previousRawMode);
      if (wasPaused) {
        input.pause();
      }
      output.write("\n");
      if (error) {
        reject(error);
      } else if (!password) {
        reject(new Error("password cannot be empty"));
      } else {
        resolve(password);
      }
    };
    const onData = (data) => {
      for (const character of data) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003") {
          finish(new Error("password prompt cancelled"));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (password) {
            password = Array.from(password).slice(0, -1).join("");
            output.write("\b \b");
          }
          continue;
        }
        if (character >= " " && character !== "\u007f") {
          if (Buffer.byteLength(password + character) > MAX_PASSWORD_BYTES) {
            continue;
          }
          password += character;
          output.write("*");
        }
      }
    };
    input.on("data", onData);
  });
}

export async function createPasswordGate(password) {
  const salt = randomBytes(16);
  const passwordHash = Buffer.from(
    await scrypt(password, salt, 64)
  );
  const sessions = new Map();
  const attempts = new Map();

  const removeSession = (token) => {
    const session = sessions.get(token);
    if (!session) {
      return;
    }
    sessions.delete(token);
    for (const socket of session.sockets) {
      socket.destroy();
    }
    session.sockets.clear();
  };

  const sessionForRequest = (request) => {
    const token = parseCookies(request.headers.cookie).get(COOKIE_NAME);
    const session = token && sessions.get(token);
    if (!session) {
      return null;
    }
    if (session.expiresAt <= Date.now()) {
      removeSession(token);
      return null;
    }
    return { token, session };
  };

  const verifyPassword = async (candidate) => {
    if (
      !candidate ||
      Buffer.byteLength(candidate) > MAX_PASSWORD_BYTES
    ) {
      return false;
    }
    const candidateHash = Buffer.from(
      await scrypt(candidate, salt, passwordHash.length)
    );
    return timingSafeEqual(candidateHash, passwordHash);
  };

  const consumeAttempt = (address) => {
    const now = Date.now();
    let state = attempts.get(address);
    if (!state || now - state.startedAt >= 60_000) {
      state = { startedAt: now, count: 0 };
      attempts.set(address, state);
    }
    if (state.count >= LOGIN_ATTEMPTS_PER_MINUTE) {
      return false;
    }
    state.count += 1;
    return true;
  };

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) {
        removeSession(token);
      }
    }
    for (const [address, state] of attempts) {
      if (now - state.startedAt >= 60_000) {
        attempts.delete(address);
      }
    }
  }, 60_000);
  cleanup.unref();

  return {
    protectServer(server) {
      const requestListeners = server.listeners("request");
      const upgradeListeners = server.listeners("upgrade");
      if (requestListeners.length !== 1 || upgradeListeners.length !== 1) {
        throw new Error(
          "cannot install password authentication on this Seniman server"
        );
      }
      const requestListener = requestListeners[0];
      const upgradeListener = upgradeListeners[0];
      server.removeListener("request", requestListener);
      server.removeListener("upgrade", upgradeListener);

      server.on("request", async (request, response) => {
        try {
          const url = requestUrl(request);
          if (url.pathname === LOGIN_PATH) {
            const next = safeNextPath(
              request.method === "POST"
                ? "/"
                : url.searchParams.get("next")
            );
            if (request.method === "GET") {
              if (sessionForRequest(request)) {
                redirect(response, next);
              } else {
                sendHtml(response, 200, loginPage(next));
              }
              return;
            }
            if (request.method !== "POST") {
              response.writeHead(405, { Allow: "GET, POST" });
              response.end();
              return;
            }

            const address = request.socket.remoteAddress || "unknown";
            if (!consumeAttempt(address)) {
              response.writeHead(429, {
                "Cache-Control": "no-store",
                "Retry-After": "60",
              });
              response.end("Too many login attempts\n");
              return;
            }
            const form = await readLoginBody(request);
            const formNext = safeNextPath(form.get("next"));
            if (!(await verifyPassword(form.get("password")))) {
              sendHtml(
                response,
                401,
                loginPage(formNext, "Incorrect password")
              );
              return;
            }

            attempts.delete(address);
            const token = randomBytes(32).toString("base64url");
            sessions.set(token, {
              expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
              sockets: new Set(),
            });
            redirect(response, formNext, {
              "Set-Cookie": sessionCookie(
                request,
                token,
                SESSION_TTL_SECONDS
              ),
            });
            return;
          }

          if (url.pathname === LOGOUT_PATH && request.method === "POST") {
            const authenticated = sessionForRequest(request);
            if (authenticated) {
              removeSession(authenticated.token);
            }
            redirect(response, LOGIN_PATH, {
              "Set-Cookie": sessionCookie(request, "", 0),
            });
            return;
          }

          if (!sessionForRequest(request)) {
            const next = safeNextPath(request.url || "/");
            redirect(
              response,
              `${LOGIN_PATH}?next=${encodeURIComponent(next)}`
            );
            return;
          }
          requestListener.call(server, request, response);
        } catch (error) {
          console.error(
            `seniman-meja: authentication error: ${error.message}`
          );
          if (!response.headersSent) {
            response.writeHead(400, { "Cache-Control": "no-store" });
          }
          response.end("Invalid login request\n");
        }
      });

      server.on("upgrade", (request, socket, head) => {
        const authenticated = sessionForRequest(request);
        if (!authenticated) {
          rejectUpgrade(socket, 401, "Unauthorized");
          return;
        }
        authenticated.session.sockets.add(socket);
        socket.once("close", () => {
          authenticated.session.sockets.delete(socket);
        });
        upgradeListener.call(server, request, socket, head);
      });
    },

    close() {
      clearInterval(cleanup);
      for (const token of sessions.keys()) {
        removeSession(token);
      }
      passwordHash.fill(0);
      salt.fill(0);
    },
  };
}
