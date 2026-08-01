import {
  createHash,
  randomFillSync,
  timingSafeEqual,
  X509Certificate,
} from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import quic from "@infisical/quic";
import { renderDiagnostics } from "./render-diagnostics.js";

const { QUICClient, events, native } = quic;
const silentLogger = {
  debug() {},
  info() {},
  getChild() {
    return silentLogger;
  },
};

const COMMAND_PROTOCOL_VERSION = 1;
const COMMAND_BOOTSTRAP_VERSION = 3;
const MEJA_ALPN = "meja-quic/15";
const MSG_FRONTEND_INPUT_BYTES = 1;
const MSG_FRONTEND_RESIZE = 2;
const MSG_CLIENT_LAYOUT = 3;
const MSG_SESSION_ATTACH = 4;
const MSG_SESSION_ATTACH_OK = 5;
const MSG_SESSION_ATTACH_FAILED = 6;
const MSG_FRONTEND_TERMINAL_WRITE = 9;
const MSG_FRONTEND_REGISTER_TERMINAL_EXIT_COMMAND = 10;
const MSG_FRONTEND_EXECUTE_TERMINAL_EXIT_COMMAND = 11;
const MSG_FRONTEND_TERMINAL_EXIT_COMPLETE = 12;
const MSG_CLIENT_STATUS = 13;
const MSG_FRONTEND_PROMPT_RESULT = 14;
const MAX_FRAME_SIZE = 4 << 20;
const MAX_STATUS_WINDOWS = 4096;
const MAX_STRING_LENGTH = 64 << 10;
const OUTPUT_STREAM_COUNT = 8;
const SESSION_REPLACED_ERROR_CODE = 0x54414c49;
const COMPACT_MULTI_PANE_COLUMNS = 72;
const STATUS_NORMAL = 1;
const STATUS_PROMPT = 2;
const STATUS_MESSAGE = 3;

const DISPLAY_START_RENDER = 0x01;
const DISPLAY_STYLE_INSTALL = 0x02;
const DISPLAY_SET_WRITE_POSITION = 0x03;
const DISPLAY_SET_WRITE_STYLE = 0x04;
const DISPLAY_WRITE_TEXT = 0x05;
const DISPLAY_WRITE_TEXT_UTF8 = 0x06;
const DISPLAY_WRITE_TEXT_UTF8_DEFAULT = 0x07;
const DISPLAY_FILL = 0x08;
const DISPLAY_CURSOR_UPDATE = 0x09;
const DISPLAY_SCROLL_REGION = 0x0a;
const RESET_CURSOR_REVEAL_MS = 50;
const DISPLAY_WRITE_CLUSTER = 0x0b;

const DEFAULT_STYLE = Object.freeze({
  bold: false,
  dim: false,
  blink: false,
  italic: false,
  underline: false,
  reverse: false,
  invisible: false,
  fg: Object.freeze({ mode: "default" }),
  bg: Object.freeze({ mode: "default" }),
});

function encodeUvarint(input) {
  let value = BigInt(input);
  const bytes = [];
  while (value >= 0x80n) {
    bytes.push(Number((value & 0x7fn) | 0x80n));
    value >>= 7n;
  }
  bytes.push(Number(value));
  return Buffer.from(bytes);
}

function encodeString(value) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([encodeUvarint(bytes.length), bytes]);
}

function encodeFrame(type, payload) {
  return Buffer.concat([
    encodeUvarint(type),
    encodeUvarint(payload.length),
    payload,
  ]);
}

function commandPacket(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function localSocketPath(options) {
  return options.socket ||
    join(homedir(), `.meja/${options.profile}/meja.sock`);
}

function sshOptions(options) {
  const args = [];
  if (options.identityFile) {
    args.push("-i", options.identityFile);
  }
  if (options.sshPort) {
    args.push("-p", String(options.sshPort));
  }
  return args;
}

function remoteForwardCommand(options) {
  const selector = options.socket
    ? ["-S", options.socket]
    : ["-L", options.profile];
  return [
    shellQuote(options.remotePath),
    ...selector.map(shellQuote),
    "__ssh-forward-v1",
  ].join(" ");
}

async function resolveSSHConnectionHost(options) {
  const command = spawn(
    "ssh",
    ["-G", ...sshOptions(options), options.sshHost],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let stdout = "";
  let stderr = "";
  command.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  command.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  await new Promise((resolve, reject) => {
    command.once("error", reject);
    command.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            stderr.trim() ||
            `ssh -G exited with status ${code ?? "unknown"}`
          )
        );
      }
    });
  });
  for (const line of stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (
      fields.length === 2 &&
      fields[0].toLowerCase() === "hostname" &&
      fields[1]
    ) {
      return fields[1];
    }
  }
  throw new Error("ssh -G returned no connection hostname");
}

async function runMejaCommand(options, args) {
  const request = {
    version: COMMAND_PROTOCOL_VERSION,
    args,
    workingDirectory: options.sshHost ? "" : process.cwd(),
    terminalCols: options.cols,
    terminalRows: options.rows + 1,
  };
  const packet = commandPacket(request);

  const chunks = [];
  let bufferedBytes = 0;
  let bootstrap;
  const stdout = [];
  let stderr = "";

  return new Promise((resolve, reject) => {
    let settled = false;
    let closeTransport = () => {};
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      closeTransport();
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    const onData = (chunk) => {
      chunks.push(chunk);
      bufferedBytes += chunk.length;
      let buffer = Buffer.concat(chunks, bufferedBytes);
      chunks.length = 0;
      bufferedBytes = 0;

      try {
        while (buffer.length >= 4) {
          const length = buffer.readUInt32BE(0);
          if (length === 0 || length > MAX_FRAME_SIZE) {
            throw new Error(`invalid command frame size ${length}`);
          }
          if (buffer.length < 4 + length) {
            break;
          }

          const frame = JSON.parse(
            buffer.subarray(4, 4 + length).toString("utf8")
          );
          buffer = buffer.subarray(4 + length);
          if (frame.version !== COMMAND_PROTOCOL_VERSION) {
            throw new Error(
              `unsupported command protocol version ${frame.version}`
            );
          }
          if (frame.type === "stdout" && frame.data) {
            stdout.push(Buffer.from(frame.data, "base64"));
          } else if (frame.type === "stderr" && frame.data) {
            stderr += Buffer.from(frame.data, "base64").toString("utf8");
          } else if (frame.type === "attach") {
            bootstrap = frame.bootstrap;
          } else if (frame.type === "exit") {
            finish(null, {
              stdout: Buffer.concat(stdout),
              stderr,
              exitCode: frame.exitCode ?? 0,
              bootstrap,
            });
            return;
          }
        }
      } catch (error) {
        finish(error);
        return;
      }

      if (buffer.length > 0) {
        chunks.push(buffer);
        bufferedBytes = buffer.length;
      }
    };

    if (options.sshHost) {
      const command = spawn(
        "ssh",
        [
          ...sshOptions(options),
          options.sshHost,
          remoteForwardCommand(options),
        ],
        { stdio: ["pipe", "pipe", "pipe"] }
      );
      let sshStderr = "";
      closeTransport = () => {
        command.stdin.destroy();
        command.stdout.destroy();
        command.stderr.destroy();
        command.kill();
      };
      command.stdout.on("data", onData);
      command.stdout.on("error", finish);
      command.stderr.on("data", (chunk) => {
        sshStderr += chunk.toString("utf8");
      });
      command.once("error", finish);
      command.once("close", (code) => {
        if (!settled) {
          const detail = sshStderr.trim();
          finish(
            new Error(
              detail ||
              (
                code === 0
                  ? "SSH command returned no exit frame"
                  : `SSH command exited with status ${code ?? "unknown"}`
              )
            )
          );
        }
      });
      command.stdin.on("error", (error) => {
        if (!settled && error.code !== "EPIPE") {
          finish(error);
        }
      });
      command.stdin.end(packet);
    } else {
      const socket = createConnection(localSocketPath(options));
      closeTransport = () => socket.destroy();
      socket.on("connect", () => socket.end(packet));
      socket.on("error", finish);
      socket.on("data", onData);
      socket.on("end", () => {
        if (!settled) {
          finish(
            new Error(
              "Meja command socket closed without an exit frame"
            )
          );
        }
      });
    }
  });
}

async function requestAttachmentGrant(options, args) {
  const result = await runMejaCommand(options, args);
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() ||
      `Meja command exited with ${result.exitCode}`
    );
  }
  if (!result.bootstrap) {
    throw new Error("Meja did not return an attachment grant");
  }
  if (result.bootstrap.version !== COMMAND_BOOTSTRAP_VERSION) {
    throw new Error(
      `unsupported bootstrap version ${result.bootstrap.version}`
    );
  }
  return {
    bootstrap: result.bootstrap,
    connectionHost: options.sshHost
      ? await resolveSSHConnectionHost(options)
      : "127.0.0.1",
  };
}

