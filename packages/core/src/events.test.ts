import { describe, expect, it } from "vitest";

import {
  allEvents,
  createEventQueue,
  peekEvent,
  popEvent,
  pushEvent,
  type SimEvent,
} from "./events.ts";
import { idFromNumber } from "./ids.ts";

function event(overrides: Partial<SimEvent>): SimEvent {
  return {
    time: 0,
    kind: "warehouse-full",
    entityId: idFromNumber(1),
    seq: 0,
    ...overrides,
  };
}

describe("event queue", () => {
  it("returns null on empty peek and pop", () => {
    const queue = createEventQueue();
    expect(peekEvent(queue)).toBeNull();
    expect(popEvent(queue)).toBeNull();
  });

  it("pops in time order regardless of push order", () => {
    const queue = createEventQueue();
    for (const time of [5, 1, 4, 2, 3]) {
      pushEvent(queue, event({ time }));
    }
    const popped: number[] = [];
    for (let next = popEvent(queue); next !== null; next = popEvent(queue)) {
      popped.push(next.time);
    }
    expect(popped).toEqual([1, 2, 3, 4, 5]);
  });

  it("breaks time ties by kind priority, then entity id", () => {
    const queue = createEventQueue();
    pushEvent(queue, event({ time: 1, kind: "warehouse-empty", entityId: idFromNumber(1) }));
    pushEvent(queue, event({ time: 1, kind: "warehouse-full", entityId: idFromNumber(2) }));
    pushEvent(queue, event({ time: 1, kind: "warehouse-full", entityId: idFromNumber(1) }));
    const popped: [string, number][] = [];
    for (let next = popEvent(queue); next !== null; next = popEvent(queue)) {
      popped.push([next.kind, next.entityId]);
    }
    expect(popped).toEqual([
      ["warehouse-full", 1],
      ["warehouse-full", 2],
      ["warehouse-empty", 1],
    ]);
  });

  it("grows past the initial capacity without losing order", () => {
    const queue = createEventQueue();
    const count = 500;
    for (let i = 0; i < count; i += 1) {
      // Deterministic scatter without Math.random.
      pushEvent(queue, event({ time: (i * 7919) % count, entityId: idFromNumber(i + 1) }));
    }
    let previous = -1;
    let popped = 0;
    for (let next = popEvent(queue); next !== null; next = popEvent(queue)) {
      expect(next.time).toBeGreaterThanOrEqual(previous);
      previous = next.time;
      popped += 1;
    }
    expect(popped).toBe(count);
  });

  it("lists queued events in comparator order without draining the heap", () => {
    const queue = createEventQueue();
    for (const time of [3, 1, 2]) {
      pushEvent(queue, event({ time }));
    }
    expect(allEvents(queue).map((e) => e.time)).toEqual([1, 2, 3]);
    expect(queue.size).toBe(3);
  });
});
