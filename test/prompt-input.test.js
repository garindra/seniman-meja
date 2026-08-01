import assert from "node:assert/strict";
import test from "node:test";

import { __testing } from "../src/meja-client.js";

const { PromptDraft, PromptInputDecoder } = __testing;

test("decodes semantic Kitty prompt input and ignores releases", () => {
  const decoder = new PromptInputDecoder();

  assert.deepEqual(decoder.feed("\x1b[97;1:1u", false), [
    { kind: "rune", character: "a", control: false },
  ]);
  assert.deepEqual(decoder.feed("\x1b[57350;1:1u", false), [
    { kind: "left" },
  ]);
  assert.deepEqual(decoder.feed("\x1b[97;1:3u", false), []);
  assert.deepEqual(decoder.feed("\x1b[99;5:1u", false), [
    { kind: "rune", character: "c", control: true },
  ]);
});

test("semantic Kitty Enter resolves a prompt draft", () => {
  const draft = new PromptDraft({
    promptId: 7,
    mode: 1,
    label: ":",
    initial: "rename-window editor",
  });

  assert.deepEqual(draft.consume("\x1b[57345;1:1u", false), {
    changed: true,
    result: {
      promptId: 7,
      submitted: true,
      text: "rename-window editor",
    },
  });
});
