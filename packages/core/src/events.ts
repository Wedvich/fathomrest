import type { Id } from "./ids.ts";

// Same-timestamp events resolve by (time, kind priority, entity id) so online and
// offline replays pop in the same order (ADR-0001 implementation notes). Deposit tier
// crossings change rates, so they resolve before same-instant level crossings.
// research-complete stops a pool's drain (zeroes its pull), a structural change, so it
// resolves before the warehouse crossings it can invalidate. Priorities are an in-memory
// comparator only — saves store the kind string, so reordering needs no migration.
export const EVENT_KIND_PRIORITY = {
  "deposit-tier-depleted": 0,
  "research-complete": 1,
  "warehouse-full": 2,
  "warehouse-empty": 3,
} as const;

export type EventKind = keyof typeof EVENT_KIND_PRIORITY;

export interface SimEvent {
  readonly time: number;
  readonly kind: EventKind;
  readonly entityId: Id;
  // Snapshot of the owning component's eventSeq at scheduling time. Rescheduling bumps
  // the component's counter, leaving superseded events behind as stale — lazy deletion
  // without tombstone flags or object back-references (events stay plain save data).
  readonly seq: number;
}

export interface EventQueue {
  // Binary min-heap; slots >= size are null. Grows geometrically, never shrinks.
  heap: (SimEvent | null)[];
  size: number;
}

const INITIAL_CAPACITY = 64;

function nullSlots(length: number): (SimEvent | null)[] {
  return Array.from({ length }, (): SimEvent | null => null);
}

export function createEventQueue(): EventQueue {
  return { heap: nullSlots(INITIAL_CAPACITY), size: 0 };
}

export function compareEvents(a: SimEvent, b: SimEvent): number {
  if (a.time !== b.time) {
    return a.time - b.time;
  }
  const byKind = EVENT_KIND_PRIORITY[a.kind] - EVENT_KIND_PRIORITY[b.kind];
  if (byKind !== 0) {
    return byKind;
  }
  return a.entityId - b.entityId;
}

function eventAt(queue: EventQueue, index: number): SimEvent {
  const event = queue.heap[index];
  if (event === null || event === undefined) {
    throw new Error(`event queue corrupt: empty slot ${index} below size ${queue.size}`);
  }
  return event;
}

export function pushEvent(queue: EventQueue, event: SimEvent): void {
  if (queue.size === queue.heap.length) {
    const oldHeap = queue.heap;
    const grown = nullSlots(oldHeap.length * 2);
    for (let i = 0; i < oldHeap.length; i += 1) {
      grown[i] = oldHeap[i] ?? null;
    }
    queue.heap = grown;
  }
  let index = queue.size;
  queue.size += 1;
  queue.heap[index] = event;
  while (index > 0) {
    const parentIndex = (index - 1) >> 1;
    const parent = eventAt(queue, parentIndex);
    if (compareEvents(parent, event) <= 0) {
      break;
    }
    queue.heap[index] = parent;
    queue.heap[parentIndex] = event;
    index = parentIndex;
  }
}

export function peekEvent(queue: EventQueue): SimEvent | null {
  return queue.size === 0 ? null : eventAt(queue, 0);
}

export function popEvent(queue: EventQueue): SimEvent | null {
  if (queue.size === 0) {
    return null;
  }
  const top = eventAt(queue, 0);
  queue.size -= 1;
  const moved = eventAt(queue, queue.size);
  queue.heap[queue.size] = null;
  if (queue.size > 0) {
    queue.heap[0] = moved;
    let index = 0;
    for (;;) {
      const left = 2 * index + 1;
      if (left >= queue.size) {
        break;
      }
      const right = left + 1;
      let smallest = left;
      if (right < queue.size && compareEvents(eventAt(queue, right), eventAt(queue, left)) < 0) {
        smallest = right;
      }
      const child = eventAt(queue, smallest);
      if (compareEvents(child, moved) >= 0) {
        break;
      }
      queue.heap[index] = child;
      queue.heap[smallest] = moved;
      index = smallest;
    }
  }
  return top;
}

// Every queued event (stale ones included) in deterministic comparator order — the
// serializer's canonical event list.
export function allEvents(queue: EventQueue): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < queue.size; i += 1) {
    events.push(eventAt(queue, i));
  }
  return events.sort(compareEvents);
}
