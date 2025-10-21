import { describe, expect, it } from "vitest";

describe("Home Page", () => {
  it("exports a default function", async () => {
    // This test verifies that the page exports a default function
    const pageModule = await import("./page");
    expect(typeof pageModule.default).toBe("function");
  });

  it("has expected component structure", async () => {
    // We can test that the component exists and is a React component
    const pageModule = await import("./page");
    const Home = pageModule.default;
    expect(Home).toBeDefined();
    expect(typeof Home).toBe("function");
  });
});
