import assert from "node:assert/strict";
import test from "node:test";
import { encodeTerminalKey } from "../src/terminal-keyboard.js";

test("encodes modified navigation keys without losing modifiers", () => {
  assert.equal(
    encodeTerminalKey({ key: "ArrowLeft", ctrl: true }),
    "\x1b[57350;5:1u"
  );
  assert.equal(
    encodeTerminalKey({
      key: "ArrowRight",
      ctrl: true,
      alt: true,
    }),
    "\x1b[57351;7:1u"
  );
  assert.equal(
    encodeTerminalKey({ key: "ArrowDown", shift: true }),
    "\x1b[57353;2:1u"
  );
  assert.equal(
    encodeTerminalKey({ key: "PageDown", ctrl: true }),
    "\x1b[57355;5:1u"
  );
});

test("encodes modifiers on function keys and printable chords", () => {
  assert.equal(
    encodeTerminalKey({ key: "F12", ctrl: true, shift: true }),
    "\x1b[57375;6:1u"
  );
  assert.equal(
    encodeTerminalKey({
      key: "P",
      code: "KeyP",
      ctrl: true,
      shift: true,
    }),
    "\x1b[80;6:1u"
  );
  assert.equal(
    encodeTerminalKey({
      key: "π",
      code: "KeyP",
      ctrl: true,
      alt: true,
    }),
    "\x1b[112;7:1u"
  );
  assert.equal(
    encodeTerminalKey({
      key: "Dead",
      code: "KeyE",
      alt: true,
    }),
    "\x1b[101;3:1u"
  );
});

test("preserves repeat and release actions", () => {
  assert.equal(
    encodeTerminalKey({ key: "ArrowUp", action: "repeat" }),
    "\x1b[57352;1:2u"
  );
  assert.equal(
    encodeTerminalKey({ key: "ArrowUp", action: "release" }),
    "\x1b[57352;1:3u"
  );
});

test("encodes Escape as a complete semantic packet", () => {
  assert.equal(
    encodeTerminalKey({ key: "Escape" }),
    "\x1b[57344;1:1u"
  );
});

test("rejects browser key names without terminal meanings", () => {
  assert.equal(encodeTerminalKey({ key: "Unidentified" }), null);
  assert.equal(encodeTerminalKey({ key: "a", action: "unknown" }), null);
});
