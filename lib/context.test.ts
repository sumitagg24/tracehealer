import { describe, expect, it } from "vitest";
import { normalizeRepositoryPath } from "@/lib/context";

describe("repository context paths", () => {
  it("normalizes Windows separators for portable persisted paths", () => {
    expect(normalizeRepositoryPath("src\\order-support.mjs")).toBe(
      "src/order-support.mjs",
    );
  });

  it("leaves portable paths unchanged", () => {
    expect(normalizeRepositoryPath("test/order-support.test.mjs")).toBe(
      "test/order-support.test.mjs",
    );
  });
});
