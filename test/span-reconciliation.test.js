import assert from "node:assert/strict";
import test from "node:test";
import { planSpanReconciliation } from "../dist/terminal-row.js";

function span(start, end, overrides = {}) {
  return {
    start,
    end,
    text: "x",
    className: "s0",
    spaceOnly: false,
    ...overrides,
  };
}

function compact(plan) {
  return {
    reusedPairs: plan.reusedPairs,
    operations: plan.operations,
  };
}

test("plans a one-span split as one insertion", () => {
  assert.deepEqual(
    compact(planSpanReconciliation(
      [span(0, 4)],
      [span(0, 2), span(2, 4)]
    )),
    {
      reusedPairs: [[0, 0]],
      operations: [{
        start: 1,
        removeCount: 0,
        nextStart: 1,
        insertCount: 1,
      }],
    }
  );
});

test("plans a two-span merge as one removal", () => {
  assert.deepEqual(
    compact(planSpanReconciliation(
      [span(0, 2), span(2, 4)],
      [span(0, 4)]
    )),
    {
      reusedPairs: [[0, 0]],
      operations: [{
        start: 1,
        removeCount: 1,
        nextStart: 1,
        insertCount: 0,
      }],
    }
  );
});

test("reuses all records when only boundaries move", () => {
  assert.deepEqual(
    compact(planSpanReconciliation(
      [span(0, 2), span(2, 4)],
      [span(0, 1), span(1, 4)]
    )),
    {
      reusedPairs: [[0, 0], [1, 1]],
      operations: [],
    }
  );
});

test("splices only a changed middle", () => {
  assert.deepEqual(
    compact(planSpanReconciliation(
      [span(0, 2), span(2, 4), span(4, 6)],
      [span(0, 2), span(2, 3), span(3, 4), span(4, 6)]
    )),
    {
      reusedPairs: [[0, 0], [1, 1], [2, 3]],
      operations: [{
        start: 2,
        removeCount: 0,
        nextStart: 2,
        insertCount: 1,
      }],
    }
  );
});

test("preserves a stable suffix when the prefix changes", () => {
  const plan = planSpanReconciliation(
    [span(0, 11), span(11, 13)],
    [span(0, 5), span(5, 11), span(11, 13)]
  );
  assert.deepEqual(plan.reusedPairs.at(-1), [1, 2]);
});

test("preserves a stable prefix when the suffix changes", () => {
  const plan = planSpanReconciliation(
    [span(0, 2), span(2, 4)],
    [span(0, 2), span(2, 3), span(3, 4)]
  );
  assert.deepEqual(plan.reusedPairs[0], [0, 0]);
});

test("fully replaces incompatible inline-width modes", () => {
  assert.deepEqual(
    compact(planSpanReconciliation(
      [span(0, 10)],
      [span(0, 11)]
    )),
    {
      reusedPairs: [],
      operations: [{
        start: 0,
        removeCount: 1,
        nextStart: 0,
        insertCount: 1,
      }],
    }
  );
});

test("preserves stable islands with multiple localized insertions", () => {
  const previous = [
    span(0, 1, { text: "A" }),
    span(1, 2, { text: "B" }),
    span(2, 3, { text: "C" }),
    span(3, 4, { text: "D" }),
  ];
  const next = [
    span(0, 1, { text: "A" }),
    span(1, 2, { text: "X" }),
    span(2, 3, { text: "B" }),
    span(3, 4, { text: "C" }),
    span(4, 5, { text: "Y" }),
    span(5, 6, { text: "D" }),
  ];
  const plan = planSpanReconciliation(previous, next);
  assert.deepEqual(plan.reusedPairs, [
    [0, 0],
    [1, 2],
    [2, 3],
    [3, 5],
  ]);
  assert.deepEqual(plan.operations, [
    {
      start: 1,
      removeCount: 0,
      nextStart: 1,
      insertCount: 1,
    },
    {
      start: 3,
      removeCount: 0,
      nextStart: 4,
      insertCount: 1,
    },
  ]);
});

test("keeps wide, space-only, and grapheme spans reusable", () => {
  const values = [
    span(0, 2, { text: "界" }),
    span(2, 8, { text: " ", spaceOnly: true }),
    span(8, 10, { text: "e\u0301" }),
  ];
  const next = values.map((value) => ({
    ...value,
    className: "s1",
  }));
  assert.deepEqual(
    planSpanReconciliation(values, next).reusedPairs,
    [[0, 0], [1, 1], [2, 2]]
  );
});
