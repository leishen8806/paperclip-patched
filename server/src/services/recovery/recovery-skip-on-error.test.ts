import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("stranded recovery candidate isolation", () => {
  it("wraps the candidate loop with a per-issue catch and skip", () => {
    const source = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
    expect(source).toMatch(/for \(const issue of candidates\) \{\s*try \{/s);
    expect(source).toMatch(/recovery candidate failed; skipping candidate/);
  });
});
