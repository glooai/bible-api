import { describe, expect, it } from "vitest";
import postcssConfig from "./postcss.config.mjs";

describe("postcss.config.mjs", () => {
  it("exports a valid PostCSS configuration object", () => {
    expect(postcssConfig).toBeDefined();
    expect(typeof postcssConfig).toBe("object");
  });

  it("has the expected plugins configuration", () => {
    expect(postcssConfig).toEqual({
      plugins: {
        "@tailwindcss/postcss": {},
      },
    });
  });

  it("has the tailwindcss plugin configured", () => {
    expect(postcssConfig.plugins).toHaveProperty("@tailwindcss/postcss");
    expect(postcssConfig.plugins["@tailwindcss/postcss"]).toEqual({});
  });
});