class EndOfStreamError extends Error {}

class AsyncBytes {
  constructor(iterable) {
    this.iterator = iterable[Symbol.asyncIterator]();
    this.buffers = [];
    this.offset = 0;
    this.ended = false;
  }

  async fill() {
    while (!this.ended && this.buffers.length === 0) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      const chunk = Buffer.from(next.value);
      if (chunk.length > 0) {
        this.buffers.push(chunk);
      }
    }
    return this.buffers.length > 0;
  }

  async byte() {
    if (!(await this.fill())) {
      throw new EndOfStreamError("unexpected end of stream");
    }
    const buffer = this.buffers[0];
    const value = buffer[this.offset];
    this.offset += 1;
    if (this.offset === buffer.length) {
      this.buffers.shift();
      this.offset = 0;
    }
    return value;
  }

  async exact(length) {
    const output = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      if (!(await this.fill())) {
        throw new EndOfStreamError("unexpected end of stream");
      }
      const buffer = this.buffers[0];
      const count = Math.min(
        length - written,
        buffer.length - this.offset
      );
      buffer.copy(output, written, this.offset, this.offset + count);
      written += count;
      this.offset += count;
      if (this.offset === buffer.length) {
        this.buffers.shift();
        this.offset = 0;
      }
    }
    return output;
  }

  async uvarint() {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = await this.byte();
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) {
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("uvarint exceeds JavaScript's safe integer range");
        }
        return Number(value);
      }
    }
    throw new Error("invalid uvarint");
  }

  async varint() {
    const value = await this.uvarint();
    return value & 1 ? -((value + 1) >> 1) : value >> 1;
  }

  async text() {
    const length = await this.uvarint();
    if (length > MAX_FRAME_SIZE) {
      throw new Error(`text exceeds ${MAX_FRAME_SIZE} bytes`);
    }
    return (await this.exact(length)).toString("utf8");
  }
}

class PayloadReader {
  constructor(payload) {
    this.payload = payload;
    this.offset = 0;
  }

  uvarint() {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (this.offset >= this.payload.length) {
        throw new Error("short payload");
      }
      const byte = this.payload[this.offset];
      this.offset += 1;
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) {
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("uvarint exceeds JavaScript's safe integer range");
        }
        return Number(value);
      }
    }
    throw new Error("invalid uvarint");
  }

  varint() {
    const value = this.uvarint();
    return value & 1 ? -((value + 1) >> 1) : value >> 1;
  }

  byte() {
    if (this.offset >= this.payload.length) {
      throw new Error("short payload");
    }
    const value = this.payload[this.offset];
    this.offset += 1;
    return value;
  }

  bool() {
    const value = this.byte();
    if (value !== 0 && value !== 1) {
      throw new Error(`invalid boolean ${value}`);
    }
    return value === 1;
  }

  string(maxLength = MAX_STRING_LENGTH) {
    const length = this.uvarint();
    if (length > maxLength || this.offset + length > this.payload.length) {
      throw new Error(`invalid string length ${length}`);
    }
    const value = this.payload.subarray(
      this.offset,
      this.offset + length
    );
    this.offset += length;
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  }

  text() {
    return this.string(MAX_FRAME_SIZE);
  }

  done() {
    if (this.offset !== this.payload.length) {
      throw new Error("trailing payload bytes");
    }
  }
}

async function readControlFrame(reader) {
  const type = await reader.uvarint();
  const length = await reader.uvarint();
  if (length > MAX_FRAME_SIZE) {
    throw new Error(`control frame exceeds ${MAX_FRAME_SIZE} bytes`);
  }
  return { type, payload: await reader.exact(length) };
}

async function readCanonicalRenderUvarint(reader) {
  let value = 0n;
  for (let index = 0; index < 10; index += 1) {
    const byte = await reader.byte();
    if (index === 9 && byte > 1) {
      throw new Error("render frame uvarint overflow");
    }
    value |= BigInt(byte & 0x7f) << BigInt(7 * index);
    if (byte < 0x80) {
      if (index > 0 && byte === 0) {
        throw new Error("overlong render frame uvarint");
      }
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("render frame uvarint exceeds safe integer range");
      }
      return Number(value);
    }
  }
  throw new Error("render frame uvarint overflow");
}

function validateRenderFrameHeader(flags, rawSize, encodedSize) {
  if ((flags & ~1) !== 0) {
    throw new Error(
      `render frame reserved flags 0x${(flags & ~1)
        .toString(16)
        .padStart(2, "0")} are set`
    );
  }
  if (
    rawSize === 0 ||
    encodedSize === 0 ||
    rawSize > MAX_FRAME_SIZE ||
    encodedSize > MAX_FRAME_SIZE
  ) {
    throw new Error(
      `invalid render frame sizes raw=${rawSize} encoded=${encodedSize}`
    );
  }
  if (flags === 0 && encodedSize !== rawSize) {
    throw new Error(
      `raw render size mismatch raw=${rawSize} encoded=${encodedSize}`
    );
  }
  if (flags === 1 && encodedSize >= rawSize) {
    throw new Error(
      `zlib render is not smaller raw=${rawSize} encoded=${encodedSize}`
    );
  }
}

async function readRenderFrame(reader, onFrame = null) {
  let flags;
  try {
    flags = await reader.byte();
  } catch (error) {
    if (error instanceof EndOfStreamError) {
      return null;
    }
    throw error;
  }

  let rawSize;
  let encodedSize;
  try {
    rawSize = await readCanonicalRenderUvarint(reader);
    encodedSize = await readCanonicalRenderUvarint(reader);
  } catch (error) {
    if (error instanceof EndOfStreamError) {
      throw new Error("truncated render frame header");
    }
    throw error;
  }
  validateRenderFrameHeader(flags, rawSize, encodedSize);

  let encoded;
  try {
    encoded = await reader.exact(encodedSize);
  } catch (error) {
    if (error instanceof EndOfStreamError) {
      throw new Error("truncated render frame payload");
    }
    throw error;
  }
  if (flags === 0) {
    onFrame?.({ flags, rawSize, encodedSize });
    return encoded;
  }

  let decoded;
  try {
    decoded = inflateSync(encoded, {
      info: true,
      maxOutputLength: rawSize + 1,
    });
  } catch (error) {
    throw new Error(`invalid render zlib payload: ${error.message}`);
  }
  if (decoded.buffer.length !== rawSize) {
    throw new Error(
      `render zlib output size ${decoded.buffer.length}, expected ${rawSize}`
    );
  }
  if (decoded.engine.bytesWritten !== encodedSize) {
    throw new Error("render zlib payload has trailing bytes");
  }
  onFrame?.({ flags, rawSize, encodedSize });
  return decoded.buffer;
}

function decodePayloadString(payload) {
  const reader = new PayloadReader(payload);
  const length = reader.uvarint();
  const start = reader.offset;
  const end = start + length;
  if (end !== payload.length) {
    throw new Error("invalid string payload");
  }
  return payload.subarray(start, end).toString("utf8");
}

function decodeOSC52ClipboardWrite(payload) {
  const prefix = Buffer.from("\x1b]52;", "ascii");
  if (
    payload.length < prefix.length + 3 ||
    !payload.subarray(0, prefix.length).equals(prefix)
  ) {
    return null;
  }

  let contentEnd;
  if (
    payload.length >= 2 &&
    payload[payload.length - 2] === 0x1b &&
    payload[payload.length - 1] === 0x5c
  ) {
    contentEnd = payload.length - 2;
  } else if (payload[payload.length - 1] === 0x07) {
    contentEnd = payload.length - 1;
  } else {
    return null;
  }

  const separator = payload.indexOf(0x3b, prefix.length);
  if (separator < 0 || separator >= contentEnd) {
    return null;
  }
  const target = payload
    .subarray(prefix.length, separator)
    .toString("ascii");
  if (!target || !/^[cps0-7]+$/.test(target)) {
    return null;
  }

  const encoded = payload
    .subarray(separator + 1, contentEnd)
    .toString("ascii");
  if (
    encoded === "?" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded
    )
  ) {
    return null;
  }
  return Buffer.from(encoded, "base64").toString("utf8");
}

