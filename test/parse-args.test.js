import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../src/parse-args.js";

test("password authentication is enabled unless explicitly skipped", () => {
  assert.equal(parseArgs([]).skipPassword, false);
  assert.equal(parseArgs(["--skip-password"]).skipPassword, true);
});
