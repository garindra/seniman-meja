const enabled =
  process.env.SENIMAN_MEJA_RENDER_DIAGNOSTICS === "1";

const EMPTY_COUNTERS = Object.freeze({
  mejaFrames: 0,
  mejaEncodedBytes: 0,
  mejaRawBytes: 0,
  dirtyRows: 0,
  dirtyCells: 0,
  rowSnapshots: 0,
  spanRecordsBefore: 0,
  spanRecordsAfter: 0,
  stableSpanUpdates: 0,
  styleOnlySpanChanges: 0,
  textOnlySpanChanges: 0,
  textAndStyleChanges: 0,
  widthOnlySpanChanges: 0,
  spanSplits: 0,
  spanMerges: 0,
  wholeRowSpanReplacements: 0,
  localizedSpanSplices: 0,
  collectionSetCalls: 0,
  collectionSpliceCalls: 0,
  insertedCollectionItems: 0,
  removedCollectionItems: 0,
  websocketMessages: 0,
  websocketPayloadBytes: 0,
  tcpBytesWritten: 0,
});

function freshCounters() {
  return { ...EMPTY_COUNTERS };
}

class WebSocketFrameCounter {
  constructor(add) {
    this.add = add;
    this.pending = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      return;
    }
    const value = Buffer.from(chunk);
    this.add("tcpBytesWritten", value.length);
    this.pending = this.pending.length
      ? Buffer.concat([this.pending, value])
      : value;
    this.drain();
  }

  drain() {
    while (this.pending.length >= 2) {
      const first = this.pending[0];
      const second = this.pending[1];
      let payloadLength = second & 0x7f;
      let offset = 2;
      if (payloadLength === 126) {
        if (this.pending.length < 4) {
          return;
        }
        payloadLength = this.pending.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.pending.length < 10) {
          return;
        }
        const length = this.pending.readBigUInt64BE(2);
        if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.pending = Buffer.alloc(0);
          return;
        }
        payloadLength = Number(length);
        offset = 10;
      }
      if (second & 0x80) {
        offset += 4;
      }
      const frameLength = offset + payloadLength;
      if (this.pending.length < frameLength) {
        return;
      }
      const opcode = first & 0x0f;
      if (opcode === 0x02 || opcode === 0x00) {
        this.add("websocketPayloadBytes", payloadLength);
        if (opcode === 0x02) {
          this.add("websocketMessages", 1);
        }
      }
      this.pending = this.pending.subarray(frameLength);
    }
  }
}

class RenderDiagnostics {
  constructor() {
    this.enabled = enabled;
    this.counters = freshCounters();
    this.startedAt = Date.now();
    this.cpuStart = process.cpuUsage();
    this.interval = null;
  }

  add(name, value = 1) {
    if (this.enabled) {
      this.counters[name] += value;
    }
  }

  mejaFrame({ encodedSize, rawSize }) {
    if (!this.enabled) {
      return;
    }
    this.add("mejaFrames");
    this.add("mejaEncodedBytes", encodedSize);
    this.add("mejaRawBytes", rawSize);
  }

  screenFrame(screen) {
    if (!this.enabled) {
      return;
    }
    this.add("dirtyRows", screen.dirtyRows.size);
  }

  rowSnapshot(cellCount) {
    if (!this.enabled) {
      return;
    }
    this.add("rowSnapshots");
    this.add("dirtyCells", cellCount);
  }

  spanTransition(previous, next, partitionMatches) {
    if (!this.enabled) {
      return;
    }
    this.add("spanRecordsBefore", previous.length);
    this.add("spanRecordsAfter", next.length);
    if (next.length > previous.length) {
      this.add("spanSplits", next.length - previous.length);
    } else if (previous.length > next.length) {
      this.add("spanMerges", previous.length - next.length);
    }
    if (!partitionMatches) {
      this.add("wholeRowSpanReplacements");
      this.collectionSplice(previous.length, next.length, false);
      return;
    }
    for (let index = 0; index < next.length; index += 1) {
      const before = previous[index];
      const after = next[index];
      const textChanged = before.text !== after.text;
      const styleChanged = before.className !== after.className;
      const widthChanged =
        before.start !== after.start || before.end !== after.end;
      if (!textChanged && !styleChanged && !widthChanged) {
        continue;
      }
      this.add("stableSpanUpdates");
      this.add("collectionSetCalls");
      if (textChanged && styleChanged) {
        this.add("textAndStyleChanges");
      } else if (textChanged) {
        this.add("textOnlySpanChanges");
      } else if (styleChanged) {
        this.add("styleOnlySpanChanges");
      } else if (widthChanged) {
        this.add("widthOnlySpanChanges");
      }
    }
  }