function decodeClientLayout(payload) {
  const reader = new PayloadReader(payload);
  const layout = {
    windowId: reader.uvarint(),
    focusedPaneId: reader.uvarint(),
    revision: reader.uvarint(),
    panes: [],
  };
  const paneCount = reader.uvarint();
  if (paneCount > 8) {
    throw new Error(`invalid pane count ${paneCount}`);
  }
  for (let index = 0; index < paneCount; index += 1) {
    layout.panes.push({
      paneId: reader.uvarint(),
      slot: reader.uvarint(),
      rect: {
        x: reader.uvarint(),
        y: reader.uvarint(),
        width: reader.uvarint(),
        height: reader.uvarint(),
      },
    });
  }
  reader.done();
  return layout;
}

function decodeClientStatus(payload) {
  const reader = new PayloadReader(payload);
  const status = {
    revision: reader.uvarint(),
    sessionId: reader.uvarint(),
    sessionName: reader.string(),
    serverHostname: reader.string(),
    serverHome: reader.string(),
    root: reader.string(),
    windows: [],
  };
  if (status.revision === 0) {
    throw new Error("CLIENT_STATUS has zero revision");
  }

  const windowCount = reader.uvarint();
  if (windowCount > MAX_STATUS_WINDOWS) {
    throw new Error(`invalid status window count ${windowCount}`);
  }
  for (let index = 0; index < windowCount; index += 1) {
    status.windows.push({
      windowId: reader.uvarint(),
      index: reader.uvarint(),
      title: reader.string(),
      active: reader.bool(),
      zoomed: reader.bool(),
    });
  }

  status.kind = reader.byte();
  status.prompt = {
    promptId: reader.uvarint(),
    mode: reader.byte(),
    label: reader.string(),
    initial: reader.string(),
  };
  status.message = {
    id: reader.uvarint(),
    text: reader.string(),
  };
  reader.done();

  if (status.kind < STATUS_NORMAL || status.kind > STATUS_MESSAGE) {
    throw new Error(`invalid status presentation kind ${status.kind}`);
  }
  if (
    status.kind === STATUS_PROMPT &&
    (
      status.prompt.promptId === 0 ||
      status.prompt.mode < 1 ||
      status.prompt.mode > 2
    )
  ) {
    throw new Error("invalid CLIENT_STATUS prompt descriptor");
  }
  return status;
}


async function readColor(reader) {
  const kind = await reader.byte();
  if (kind === 0) {
    return { mode: "default" };
  }
  if (kind === 1) {
    return { mode: "indexed", index: await reader.byte() };
  }
  if (kind === 2) {
    return {
      mode: "rgb",
      r: await reader.byte(),
      g: await reader.byte(),
      b: await reader.byte(),
    };
  }
  throw new Error(`unknown color kind ${kind}`);
}

async function readStyle(reader) {
  const flags = await reader.uvarint();
  return {
    bold: Boolean(flags & (1 << 0)),
    dim: Boolean(flags & (1 << 1)),
    italic: Boolean(flags & (1 << 2)),
    underline: Boolean(flags & (1 << 3)),
    reverse: Boolean(flags & (1 << 4)),
    blink: Boolean(flags & (1 << 5)),
    invisible: Boolean(flags & (1 << 6)),
    fg: await readColor(reader),
    bg: await readColor(reader),
  };
}

async function readDisplayCommand(reader) {
  const opcode = await reader.byte();
  const command = { opcode };
  switch (opcode) {
    case DISPLAY_START_RENDER:
      command.revision = await reader.uvarint();
      command.cols = await reader.uvarint();
      command.rows = await reader.uvarint();
      break;
    case DISPLAY_STYLE_INSTALL:
      command.styleId = await reader.uvarint();
      command.style = await readStyle(reader);
      break;
    case DISPLAY_SET_WRITE_POSITION:
      command.row = await reader.uvarint();
      command.column = await reader.uvarint();
      break;
    case DISPLAY_SET_WRITE_STYLE:
      command.styleId = await reader.uvarint();
      break;
    case DISPLAY_WRITE_TEXT:
    case DISPLAY_WRITE_CLUSTER:
      command.width = await reader.byte();
      command.text = await reader.text();
      break;
    case DISPLAY_WRITE_TEXT_UTF8:
    case DISPLAY_WRITE_TEXT_UTF8_DEFAULT:
      command.width = 1;
      command.text = await reader.text();
      break;
    case DISPLAY_FILL:
      command.columns = await reader.uvarint();
      command.rune = String.fromCodePoint(await reader.uvarint());
      command.width = await reader.byte();
      break;
    case DISPLAY_CURSOR_UPDATE:
      command.x = await reader.uvarint();
      command.y = await reader.uvarint();
      {
        const visible = await reader.byte();
        if (visible !== 0 && visible !== 1) {
          throw new Error(`invalid cursor visibility ${visible}`);
        }
        command.visible = visible === 1;
      }
      break;
    case DISPLAY_SCROLL_REGION:
      command.top = await reader.uvarint();
      command.bottom = await reader.uvarint();
      command.delta = await reader.varint();
      break;
    default:
      throw new Error(
        `unknown display opcode 0x${opcode.toString(16).padStart(2, "0")}`
      );
  }
  return command;
}

function blankCell(styleId = 0) {
  return { text: "", styleId, width: 1 };
}

function colorsMatch(left, right) {
  return (
    left.mode === right.mode &&
    left.index === right.index &&
    left.r === right.r &&
    left.g === right.g &&
    left.b === right.b
  );
}

function stylesMatch(left, right) {
  return (
    left.bold === right.bold &&
    left.dim === right.dim &&
    left.blink === right.blink &&
    left.italic === right.italic &&
    left.underline === right.underline &&
    left.reverse === right.reverse &&
    left.invisible === right.invisible &&
    colorsMatch(left.fg, right.fg) &&
    colorsMatch(left.bg, right.bg)
  );
}

class PaneScreen {
  constructor(slot, onPresent) {
    this.slot = slot;
    this.onPresent = onPresent;
    this.cols = 0;
    this.rows = 0;
    this.revision = 0;
    this.cells = [];
    this.styles = new Map([[0, DEFAULT_STYLE]]);
    this.row = 0;
    this.column = 0;
    this.styleId = 0;
    this.hasBarrier = false;
    this.cursor = { x: 0, y: 0, visible: true };
    this.dirtyRows = new Set();
    this.presentCount = 0;
    this.resetPending = false;
    this.styleResetPending = false;
    this.pendingStyleInstalls = [];
    this.pendingScrollRegions = [];
    this.cursorUpdatePending = false;
  }

  beginFrame() {
    const staged = Object.assign(
      Object.create(PaneScreen.prototype),
      this
    );
    staged.cells = this.cells.slice();
    staged._sharedRows = new WeakSet(this.cells);
    staged._stylesShared = true;
    staged.dirtyRows = new Set();
    staged.resetPending = false;
    staged.styleResetPending = false;
    staged.pendingStyleInstalls = [];
    staged.pendingScrollRegions = [];
    staged.cursorUpdatePending = false;
    staged._framePaintStarted = false;
    staged._frameScrollSeen = false;
    return staged;
  }

  ensureMutableRow(row) {
    const cells = this.cells[row];
    if (cells && this._sharedRows?.has(cells)) {
      this.cells[row] = cells.slice();
    }
  }

  ensureMutableStyles() {
    if (this._stylesShared) {
      this.styles = new Map(this.styles);
      this._stylesShared = false;
    }
  }

  commitFrame(staged) {
    Object.assign(this, staged);
    delete this._sharedRows;
    delete this._stylesShared;
    delete this._framePaintStarted;
    delete this._frameScrollSeen;
    this.presentCount += 1;
    renderDiagnostics.screenFrame(this);
    this.onPresent(this);
    this.dirtyRows.clear();
    this.resetPending = false;
    this.styleResetPending = false;
    this.pendingStyleInstalls = [];
    this.pendingScrollRegions = [];
    this.cursorUpdatePending = false;
  }

  reset(cols, rows, revision) {
    if (
      cols <= 0 ||
      rows <= 0 ||
      cols > 1024 ||
      rows > 1024
    ) {
      throw new Error(`invalid display grid ${cols}x${rows}`);
    }
    this.cols = cols;
    this.rows = rows;
    this.revision = revision;
    this.cells = Array.from(
      { length: rows },
      () => Array.from({ length: cols }, () => blankCell())
    );
    this.styles = new Map([[0, DEFAULT_STYLE]]);
    this.row = 0;
    this.column = 0;
    this.styleId = 0;
    this.hasBarrier = true;
    this.cursor = { x: 0, y: 0, visible: true };
    this.dirtyRows = new Set(
      Array.from({ length: rows }, (_, index) => index)
    );
    this.resetPending = true;
    this.styleResetPending = true;
    this.pendingScrollRegions = [];
    this.pendingStyleInstalls = [{
      id: 0,
      style: DEFAULT_STYLE,
    }];
    this.cursorUpdatePending = false;
    this._sharedRows = null;
    this._stylesShared = false;
  }

