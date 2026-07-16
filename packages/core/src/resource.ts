// Branded resource-type tag: a plain string at runtime (serializes as-is), unforgeable
// in types. The core is content-agnostic — it stores and compares tags for equality
// (route/extractor type-match) but knows no fixed resource set. Resources are authored
// content in the app layer (DESIGN.md: procedural islands), keeping the core dep-free.
declare const RESOURCE_BRAND: unique symbol;

export type ResourceType = string & { readonly [RESOURCE_BRAND]: true };

// Mint site for tagging a string as a resource type; the same cast rehydrates one from a
// save document. Validity (non-empty) is enforced at the command and import boundaries,
// like Id.
export function resourceType(value: string): ResourceType {
  return value as ResourceType;
}
