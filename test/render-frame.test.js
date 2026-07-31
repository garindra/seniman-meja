import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { __testing } from "../src/meja-client.js";

function uvarint(input) {
  let value = BigInt(input);
  const output = [];
  while (value >= 0x80n) {
    output.push(Number(value & 0x7fn) | 0x80);
    value >>= 7n;
  }
  output.push(Number(value));
  return Buffer.from(output);
}

function record(flags, rawSize, encoded) {
  return Buffer.concat([
    Buffer.from([flags]),
    uvarint(rawSize),
    uvarint(encoded.length),
    encoded,
  ]);
}

function reader(...chunks) {
  return new __testing.AsyncBytes((async function* () {
    yield* chunks;
  })());
}

test("reads raw render records across stream chunks", async () => {
  const payload = Buffer.from([1, 2, 3, 4]);
  const framed = record(0, payload.length, payload);
  const decoded = await __testing.readRenderFrame(
    reader(framed.subarray(0, 2), framed.subarray(2))
  );
  assert.deepEqual(decoded, payload);
});

test("reads an independently compressed zlib render record", async () => {
  const payload = Buffer.alloc(1024, 0x61);
  const encoded = deflateSync(payload);
  const decoded = await __testing.readRenderFrame(
    reader(record(1, payload.length, encoded))
  );
  assert.deepEqual(decoded, payload);
});

test("distinguishes clean EOF from a partial record", async () => {
  assert.equal(await __testing.readRenderFrame(reader()), null);
  await assert.rejects(
    __testing.readRenderFrame(reader(Buffer.from([0, 1]))),
    /truncated render frame header/
  );
  await assert.rejects(
    __testing.readRenderFrame(reader(Buffer.from([0, 1, 1]))),
    /truncated render frame payload/
  );
});

test("rejects reserved flags and overlong header sizes", async () => {
  await assert.rejects(
    __testing.readRenderFrame(reader(Buffer.from([2, 1, 1, 0]))),
    /reserved flags/
  );
  await assert.rejects(
    __testing.readRenderFrame(
      reader(Buffer.from([0, 0x81, 0, 1, 0]))
    ),
    /overlong render frame uvarint/
  );
});

test("rejects trailing and concatenated zlib streams", async () => {
  const payload = Buffer.alloc(1024, 0x61);
  const encoded = deflateSync(payload);
  for (const suffix of [
    Buffer.from([0]),
    deflateSync(Buffer.from("second")),
  ]) {
    const withTrailing = Buffer.concat([encoded, suffix]);
    await assert.rejects(
      __testing.readRenderFrame(
        reader(record(1, payload.length, withTrailing))
      ),
      /trailing bytes/
    );
  }
});

test("commits one complete payload and rolls back a truncated command", async () => {
  let presents = 0;
  const screen = new __testing.PaneScreen(0, () => {
    presents += 1;
  });
  const initial = Buffer.concat([
    Buffer.from([0x01]),
    uvarint(1),
    uvarint(2),
    uvarint(1),
    Buffer.from([0x07]),
    uvarint(1),
    Buffer.from("A"),
  ]);
  await __testing.applyRenderPayload(initial, screen);
  assert.equal(screen.cells[0][0].text, "A");
  assert.equal(screen.presentCount, 1);
  assert.equal(presents, 1);

  const truncated = Buffer.concat([
    Buffer.from([0x03]),
    uvarint(0),
    uvarint(1),
    Buffer.from([0x07]),
    uvarint(2),
    Buffer.from("B"),
  ]);
  await assert.rejects(
    __testing.applyRenderPayload(truncated, screen),
    /invalid string length/
  );
  assert.equal(screen.cells[0][0].text, "A");
  assert.equal(screen.presentCount, 1);
  assert.equal(presents, 1);
});