  clearOccupant(row, column) {
    if (
      row < 0 ||
      row >= this.rows ||
      column < 0 ||
      column >= this.cols
    ) {
      return;
    }
    this.ensureMutableRow(row);
    const cells = this.cells[row];
    let anchor = column;
    if (
      cells[column].width === 0 &&
      column > 0 &&
      cells[column - 1].width === 2
    ) {
      anchor = column - 1;
    }
    const previous = cells[anchor];
    cells[anchor] = blankCell(previous.styleId);
    if (
      previous.width === 2 &&
      anchor + 1 < this.cols
    ) {
      cells[anchor + 1] = blankCell(previous.styleId);
    }
  }

  writeCell(text, width, styleId) {
    if (
      (width !== 1 && width !== 2) ||
      this.row < 0 ||
      this.row >= this.rows ||
      this.column < 0 ||
      this.column + width > this.cols
    ) {
      throw new Error(
        `write at ${this.row},${this.column} width ${width} outside ` +
        `${this.cols}x${this.rows} grid`
      );
    }
    this.clearOccupant(this.row, this.column);
    if (width === 2) {
      this.clearOccupant(this.row, this.column + 1);
    }
    const cells = this.cells[this.row];
    cells[this.column] = { text, styleId, width };
    for (let index = 1; index < width; index += 1) {
      cells[this.column + index] = { text: "", styleId, width: 0 };
    }
    this.dirtyRows.add(this.row);
    this.advance(width);
  }

  advance(columns) {
    this.column += columns;
    if (this.column === this.cols) {
      this.row += 1;
      this.column = 0;
    }
  }

  scrollRegion(top, bottom, delta) {
    const height = bottom - top;
    if (
      !Number.isSafeInteger(top) ||
      !Number.isSafeInteger(bottom) ||
      !Number.isSafeInteger(delta) ||
      top < 0 ||
      top >= bottom ||
      bottom > this.rows ||
      delta === 0 ||
      Math.abs(delta) > height
    ) {
      throw new Error(
        `invalid scroll region [${top},${bottom}) delta ${delta} ` +
        `for ${this.cols}x${this.rows} grid`
      );
    }

    const count = Math.abs(delta);
    const blanks = Array.from(
      { length: count },
      () => Array.from({ length: this.cols }, () => blankCell())
    );
    const region = this.cells.slice(top, bottom);
    const replacement =
      delta < 0
        ? region.slice(count).concat(blanks)
        : blanks.concat(region.slice(0, height - count));
    this.cells.splice(top, height, ...replacement);
    this.pendingScrollRegions.push({ top, bottom, delta });

    const shiftedDirtyRows = new Set();
    for (const row of this.dirtyRows) {
      if (row < top || row >= bottom) {
        shiftedDirtyRows.add(row);
        continue;
      }
      const shifted = row + delta;
      if (shifted >= top && shifted < bottom) {
        shiftedDirtyRows.add(shifted);
      }
    }
    if (delta < 0) {
      for (let row = bottom - count; row < bottom; row += 1) {
        shiftedDirtyRows.add(row);
      }
    } else {
      for (let row = top; row < top + count; row += 1) {
        shiftedDirtyRows.add(row);
      }
    }
    if (this.cursor.visible && this.cursor.y >= top && this.cursor.y < bottom) {
      const movedCursorRow = this.cursor.y + delta;
      if (movedCursorRow >= top && movedCursorRow < bottom) {
        // The surviving row component still contains the old cursor class
        // after it moves with the region, so repaint that destination too.
        shiftedDirtyRows.add(movedCursorRow);
      }
      // Terminal scrolling moves content, not the cursor coordinate.
      shiftedDirtyRows.add(this.cursor.y);
    }
    this.dirtyRows = shiftedDirtyRows;
  }

  apply(command) {
    if (
      command.opcode !== DISPLAY_START_RENDER &&
      !this.hasBarrier
    ) {
      throw new Error(
        `display opcode 0x${command.opcode
          .toString(16)
          .padStart(2, "0")} before START_RENDER`
      );
    }
    switch (command.opcode) {
      case DISPLAY_START_RENDER:
        this.reset(command.cols, command.rows, command.revision);
        this._framePaintStarted = false;
        this._frameScrollSeen = false;
        break;
      case DISPLAY_STYLE_INSTALL:
        if (
          command.styleId === 0 &&
          !stylesMatch(command.style, DEFAULT_STYLE)
        ) {
          throw new Error("invalid canonical default style");
        }
        if (this.styles.has(command.styleId)) {
          if (!stylesMatch(this.styles.get(command.styleId), command.style)) {
            throw new Error(`style ${command.styleId} redefined`);
          }
        } else {
          this.ensureMutableStyles();
          this.styles.set(command.styleId, command.style);
          this.pendingStyleInstalls.push({
            id: command.styleId,
            style: command.style,
          });
        }
        break;
      case DISPLAY_SET_WRITE_POSITION:
        if (
          command.row < 0 ||
          command.row >= this.rows ||
          command.column < 0 ||
          command.column >= this.cols
        ) {
          throw new Error(
            `write position ${command.row},${command.column} outside ` +
            `${this.cols}x${this.rows} grid`
          );
        }
        this.row = command.row;
        this.column = command.column;
        break;
      case DISPLAY_SET_WRITE_STYLE:
        if (!this.styles.has(command.styleId)) {
          throw new Error(`undefined style ${command.styleId}`);
        }
        this.styleId = command.styleId;
        break;
      case DISPLAY_WRITE_TEXT:
      case DISPLAY_WRITE_TEXT_UTF8:
      case DISPLAY_WRITE_TEXT_UTF8_DEFAULT: {
        const styleId =
          command.opcode === DISPLAY_WRITE_TEXT_UTF8_DEFAULT
            ? 0
            : this.styleId;
        for (const character of command.text) {
          this.writeCell(
            character === " " ? "" : character,
            command.width,
            styleId
          );
        }
        this._framePaintStarted = true;
        break;
      }
      case DISPLAY_WRITE_CLUSTER:
        if (!command.text) {
          throw new Error("empty display cluster");
        }
        this.writeCell(command.text, command.width, this.styleId);
        this._framePaintStarted = true;
        break;
      case DISPLAY_FILL:
        if (
          command.columns <= 0 ||
          (command.width !== 1 && command.width !== 2) ||
          command.columns % command.width !== 0
        ) {
          throw new Error(
            `invalid fill width ${command.width} for ` +
            `${command.columns} columns`
          );
        }
        for (
          let columns = 0;
          columns < command.columns;
          columns += command.width
        ) {
          this.writeCell(
            command.rune === " " ? "" : command.rune,
            command.width,
            this.styleId
          );
        }
        this._framePaintStarted = true;
        break;
      case DISPLAY_CURSOR_UPDATE: {
        const previousRow = this.cursor.y;
        this.cursorUpdatePending = true;
        this.cursor = {
          x: command.x,
          y: command.y,
          visible: command.visible,
        };
        if (previousRow >= 0 && previousRow < this.rows) {
          this.dirtyRows.add(previousRow);
        }
        if (command.y >= 0 && command.y < this.rows) {
          this.dirtyRows.add(command.y);
        }
        break;
      }
      case DISPLAY_SCROLL_REGION:
        if (this._framePaintStarted || this._frameScrollSeen) {
          throw new Error(
            "SCROLL_REGION must precede paint and occur once per frame"
          );
        }
        this.scrollRegion(command.top, command.bottom, command.delta);
        this._frameScrollSeen = true;
        break;
      default:
        throw new Error(`unsupported display opcode ${command.opcode}`);
    }
  }
}

const ansi16 = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510",
  "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543",
  "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
];

function indexedColor(index) {
  if (index < 16) {
    return ansi16[index];
  }
  if (index < 232) {
    const value = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const r = levels[Math.floor(value / 36)];
    const g = levels[Math.floor((value % 36) / 6)];
    const b = levels[value % 6];
    return `rgb(${r}, ${g}, ${b})`;
  }
  const level = 8 + (index - 232) * 10;
  return `rgb(${level}, ${level}, ${level})`;
}

function colorValue(color, fallback) {
  if (color.mode === "rgb") {
    return `rgb(${color.r}, ${color.g}, ${color.b})`;
  }
  if (color.mode === "indexed") {
    return indexedColor(color.index);
  }
  return fallback;
}

