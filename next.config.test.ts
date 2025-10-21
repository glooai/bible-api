import { describe, expect, it } from "vitest";
import nextConfig from "./next.config";

describe("next.config.ts", () => {
  it("exports a valid Next.js configuration object", () => {
    expect(nextConfig).toBeDefined();
    expect(typeof nextConfig).toBe("object");
  });

  it("has expected configuration structure", () => {
    // Next.js config can be empty or contain various options
    // The important thing is that it exports a valid object
    expect(nextConfig).toEqual(expect.any(Object));
  });
});