  spanReconciliation(previous, next, plan) {
    if (!this.enabled) {
      return;
    }
    this.add("spanRecordsBefore", previous.length);
    this.add("spanRecordsAfter", next.length);
    if (next.length > previous.length) {
      this.add("spanSplits", next.length - previous.length);
    } else if (previous.length > next.length) {
      this.add("spanMerges", previous.length - next.length);
    }
    for (const [beforeIndex, afterIndex] of plan.reusedPairs) {
      const before = previous[beforeIndex];
      const after = next[afterIndex];
      const textChanged = before.text !== after.text;
      const styleChanged = before.className !== after.className;
      const widthChanged =
        before.start !== after.start || before.end !== after.end;
      if (!textChanged && !styleChanged && !widthChanged) {
        continue;
      }
      this.add("stableSpanUpdates");
      if (textChanged && styleChanged) {
        this.add("textAndStyleChanges");
      } else if (textChanged) {
        this.add("textOnlySpanChanges");
      } else if (styleChanged) {
        this.add("styleOnlySpanChanges");
      } else if (widthChanged) {
        this.add("widthOnlySpanChanges");
      }
    }
    if (plan.removeCount || plan.insertCount) {
      this.collectionSplice(
        plan.removeCount,
        plan.insertCount,
        plan.reusedPairs.length > 0
      );
      if (plan.reusedPairs.length === 0) {
        this.add("wholeRowSpanReplacements");
      }
    }
  }

  collectionSplice(removed, inserted, localized = true) {
    if (!this.enabled) {
      return;
    }
    this.add("collectionSpliceCalls");
    this.add("removedCollectionItems", removed);
    this.add("insertedCollectionItems", inserted);
    if (localized) {
      this.add("localizedSpanSplices");
    }
  }

  instrumentServer(server) {
    if (!this.enabled) {
      return;
    }
    server.on("upgrade", (_request, socket) => {
      const counter = new WebSocketFrameCounter(
        (name, value) => this.add(name, value)
      );
      const write = socket.write;
      socket.write = function (chunk, ...args) {
        counter.push(chunk);
        return write.call(this, chunk, ...args);
      };
    });
  }

  snapshot(reset = false) {
    const now = Date.now();
    const durationMs = now - this.startedAt;
    const cpu = process.cpuUsage(this.cpuStart);
    const result = {
      durationMs,
      ...this.counters,
      mejaRawBytesPerSecond:
        Math.round(this.counters.mejaRawBytes * 1000 / durationMs),
      websocketPayloadBytesPerSecond:
        Math.round(
          this.counters.websocketPayloadBytes * 1000 / durationMs
        ),
      tcpBytesWrittenPerSecond:
        Math.round(this.counters.tcpBytesWritten * 1000 / durationMs),
      cpuUserMs: cpu.user / 1000,
      cpuSystemMs: cpu.system / 1000,
      rssBytes: process.memoryUsage().rss,
    };
    if (reset) {
      this.counters = freshCounters();
      this.startedAt = now;
      this.cpuStart = process.cpuUsage();
    }
    return result;
  }

  start() {
    if (!this.enabled || this.interval) {
      return;
    }
    this.interval = setInterval(() => {
      console.error(
        "[render-diagnostics]",
        JSON.stringify(this.snapshot(true))
      );
    }, 5000);
    this.interval.unref?.();
  }
}

export const renderDiagnostics = new RenderDiagnostics();