function styleRule(slot, styleId, style) {
  const defaultForeground = "#d8dee9";
  const defaultBackground = "#101318";
  let foreground = colorValue(style.fg, defaultForeground);
  let background = colorValue(style.bg, defaultBackground);
  if (style.reverse) {
    [foreground, background] = [background, foreground];
  }
  const declarations = [];
  if (foreground !== defaultForeground) {
    declarations.push(`--mj-fg:${foreground}`);
  }
  if (background !== defaultBackground) {
    declarations.push(`--mj-bg:${background}`);
  }
  if (style.bold) {
    declarations.push("font-weight:700");
  }
  if (style.italic) {
    declarations.push("font-style:italic");
  }
  if (style.underline) {
    declarations.push("text-decoration:underline");
  }
  if (style.dim) {
    declarations.push("opacity:0.68");
  }
  if (style.invisible) {
    declarations.push("visibility:hidden");
  }
  return {
    id: styleId,
    text: `.mjp${slot}s${styleId}{${declarations.join(";")}}`,
  };
}

function styleClass(slot, styleId, cursor) {
  return (
    `mjp${slot}s${styleId}` +
    (cursor ? " __mjc" : "")
  );
}

function rowSnapshot(screen, rowIndex, showCursor = true) {
  renderDiagnostics.rowSnapshot(screen.cols);
  const cells = [];
  const screenCells = screen.cells[rowIndex];
  for (let column = 0; column < screen.cols; column += 1) {
    const cell = screenCells[column];
    if (cell.width === 0) {
      cells.push({ continuation: true });
      continue;
    }
    const cursor =
      showCursor &&
      screen.cursor.visible &&
      screen.cursor.y === rowIndex &&
      screen.cursor.x === column;
    const key = `${cell.styleId}:${cursor ? 1 : 0}`;
    cells.push({
      key,
      text: cell.text || " ",
      width: cell.width,
      className: styleClass(screen.slot, cell.styleId, cursor),
    });
  }
  return {
    id: `${screen.revision}:${screen.presentCount}:${rowIndex}`,
    cells,
  };
}

function cellMatches(left, right) {
  if (!left || !right) {
    return false;
  }
  if (left.continuation || right.continuation) {
    return left.continuation === right.continuation;
  }
  return (
    left.key === right.key &&
    left.text === right.text &&
    left.width === right.width
  );
}

function paneAt(placements, column, row) {
  return placements.find(({ rect }) =>
    column >= rect.x &&
    column < rect.x + rect.width &&
    row >= rect.y &&
    row < rect.y + rect.height
  );
}

function spanRuns(snapshot, start = 0, end = snapshot.cells.length) {
  const runs = [];
  for (let column = start; column < end; column += 1) {
    const cell = snapshot.cells[column];
    if (!cell || cell.continuation) {
      continue;
    }
    const runEnd = Math.min(column + cell.width, end);
    const previous = runs[runs.length - 1];
    const spaceOnly = cell.text === " ";
    if (
      previous &&
      previous.key === cell.key &&
      previous.end === column &&
      previous.spaceOnly === spaceOnly
    ) {
      if (!spaceOnly) {
        previous.text += cell.text;
      }
      previous.end = runEnd;
    } else {
      runs.push({
        key: cell.key,
        text: cell.text,
        spaceOnly,
        className: cell.className,
        start: column,
        end: runEnd,
      });
    }
  }
  return runs;
}


class PromptInputDecoder {
  constructor() {
    this.pending = "";
    this.pasting = false;
    this.paste = "";
    this.pasteOverflow = false;
  }

  reset() {
    this.pending = "";
    this.pasting = false;
    this.paste = "";
    this.pasteOverflow = false;
  }

  feed(data, sourceIdle) {
    this.pending += data;
    const events = [];
    const pasteEnd = "\x1b[201~";

    while (this.pending.length > 0) {
      if (this.pasting) {
        const combined = this.paste + this.pending;
        const end = combined.indexOf(pasteEnd);
        this.pending = "";
        if (end < 0) {
          this.paste = combined;
          if (
            !this.pasteOverflow &&
            Buffer.byteLength(this.paste, "utf8") >
              MAX_STRING_LENGTH + pasteEnd.length
          ) {
            this.pasteOverflow = true;
            this.paste = this.paste.slice(-(pasteEnd.length - 1));
          } else if (this.pasteOverflow) {
            this.paste = this.paste.slice(-(pasteEnd.length - 1));
          }
          break;
        }
        const pastedText = combined.slice(0, end);
        this.pending = combined.slice(end + pasteEnd.length);
        if (
          !this.pasteOverflow &&
          Buffer.byteLength(pastedText, "utf8") <= MAX_STRING_LENGTH
        ) {
          events.push({ kind: "paste", text: pastedText });
        }
        this.pasting = false;
        this.paste = "";
        this.pasteOverflow = false;
        continue;
      }

      const character = Array.from(this.pending)[0];
      if (character !== "\x1b") {
        this.pending = this.pending.slice(character.length);
        const code = character.codePointAt(0);
        if (character === "\r" || character === "\n") {
          events.push({ kind: "enter" });
        } else if (character === "\x08" || character === "\x7f") {
          events.push({ kind: "backspace" });
        } else if (character === "\x03") {
          events.push({ kind: "rune", character: "c", control: true });
        } else if (character === "\x15") {
          events.push({ kind: "rune", character: "u", control: true });
        } else if (code >= 0x20 && code !== 0x7f) {
          events.push({ kind: "rune", character, control: false });
        }
        continue;
      }

      if (this.pending.length === 1) {
        if (sourceIdle) {
          events.push({ kind: "escape" });
          this.pending = "";
        }
        break;
      }

      if (this.pending[1] === "O") {
        if (this.pending.length < 3) {
          break;
        }
        const final = this.pending[2];
        this.pending = this.pending.slice(3);
        const kind = {
          C: "right",
          D: "left",
          H: "home",
          F: "end",
        }[final];
        if (kind) {
          events.push({ kind });
        }
        continue;
      }

      if (this.pending[1] !== "[") {
        events.push({ kind: "escape" });
        this.pending = this.pending.slice(2);
        continue;
      }

      let finalIndex = -1;
      for (let index = 2; index < this.pending.length; index += 1) {
        const code = this.pending.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) {
          finalIndex = index;
          break;
        }
        if (index > 512) {
          this.pending = "";
          break;
        }
      }
      if (finalIndex < 0) {
        break;
      }

      const sequence = this.pending.slice(0, finalIndex + 1);
      this.pending = this.pending.slice(finalIndex + 1);
      if (sequence === "\x1b[200~") {
        this.pasting = true;
        this.paste = "";
        this.pasteOverflow = false;
        continue;
      }

      const final = sequence.at(-1);
      const body = sequence.slice(2, -1);
      let kind = {
        C: "right",
        D: "left",
        H: "home",
        F: "end",
      }[final];
      if (final === "~") {
        const first = body.split(";", 1)[0];
        kind = {
          1: "home",
          3: "delete",
          4: "end",
          7: "home",
          8: "end",
        }[first];
      }
      if (kind) {
        events.push({ kind });
      }
    }

    return events;
  }
}

class PromptDraft {
  constructor(descriptor) {
    this.descriptor = descriptor;
    this.characters = Array.from(descriptor.initial);
    this.cursor = this.characters.length;
    this.textBytes = Buffer.byteLength(descriptor.initial, "utf8");
    this.resolved = false;
    this.decoder = new PromptInputDecoder();
  }

  snapshot(revision) {
    const caret =
      this.cursor < this.characters.length
        ? this.characters[this.cursor]
        : " ";
    return {
      revision,
      promptId: this.descriptor.promptId,
      mode: this.descriptor.mode,
      label: this.descriptor.label,
      text: this.characters.join(""),
      cursor: this.cursor,
      before: this.characters.slice(0, this.cursor).join(""),
      caret,
      after:
        this.cursor < this.characters.length
          ? this.characters.slice(this.cursor + 1).join("")
          : "",
      resolved: this.resolved,
    };
  }

