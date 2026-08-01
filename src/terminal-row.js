import {
  createCollection,
  onDispose,
  untrack,
  useState,
} from "seniman";
import { spanRuns } from "./meja-client.js";
import { renderDiagnostics } from "./render-diagnostics.js";

const SPAN_WIDTH_CLASS_MAX = 10;

function spanWidth(span) {
  return span.end - span.start;
}

function isFullBlock(text) {
  return /^█+$/.test(text);
}

function usesInlineWidth(span) {
  return spanWidth(span) > SPAN_WIDTH_CLASS_MAX;
}

function spanPartitionMatches(previous, next) {
  return (
    previous.length === next.length &&
    previous.every((span, index) => {
      const candidate = next[index];
      return usesInlineWidth(span) === usesInlineWidth(candidate);
    })
  );
}

function canReuse(previous, next) {
  return usesInlineWidth(previous) === usesInlineWidth(next);
}

function updateCost(previous, next) {
  let cost = 0;
  if (previous.text !== next.text) {
    cost += Buffer.byteLength(next.text, "utf8") + 4;
  }
  if (previous.className !== next.className) {
    cost += Buffer.byteLength(next.className, "utf8") + 5;
  }
  if (spanWidth(previous) !== spanWidth(next)) {
    cost += usesInlineWidth(next)
      ? String(spanWidth(next)).length + 7
      : 11;
  }
  return cost;
}

function betterAlignment(candidate, current) {
  return (
    candidate.matches > current.matches ||
    (
      candidate.matches === current.matches &&
      candidate.cost < current.cost
    )
  );
}

function alignedPairs(previous, next) {
  const rows = previous.length + 1;
  const columns = next.length + 1;
  const scores = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => ({
      matches: 0,
      cost: 0,
    }))
  );

  for (let before = previous.length - 1; before >= 0; before -= 1) {
    for (let after = next.length - 1; after >= 0; after -= 1) {
      let best = scores[before + 1][after];
      if (betterAlignment(scores[before][after + 1], best)) {
        best = scores[before][after + 1];
      }
      if (canReuse(previous[before], next[after])) {
        const suffix = scores[before + 1][after + 1];
        const matched = {
          matches: suffix.matches + 1,
          cost:
            suffix.cost + updateCost(previous[before], next[after]),
        };
        if (betterAlignment(matched, best)) {
          best = matched;
        }
      }
      scores[before][after] = best;
    }
  }

  const pairs = [];
  let before = 0;
  let after = 0;
  while (before < previous.length && after < next.length) {
    const best = scores[before][after];
    if (canReuse(previous[before], next[after])) {
      const suffix = scores[before + 1][after + 1];
      if (
        suffix.matches + 1 === best.matches &&
        suffix.cost + updateCost(previous[before], next[after]) ===
          best.cost
      ) {
        pairs.push([before, after]);
        before += 1;
        after += 1;
        continue;
      }
    }
    const skipBefore = scores[before + 1][after];
    if (
      skipBefore.matches === best.matches &&
      skipBefore.cost === best.cost
    ) {
      before += 1;
    } else {
      after += 1;
    }
  }
  return pairs;
}

function spliceOperations(previousLength, nextLength, reusedPairs) {
  const operations = [];
  let before = 0;
  let after = 0;
  for (const [beforeIndex, afterIndex] of [
    ...reusedPairs,
    [previousLength, nextLength],
  ]) {
    const removeCount = beforeIndex - before;
    const insertCount = afterIndex - after;
    if (removeCount || insertCount) {
      operations.push({
        start: before,
        removeCount,
        nextStart: after,
        insertCount,
      });
    }
    before = beforeIndex + 1;
    after = afterIndex + 1;
  }
  return operations;
}

export function planSpanReconciliation(previous, next) {
  if (spanPartitionMatches(previous, next)) {
    return {
      reusedPairs: previous.map((_, index) => [index, index]),
      operations: [],
    };
  }
  const reusedPairs = alignedPairs(previous, next);
  return {
    reusedPairs,
    operations: spliceOperations(
      previous.length,
      next.length,
      reusedPairs
    ),
  };
}

export function createSpanRecord(span) {
  return {
    current: span,
    apply: null,
  };
}

function updateSpanRecord(record, span) {
  if (record.apply) {
    record.apply(span);
  } else {
    record.current = span;
  }
}

export function TerminalSpan({ record }) {
  let current = record.current;
  const inlineWidth = usesInlineWidth(current);
  const [text, setText] = useState(current.text);
  const [className, setClassName] = useState(current.className);
  const [start, setStart] = useState(current.start);
  const [width, setWidth] = useState(spanWidth(current));

  record.apply = (next) => {
    if (current.text !== next.text) {
      setText(next.text);
    }
    if (current.className !== next.className) {
      setClassName(next.className);
    }
    if (current.start !== next.start) {
      setStart(next.start);
    }
    const nextWidth = spanWidth(next);
    if (spanWidth(current) !== nextWidth) {
      setWidth(nextWidth);
    }
    current = next;
    record.current = next;
  };

  onDispose(() => {
    record.apply = null;
  });

  return inlineWidth
    ? <span
        class={`${className()}${isFullBlock(text()) ? " mjb" : ""}`}
        style={{ left: `${start()}ch`, width: `${width()}ch` }}
      >
        {text()}
      </span>
    : <span
        class={`${className()} mjw-${width()}${isFullBlock(text()) ? " mjb" : ""}`}
        style={{ left: `${start()}ch` }}
      >
        {text()}
      </span>;
}

export function TerminalRow({ record }) {
  let spanRecords = spanRuns(record.snapshot).map(createSpanRecord);
  const spans = createCollection(spanRecords);
  const spanView = spans.map((readRecord) =>
    <TerminalSpan record={untrack(readRecord)} />
  );

  record.applySnapshot = (snapshot) => {
    record.snapshot = snapshot;
    const nextSpans = spanRuns(snapshot);
    const previousSpans = spanRecords.map((entry) => entry.current);
    const plan = planSpanReconciliation(
      previousSpans,
      nextSpans
    );
    renderDiagnostics.spanReconciliation(
      previousSpans,
      nextSpans,
      plan
    );
    for (const [beforeIndex, afterIndex] of plan.reusedPairs) {
      updateSpanRecord(
        spanRecords[beforeIndex],
        nextSpans[afterIndex]
      );
    }

    if (plan.operations.length === 0) {
      return;
    }
    for (
      let index = plan.operations.length - 1;
      index >= 0;
      index -= 1
    ) {
      const operation = plan.operations[index];
      const insertedRecords = nextSpans
        .slice(
          operation.nextStart,
          operation.nextStart + operation.insertCount
        )
        .map(createSpanRecord);
      spans.splice(
        operation.start,
        operation.removeCount,
        ...insertedRecords
      );
      spanRecords.splice(
        operation.start,
        operation.removeCount,
        ...insertedRecords
      );
    }
  };

  onDispose(() => {
    record.applySnapshot = null;
  });

  return <div class="mjr">{spanView}</div>;
}
