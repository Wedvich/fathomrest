import type { Id } from "./ids.ts";

// Deterministic Kahn topological sort over `nodes` and directed `edges` (src -> dst).
// Iterative (no recursion, so untrusted deep chains can't overflow the stack). Nodes are
// seeded in `nodes` order and successor edges retired in `edges` order, so ties break by
// table order — replay stays bit-identical (docs/browser-performance.md: determinism).
// Returns the topological order, or null if the edges contain a cycle (some node never
// reaches indegree zero). Every edge endpoint must be present in `nodes`.
export function topoSort(nodes: readonly Id[], edges: readonly (readonly [Id, Id])[]): Id[] | null {
  const successors = new Map<Id, Id[]>();
  const indegree = new Map<Id, number>();
  for (const node of nodes) {
    successors.set(node, []);
    indegree.set(node, 0);
  }
  for (const [src, dst] of edges) {
    successors.get(src)?.push(dst);
    indegree.set(dst, (indegree.get(dst) ?? 0) + 1);
  }
  const order: Id[] = [];
  // Growing queue: pushes during iteration are visited (array iterator tracks length),
  // and `node` is the element type, so no undefined-index cast is needed.
  const queue: Id[] = [];
  for (const node of nodes) {
    if (indegree.get(node) === 0) {
      queue.push(node);
    }
  }
  for (const node of queue) {
    order.push(node);
    for (const dst of successors.get(node) ?? []) {
      const remaining = (indegree.get(dst) ?? 0) - 1;
      indegree.set(dst, remaining);
      if (remaining === 0) {
        queue.push(dst);
      }
    }
  }
  return order.length === nodes.length ? order : null;
}