  insertCharacter(character) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (this.textBytes + bytes > MAX_STRING_LENGTH) {
      return false;
    }
    this.characters.splice(this.cursor, 0, character);
    this.cursor += 1;
    this.textBytes += bytes;
    return true;
  }

  insertText(text, normalize) {
    let changed = false;
    for (let character of Array.from(text)) {
      if (
        normalize &&
        (character === "\r" || character === "\n" || character === "\t")
      ) {
        character = " ";
      }
      const code = character.codePointAt(0);
      if (
        code >= 0x20 &&
        code !== 0x7f &&
        this.insertCharacter(character)
      ) {
        changed = true;
      }
    }
    return changed;
  }

  resolve(submitted, text) {
    this.resolved = true;
    return {
      promptId: this.descriptor.promptId,
      submitted,
      text,
    };
  }

  consume(data, sourceIdle) {
    const outcome = { changed: false, result: null };
    if (this.resolved) {
      return outcome;
    }

    for (const event of this.decoder.feed(data, sourceIdle)) {
      if (this.descriptor.mode === 2) {
        if (
          event.kind === "rune" &&
          (event.character === "y" || event.character === "Y")
        ) {
          outcome.result = this.resolve(true, "y");
        } else if (
          (
            event.kind === "rune" &&
            (event.character === "n" || event.character === "N")
          ) ||
          event.kind === "enter" ||
          event.kind === "escape" ||
          (
            event.kind === "rune" &&
            event.control &&
            event.character === "c"
          )
        ) {
          outcome.result = this.resolve(false, "");
        }
        if (outcome.result) {
          outcome.changed = true;
          return outcome;
        }
        continue;
      }

      if (event.kind === "rune") {
        if (event.control && event.character === "c") {
          outcome.result = this.resolve(false, "");
        } else if (event.control && event.character === "u") {
          if (this.characters.length > 0) {
            this.characters = [];
            this.cursor = 0;
            this.textBytes = 0;
            outcome.changed = true;
          }
        } else if (
          !event.control &&
          this.insertText(event.character, false)
        ) {
          outcome.changed = true;
        }
      } else if (event.kind === "paste") {
        if (this.insertText(event.text, true)) {
          outcome.changed = true;
        }
      } else if (event.kind === "backspace" && this.cursor > 0) {
        this.cursor -= 1;
        const [removed] = this.characters.splice(this.cursor, 1);
        this.textBytes -= Buffer.byteLength(removed, "utf8");
        outcome.changed = true;
      } else if (
        event.kind === "delete" &&
        this.cursor < this.characters.length
      ) {
        const [removed] = this.characters.splice(this.cursor, 1);
        this.textBytes -= Buffer.byteLength(removed, "utf8");
        outcome.changed = true;
      } else if (event.kind === "left" && this.cursor > 0) {
        this.cursor -= 1;
        outcome.changed = true;
      } else if (
        event.kind === "right" &&
        this.cursor < this.characters.length
      ) {
        this.cursor += 1;
        outcome.changed = true;
      } else if (event.kind === "home" && this.cursor !== 0) {
        this.cursor = 0;
        outcome.changed = true;
      } else if (
        event.kind === "end" &&
        this.cursor !== this.characters.length
      ) {
        this.cursor = this.characters.length;
        outcome.changed = true;
      } else if (event.kind === "enter") {
        outcome.result = this.resolve(true, this.characters.join(""));
      } else if (event.kind === "escape") {
        outcome.result = this.resolve(false, "");
      }

      if (outcome.result) {
        outcome.changed = true;
        return outcome;
      }
    }
    return outcome;
  }
}

function clientStatusMatches(left, right) {
  if (
    !left ||
    !right ||
    left.sessionId !== right.sessionId ||
    left.sessionName !== right.sessionName ||
    left.serverHostname !== right.serverHostname ||
    left.serverHome !== right.serverHome ||
    left.root !== right.root ||
    left.kind !== right.kind ||
    left.windows.length !== right.windows.length ||
    left.prompt.promptId !== right.prompt.promptId ||
    left.prompt.mode !== right.prompt.mode ||
    left.prompt.label !== right.prompt.label ||
    left.prompt.initial !== right.prompt.initial ||
    left.message.id !== right.message.id ||
    left.message.text !== right.message.text
  ) {
    return false;
  }
  return left.windows.every((window, index) => {
    const candidate = right.windows[index];
    return (
      window.windowId === candidate.windowId &&
      window.index === candidate.index &&
      window.title === candidate.title &&
      window.active === candidate.active &&
      window.zoomed === candidate.zoomed
    );
  });
}

class TerminalModel {
  constructor(sessionName, cols, rows, onSessionTarget) {
    this.sessionName = sessionName;
    this.onSessionTarget = onSessionTarget;
    this.requestedCols = cols;
    this.requestedRows = rows;
    this.screens = new Map();
    this.layout = null;
    this.status = {
      revision: 0,
      sessionId: 0,
      sessionName,
      windows: [],
      kind: STATUS_NORMAL,
      prompt: { promptId: 0, mode: 0, label: "", initial: "" },
      message: { id: 0, text: "" },
    };
    this.statusRevision = 0;
    this.promptDraft = null;
    this.promptDraftRevision = 0;
    this.error = "";
    this.listeners = new Set();
    this.renderAnnounced = new Set();
    this.inputSender = null;
    this.promptResultSender = null;
    this.resizeSender = null;
    this.lastResize = null;
    this.mobileZoomStates = new Map();
    this.zoomReconcileScheduled = false;
    this.zoomCommandInFlight = false;
    this.resetCursorRevealTimers = new Map();
  }

  screen(slot) {
    let screen = this.screens.get(slot);
    if (!screen) {
      screen = new PaneScreen(slot, (value) => this.present(slot, value));
      this.screens.set(slot, screen);
    }
    return screen;
  }

  setLayout(layout) {
    if (this.layout && layout.revision < this.layout.revision) {
      return;
    }
    this.layout = layout;
    for (const pane of layout.panes) {
      this.screen(pane.slot);
    }
    this.publish(false, null, false, true);
  }

  setStatus(status) {
    if (status.revision <= this.statusRevision) {
      return;
    }
    this.statusRevision = status.revision;

    const previousStatus = this.status;
    const changed = !clientStatusMatches(previousStatus, status);
    if (!changed) {
      return;
    }

    this.status = status;
    this.sessionName = status.sessionName;
    if (
      status.sessionId > 0 &&
      status.sessionId !== previousStatus.sessionId
    ) {
      this.onSessionTarget?.(String(status.sessionId));
    }
    if (status.kind === STATUS_PROMPT) {
      if (
        !this.promptDraft ||
        this.promptDraft.descriptor.promptId !== status.prompt.promptId
      ) {
        this.promptDraft = new PromptDraft(status.prompt);
      } else {
        this.promptDraft.descriptor = status.prompt;
      }
      this.promptDraftRevision += 1;
    } else if (this.promptDraft) {
      this.promptDraft = null;
      this.promptDraftRevision += 1;
    }

    this.publish(false);
    this.scheduleMobileZoomReconcile();
  }

  present(slot, screen) {
    if (
      !this.renderAnnounced.has(slot) &&
      screen.cols > 0 &&
      screen.rows > 0
    ) {
      this.renderAnnounced.add(slot);
      console.log(
        `seniman-meja: rendering pane slot ${slot} at ` +
        `${screen.cols}x${screen.rows}`
      );
    }
    if (screen.resetPending) {
      this.clearResetCursorReveal(slot);
      this.publish(true, screen, true, false, {
        showCursor: false,
      });
      this.scheduleResetCursorReveal(slot, screen);
      return;
    }

    // Only an explicit follow-up cursor command settles a cursor suppressed by
    // a reset. An unrelated repaint of the same row must not reveal it early.
    if (
      !screen.cursor.visible ||
      screen.cursorUpdatePending
    ) {
      this.clearResetCursorReveal(slot);
    }
    this.publish(false, screen, true);
  }

  clearResetCursorReveal(slot) {
    const timer = this.resetCursorRevealTimers.get(slot);
    if (timer) {
      clearTimeout(timer);
      this.resetCursorRevealTimers.delete(slot);
    }
  }

  scheduleResetCursorReveal(slot, screen) {
    if (
      !screen.cursor.visible ||
      screen.cursor.y < 0 ||
      screen.cursor.y >= screen.rows
    ) {
      return;
    }
    const revision = screen.revision;
    const timer = setTimeout(() => {
      if (this.resetCursorRevealTimers.get(slot) !== timer) {
        return;
      }
      this.resetCursorRevealTimers.delete(slot);
      const current = this.screens.get(slot);
      if (
        current !== screen ||
        current.revision !== revision ||
        !current.cursor.visible ||
        current.cursor.y < 0 ||
        current.cursor.y >= current.rows
      ) {
        return;
      }
      this.publish(false, current, false, false, {
        forcedRows: [current.cursor.y],
      });
    }, RESET_CURSOR_REVEAL_MS);
    this.resetCursorRevealTimers.set(slot, timer);
  }

  setError(error) {
    this.error = error instanceof Error ? error.message : String(error);
    this.publish(false);
  }

