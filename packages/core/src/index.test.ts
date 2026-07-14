import { describe, expect, it } from "vitest";

import { CORE_PACKAGE } from "./index.js";

describe("core package", () => {
  it("exposes its package identifier", () => {
    expect(CORE_PACKAGE).toBe("@fathomrest/core");
  });
});
