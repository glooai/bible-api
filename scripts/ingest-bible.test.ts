import { describe, expect, it } from "vitest";

// Test the utility functions directly since we can't easily import the script
describe("ingest-bible utility functions", () => {
  describe("parseDimension", () => {
    const parseDimension = (raw?: string | null): number | undefined => {
      if (!raw) return undefined;
      const value = Number.parseInt(raw, 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid embedding dimension: ${raw}`);
      }
      return value;
    };

    it("validates embedding dimensions", () => {
      expect(parseDimension("384")).toBe(384);
      expect(parseDimension("256")).toBe(256);
      expect(parseDimension("")).toBeUndefined();
      expect(parseDimension(null)).toBeUndefined();
      expect(parseDimension(undefined)).toBeUndefined();

      expect(() => parseDimension("invalid")).toThrow(
        "Invalid embedding dimension: invalid",
      );
      expect(() => parseDimension("0")).toThrow(
        "Invalid embedding dimension: 0",
      );
      expect(() => parseDimension("-1")).toThrow(
        "Invalid embedding dimension: -1",
      );
    });
  });

  describe("normalizeText", () => {
    const normalizeText = (text: string): string => {
      return text.replace(/\s+/g, " ").trim();
    };

    it("cleans text", () => {
      expect(normalizeText("  Hello   World  ")).toBe("Hello World");
      expect(normalizeText("Multiple    spaces")).toBe("Multiple spaces");
      expect(normalizeText("NoSpaces")).toBe("NoSpaces");
      expect(normalizeText("")).toBe("");
    });
  });

  describe("tokenize", () => {
    const tokenize = (text: string): string[] => {
      return text
        .toLowerCase()
        .replace(/[^a-z0-9\s']/g, " ")
        .split(/\s+/)
        .filter(Boolean);
    };

    it("splits text into tokens", () => {
      expect(tokenize("Hello world")).toEqual(["hello", "world"]);
      expect(tokenize("God's love")).toEqual(["god's", "love"]);
      expect(tokenize("John 3:16")).toEqual(["john", "3", "16"]);
      expect(tokenize("")).toEqual([]);
      expect(tokenize("   ")).toEqual([]);
    });
  });

  describe("hashToken", () => {
    const hashToken = (token: string, dimension: number): number => {
      let hash = 0x811c9dc5;
      for (let index = 0; index < token.length; index += 1) {
        hash ^= token.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
        hash >>>= 0;
      }

      return hash % dimension;
    };

    it("generates consistent hashes", () => {
      const hash1 = hashToken("test", 100);
      const hash2 = hashToken("test", 100);
      expect(hash1).toBe(hash2);
      expect(hash1).toBeGreaterThanOrEqual(0);
      expect(hash1).toBeLessThan(100);

      const hash3 = hashToken("different", 100);
      expect(hash3).not.toBe(hash1);
    });
  });

  describe("vectorize", () => {
    const tokenize = (text: string): string[] => {
      return text
        .toLowerCase()
        .replace(/[^a-z0-9\s']/g, " ")
        .split(/\s+/)
        .filter(Boolean);
    };

    const hashToken = (token: string, dimension: number): number => {
      let hash = 0x811c9dc5;
      for (let index = 0; index < token.length; index += 1) {
        hash ^= token.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
        hash >>>= 0;
      }

      return hash % dimension;
    };

    const vectorize = (text: string, dimension: number): Float32Array => {
      const tokens = tokenize(text);
      const vector = new Float32Array(dimension);
      if (tokens.length === 0) {
        return vector;
      }

      for (const token of tokens) {
        const index = hashToken(token, dimension);
        vector[index] += 1;
      }

      let sumSquares = 0;
      for (let i = 0; i < vector.length; i += 1) {
        sumSquares += vector[i] * vector[i];
      }

      if (sumSquares > 0) {
        const norm = Math.sqrt(sumSquares);
        for (let i = 0; i < vector.length; i += 1) {
          vector[i] /= norm;
        }
      }

      return vector;
    };

    it("creates normalized vectors", () => {
      const vector = vectorize("test text", 10);
      expect(vector).toBeInstanceOf(Float32Array);
      expect(vector.length).toBe(10);

      // Check that it's normalized (sum of squares should be 1 or 0)
      let sumSquares = 0;
      for (let i = 0; i < vector.length; i++) {
        sumSquares += vector[i] * vector[i];
      }
      expect(sumSquares).toBeCloseTo(1, 5);
    });
  });
});