  writeClipboard(text) {
    const event = {
      slot: null,
      layoutChanged: false,
      reset: false,
      scrollRegions: [],
      styleReset: false,
      styles: [],
      meta: this.metadata(),
      rows: [],
      clipboardText: text,
    };
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  metadata() {
    const panes = this.layout?.panes ?? [];
    const focused =
      panes.find(
        ({ paneId }) => paneId === this.layout?.focusedPaneId
      ) ?? panes[0];
    const cols = panes.reduce(
      (maximum, pane) =>
        Math.max(maximum, pane.rect.x + pane.rect.width),
      0
    );
    const rows = panes.reduce(
      (maximum, pane) =>
        Math.max(maximum, pane.rect.y + pane.rect.height),
      0
    );
    return {
      sessionName: this.sessionName,
      paneId: focused?.paneId ?? null,
      cols: cols || this.requestedCols,
      rows: rows || this.requestedRows,
      layout: this.layout,
      error: this.error,
      status: this.status,
      promptDraftRevision: this.promptDraftRevision,
      promptDraft: this.promptDraft?.snapshot(
        this.promptDraftRevision
      ) ?? null,
    };
  }

  snapshot() {
    return {
      meta: this.metadata(),
    };
  }

  paneSnapshot(slot) {
    const screen = this.screen(slot);
    return {
      styles: Array.from(
        screen.styles,
        ([id, style]) => styleRule(slot, id, style)
      ),
      rows: Array.from(
        { length: screen.rows },
        (_, index) => rowSnapshot(screen, index)
      ),
    };
  }

  publish(
    reset,
    screen = null,
    includePendingScrollRegions = false,
    layoutChanged = false,
    { showCursor = true, forcedRows = null } = {}
  ) {
    const event = {
      slot: screen?.slot ?? null,
      layoutChanged,
      reset,
      scrollRegions:
        screen && includePendingScrollRegions && !reset
          ? screen.pendingScrollRegions.slice()
          : [],
      styleReset: screen?.styleResetPending ?? false,
      styles: screen
        ? screen.pendingStyleInstalls.map(({ id, style }) =>
            styleRule(screen.slot, id, style)
          )
        : [],
      meta: this.metadata(),
      rows: [],
      clipboardText: null,
    };
    if (screen && forcedRows) {
      event.rows = forcedRows.map((index) => ({
        index,
        row: rowSnapshot(screen, index, showCursor),
      }));
    } else if (screen && reset) {
      event.rows = Array.from(
        { length: screen.rows },
        (_, index) => ({
          index,
          row: rowSnapshot(screen, index, showCursor),
        })
      );
    } else if (screen) {
      event.rows = Array.from(screen.dirtyRows, (index) => ({
        index,
        row: rowSnapshot(screen, index, showCursor),
      }));
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setInputSender(sender) {
    this.inputSender = sender;
    this.scheduleMobileZoomReconcile();
  }

  setPromptResultSender(sender) {
    this.promptResultSender = sender;
  }

  setResizeSender(sender) {
    this.resizeSender = sender;
  }

  disconnect() {
    for (const timer of this.resetCursorRevealTimers.values()) {
      clearTimeout(timer);
    }
    this.resetCursorRevealTimers.clear();
    this.inputSender = null;
    this.promptResultSender = null;
    this.resizeSender = null;
  }

  activeWindow() {
    return this.status.windows.find(({ active }) => active) ?? null;
  }

  mobileZoomKey(window) {
    if (!window || this.status.sessionId <= 0) {
      return null;
    }
    return `${this.status.sessionId}:${window.windowId}`;
  }

  scheduleMobileZoomReconcile() {
    if (this.zoomReconcileScheduled) {
      return;
    }
    this.zoomReconcileScheduled = true;
    queueMicrotask(() => {
      this.zoomReconcileScheduled = false;
      this.reconcileMobileZoom().catch((error) =>
        this.setError(error)
      );
    });
  }

  async reconcileMobileZoom() {
    if (
      this.zoomCommandInFlight ||
      !this.inputSender ||
      !this.layout
    ) {
      return;
    }

    const window = this.activeWindow();
    const key = this.mobileZoomKey(window);
    if (!window || !key) {
      return;
    }

    const compact =
      this.requestedCols < COMPACT_MULTI_PANE_COLUMNS;
    const paneCount = this.layout.panes.length;
    let state = this.mobileZoomStates.get(key);

    if (state?.phase === "zoom-requested" && window.zoomed) {
      state.phase = "mobile-zoomed";
    } else if (
      state?.phase === "unzoom-requested" &&
      !window.zoomed
    ) {
      this.mobileZoomStates.delete(key);
      state = null;
    }

    if (compact) {
      if (window.zoomed || paneCount <= 1) {
        return;
      }
      if (state?.phase === "zoom-requested") {
        return;
      }
      state = {
        owned: true,
        phase: "zoom-requested",
        paneId: this.layout.focusedPaneId,
      };
      this.mobileZoomStates.set(key, state);
      await this.sendMobileZoomToggle(
        key,
        state,
        `zoom pane ${state.paneId}`
      );
      return;
    }

    if (!state?.owned) {
      return;
    }
    if (!window.zoomed) {
      if (state.phase !== "zoom-requested") {
        this.mobileZoomStates.delete(key);
      }
      return;
    }
    if (state.phase === "unzoom-requested") {
      return;
    }
    state.phase = "unzoom-requested";
    await this.sendMobileZoomToggle(key, state, "restore split layout");
  }

  async sendMobileZoomToggle(key, state, description) {
    this.zoomCommandInFlight = true;
    try {
      await this.inputSender("\x02z", false);
      console.log(`seniman-meja: mobile layout requested ${description}`);
    } catch (error) {
      if (this.mobileZoomStates.get(key) === state) {
        this.mobileZoomStates.delete(key);
      }
      throw error;
    } finally {
      this.zoomCommandInFlight = false;
      this.scheduleMobileZoomReconcile();
    }
  }

  async sendResize(cols = this.requestedCols, rows = this.requestedRows) {
    if (
      !this.resizeSender ||
      !Number.isSafeInteger(cols) ||
      !Number.isSafeInteger(rows) ||
      cols <= 0 ||
      rows <= 0
    ) {
      return;
    }
    const key = `${cols}x${rows}`;
    if (this.lastResize === key) {
      return;
    }
    this.requestedCols = cols;
    this.requestedRows = rows;
    this.lastResize = key;
    await this.resizeSender(cols, rows);
    console.log(`seniman-meja: sent frontend resize ${key}`);
  }

  async sendInput(data, sourceIdle = false) {
    if (typeof data !== "string" || data.length === 0) {
      return;
    }

    if (this.promptDraft) {
      const outcome = this.promptDraft.consume(data, sourceIdle);
      if (outcome.changed) {
        this.promptDraftRevision += 1;
        this.publish(false);
      }
      if (outcome.result && this.promptResultSender) {
        await this.promptResultSender(outcome.result);
      }
      return;
    }

    if (!this.inputSender) {
      return;
    }
    await this.inputSender(data, sourceIdle);
  }

  async selectWindow(windowId) {
    const window = this.status.windows.find(
      (candidate) => candidate.windowId === windowId
    );
    if (!window || window.active) {
      return;
    }
    const target = String(window.index);
    const input =
      window.index >= 0 && window.index <= 9
        ? `\x02${target}`
        : `\x02:select-window -t :${target}\r`;
    await this.sendInput(input, false);
  }

  async createWindow() {
    await this.sendInput("\x02c", false);
  }

  async sendWheel(
    buttonCode,
    column,
    row,
    modifiers,
    reportCount
  ) {
    const pane = paneAt(this.layout?.panes ?? [], column, row);
    if (
      !pane ||
      ![64, 65, 66, 67].includes(buttonCode) ||
      !Number.isSafeInteger(column) ||
      !Number.isSafeInteger(row) ||
      !Number.isSafeInteger(modifiers) ||
      !Number.isSafeInteger(reportCount)
    ) {
      return;
    }

    const x = column + 1;
    const y = row + 1;
    const sequence =
      `\x1b[<${buttonCode + modifiers};${x};${y}M`;
    await this.sendInput(
      sequence.repeat(Math.min(Math.max(reportCount, 1), 24))
    );
  }

  async sendPointer(
    action,
    button,
    column,
    row,
    modifiers
  ) {
    const pane = paneAt(this.layout?.panes ?? [], column, row);
    if (
      !pane ||
      !["press", "move", "release"].includes(action) ||
      !Number.isSafeInteger(button) ||
      button < 0 ||
      button > 2 ||
      !Number.isSafeInteger(column) ||
      !Number.isSafeInteger(row) ||
      !Number.isSafeInteger(modifiers)
    ) {
      return;
    }
    const final = action === "release" ? "m" : "M";
    const buttonCode = action === "move" ? button + 32 : button;
    const sequence =
      `\x1b[<${buttonCode + modifiers};${column + 1};${row + 1}${final}`;
    await this.sendInput(sequence, false);
  }
}

function certificateMatchesPin(certs, expectedHex) {
  if (certs.length === 0 || !/^[0-9a-f]{64}$/i.test(expectedHex)) {
    return false;
  }
  try {
    const certificate = new X509Certificate(Buffer.from(certs[0]));
    const spki = certificate.publicKey.export({
      type: "spki",
      format: "der",
    });
    const actual = createHash("sha256").update(spki).digest();
    const expected = Buffer.from(expectedHex, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function outputIndexFromStreamId(streamId) {
  if ((streamId & 3) !== 3) {
    return null;
  }
  const index = (streamId - 3) / 4;
  if (!Number.isInteger(index) || index < 0 || index >= OUTPUT_STREAM_COUNT) {
    return null;
  }
  return index;
}

async function drainStream(stream) {
  for await (const _chunk of stream.readable) {
    // Unknown streams still need flow-control credit before rejection/teardown.
  }
}

async function applyRenderPayload(payload, screen) {
  const payloadReader = new PayloadReader(payload);
  const staged = screen.beginFrame();
  while (payloadReader.offset < payload.length) {
    staged.apply(await readDisplayCommand(payloadReader));
  }
  screen.commitFrame(staged);
}

async function consumePaneStream(stream, slot, model) {
  const reader = new AsyncBytes(stream.readable);
  const screen = model.screen(slot);
  while (true) {
    const payload = await readRenderFrame(reader, (frame) => {
      renderDiagnostics.mejaFrame(frame);
    });
    if (payload === null) {
      return;
    }

    await applyRenderPayload(payload, screen);
  }
}

async function consumeControlStream(reader, model, executeTerminalExit) {
  while (true) {
    let frame;
    try {
      frame = await readControlFrame(reader);
    } catch (error) {
      if (error instanceof EndOfStreamError) {
        return;
      }
      throw error;
    }
    if (frame.type === MSG_CLIENT_LAYOUT) {
      model.setLayout(decodeClientLayout(frame.payload));
    } else if (frame.type === MSG_CLIENT_STATUS) {
      model.setStatus(decodeClientStatus(frame.payload));
    } else if (frame.type === MSG_FRONTEND_TERMINAL_WRITE) {
      const text = decodeOSC52ClipboardWrite(frame.payload);
      if (text !== null) {
        model.writeClipboard(text);
      }
    } else if (
      frame.type === MSG_FRONTEND_REGISTER_TERMINAL_EXIT_COMMAND
    ) {
      // Browser rendering has no physical terminal state to restore.
    } else if (
      frame.type === MSG_FRONTEND_EXECUTE_TERMINAL_EXIT_COMMAND
    ) {
      await executeTerminalExit(decodePayloadString(frame.payload));
      return;
    }
  }
}

async function attachMeja(
  bootstrap,
  connectionHost,
  options,
  model,
  onClose,
  onTerminalExit
) {
  let pinVerified = false;
  let locallyClosing = false;
  let terminalExitHandled = false;
  const client = await QUICClient.createQUICClient(
    {
      host: connectionHost,
      port: bootstrap.port,
      serverName: "meja-daemon",
      crypto: {
        ops: {
          async randomBytes(data) {
            randomFillSync(new Uint8Array(data));
          },
        },
      },
      logger: silentLogger,
      config: {
        applicationProtos: [MEJA_ALPN],
        maxIdleTimeout: 0,
        verifyPeer: true,
        verifyCallback: async (certs) => {
          pinVerified = certificateMatchesPin(
            certs,
            bootstrap.certSpkiSha256
          );
          return pinVerified
            ? undefined
            : native.CryptoError.BadCertificate;
        },
      },
    },
    { timer: 10_000 }
  );

  if (!pinVerified) {
    await client.destroy({ force: true }).catch(() => {});
    throw new Error("QUIC connected without verifying Meja's SPKI pin");
  }

  const handleConnectionError = (event) => {
    if (locallyClosing || terminalExitHandled) {
      return;
    }
    model.disconnect();
    onClose?.(event.detail);
  };
  client.connection.addEventListener(
    events.EventQUICConnectionError.name,
    handleConnectionError,
    { once: true }
  );

  const streamTasks = new Set();
  const track = (promise) => {
    streamTasks.add(promise);
    promise
      .catch((error) => model.setError(error))
      .finally(() => streamTasks.delete(promise));
  };

  client.connection.addEventListener(
    events.EventQUICConnectionStream.name,
    (event) => {
      const stream = event.detail;
      const outputIndex = outputIndexFromStreamId(stream.streamId);
      if (outputIndex === null) {
        track(drainStream(stream));
        return;
      }
      track(consumePaneStream(stream, outputIndex, model));
    }
  );

  const controlStream = client.connection.newStream("bidi");
  const controlReader = new AsyncBytes(controlStream.readable);
  const writer = controlStream.writable.getWriter();
  const attachPayload = Buffer.concat([
    encodeString(bootstrap.attachToken),
    encodeUvarint(options.cols),
    encodeUvarint(options.rows),
  ]);
  await writer.write(encodeFrame(MSG_SESSION_ATTACH, attachPayload));

  const attachResult = await readControlFrame(controlReader);
  if (attachResult.type === MSG_SESSION_ATTACH_FAILED) {
    locallyClosing = true;
    await client.destroy({ force: true }).catch(() => {});
    throw new Error(
      `SESSION_ATTACH_FAILED: ${decodePayloadString(attachResult.payload)}`
    );
  }
  if (attachResult.type !== MSG_SESSION_ATTACH_OK) {
    locallyClosing = true;
    await client.destroy({ force: true }).catch(() => {});
    throw new Error(
      `unexpected session attachment result ${attachResult.type}`
    );
  }

  const writeControlFrame = async (type, payload) => {
    try {
      await writer.write(encodeFrame(type, payload));
    } catch (error) {
      model.setError(error);
      throw error;
    }
  };
  model.setInputSender(async (data, sourceIdle) => {
    const layoutRevision = model.layout?.revision;
    if (layoutRevision === undefined) {
      return;
    }
    const payload = Buffer.concat([
      encodeUvarint(layoutRevision),
      Buffer.from([sourceIdle ? 1 : 0]),
      Buffer.from(data, "utf8"),
    ]);
    await writeControlFrame(MSG_FRONTEND_INPUT_BYTES, payload);
  });
  model.setPromptResultSender(async (result) => {
    if (
      !Number.isSafeInteger(result.promptId) ||
      result.promptId <= 0 ||
      Buffer.byteLength(result.text, "utf8") > MAX_STRING_LENGTH
    ) {
      throw new Error("invalid FRONTEND_PROMPT_RESULT");
    }
    const payload = Buffer.concat([
      encodeUvarint(result.promptId),
      Buffer.from([result.submitted ? 1 : 0]),
      encodeString(result.text),
    ]);
    await writeControlFrame(MSG_FRONTEND_PROMPT_RESULT, payload);
  });
  model.setResizeSender(async (cols, rows) => {
    const payload = Buffer.concat([
      encodeUvarint(cols),
      encodeUvarint(rows),
    ]);
    await writeControlFrame(MSG_FRONTEND_RESIZE, payload);
  });

  track(
    consumeControlStream(
      controlReader,
      model,
      async (message) => {
        await writeControlFrame(
          MSG_FRONTEND_TERMINAL_EXIT_COMPLETE,
          Buffer.alloc(0)
        );
        terminalExitHandled = true;
        model.disconnect();
        onTerminalExit?.(message);
      }
    )
  );
  return {
    client,
    async destroy() {
      if (locallyClosing) {
        return;
      }
      locallyClosing = true;
      model.disconnect();
      client.connection.removeEventListener(
        events.EventQUICConnectionError.name,
        handleConnectionError
      );
      await client.destroy({ force: true }).catch(() => {});
    },
  };
}


export {
  STATUS_MESSAGE,
  STATUS_PROMPT,
  SESSION_REPLACED_ERROR_CODE,
  TerminalModel,
  attachMeja,
  cellMatches,
  paneAt,
  requestAttachmentGrant,
  runMejaCommand,
  spanRuns,
};

export const __testing = {
  AsyncBytes,
  PaneScreen,
  applyRenderPayload,
  readRenderFrame,
};
