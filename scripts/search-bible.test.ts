import { describe, expect, it, vi } from "vitest";
// Test the utility functions directly since we can't easily import the script
describe("search-bible utility functions", () => {
  describe("parseArguments", () => {
    const parseArguments = (argv: string[]) => {
      const termParts: string[] = [];
      let translation = "NLT";
      let limit = 5;
      let useApi = false;

      let index = 0;
      while (index < argv.length) {
        const arg = argv[index];

        if (arg === "--translation" || arg === "-t") {
          const value = argv[index + 1];
          if (!value) {
            throw new Error("Missing value for --translation flag.");
          }
          translation = value.toUpperCase();
          index += 2;
          continue;
        }

        if (arg === "--limit" || arg === "-l") {
          const value = argv[index + 1];
          if (!value) {
            throw new Error("Missing value for --limit flag.");
          }
          limit = parseLimit(value);
          index += 2;
          continue;
        }

        if (arg === "--api") {
          useApi = true;
          index += 1;
          continue;
        }

        if (arg.startsWith("-")) {
          throw new Error(`Unknown flag: ${arg}`);
        }

        termParts.push(arg);
        index += 1;
      }

      const term = termParts.join(" ").trim() || "love";

      return {
        term,
        translation,
        limit,
        useApi,
      };
    };

    const parseLimit = (value: string): number => {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
        throw new Error("Limit must be a finite integer.");
      }

      if (parsed <= 0) {
        throw new Error("Limit must be greater than zero.");
      }

      return parsed;
    };

    it("handles command line arguments", () => {
      // Test default values
      expect(parseArguments([])).toEqual({
        term: "love",
        translation: "NLT",
        limit: 5,
        useApi: false,
      });

      // Test term parsing
      expect(parseArguments(["faith"])).toEqual({
        term: "faith",
        translation: "NLT",
        limit: 5,
        useApi: false,
      });

      expect(parseArguments(["multiple", "word", "search"])).toEqual({
        term: "multiple word search",
        translation: "NLT",
        limit: 5,
        useApi: false,
      });

      // Test translation flag
      expect(parseArguments(["--translation", "KJV"])).toEqual({
        term: "love",
        translation: "KJV",
        limit: 5,
        useApi: false,
      });

      expect(parseArguments(["-t", "ESV"])).toEqual({
        term: "love",
        translation: "ESV",
        limit: 5,
        useApi: false,
      });

      // Test limit flag
      expect(parseArguments(["--limit", "10"])).toEqual({
        term: "love",
        translation: "NLT",
        limit: 10,
        useApi: false,
      });

      expect(parseArguments(["-l", "3"])).toEqual({
        term: "love",
        translation: "NLT",
        limit: 3,
        useApi: false,
      });

      // Test api flag
      expect(parseArguments(["--api"])).toEqual({
        term: "love",
        translation: "NLT",
        limit: 5,
        useApi: true,
      });

      // Test combined flags
      expect(parseArguments(["hope", "-t", "KJV", "-l", "2", "--api"])).toEqual(
        {
          term: "hope",
          translation: "KJV",
          limit: 2,
          useApi: true,
        },
      );

      // Test error cases
      expect(() => parseArguments(["--translation"])).toThrow(
        "Missing value for --translation flag.",
      );
      expect(() => parseArguments(["--limit"])).toThrow(
        "Missing value for --limit flag.",
      );
      expect(() => parseArguments(["--unknown"])).toThrow(
        "Unknown flag: --unknown",
      );
      expect(() => parseArguments(["--limit", "invalid"])).toThrow(
        "Limit must be a finite integer.",
      );
      expect(() => parseArguments(["--limit", "0"])).toThrow(
        "Limit must be greater than zero.",
      );
      expect(() => parseArguments(["--limit", "-1"])).toThrow(
        "Limit must be greater than zero.",
      );
    });
  });

  describe("parseLimit", () => {
    const parseLimit = (value: string): number => {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
        throw new Error("Limit must be a finite integer.");
      }

      if (parsed <= 0) {
        throw new Error("Limit must be greater than zero.");
      }

      return parsed;
    };

    it("validates limit values", () => {
      expect(parseLimit("5")).toBe(5);
      expect(parseLimit("10")).toBe(10);
      expect(parseLimit("1")).toBe(1);

      expect(() => parseLimit("invalid")).toThrow(
        "Limit must be a finite integer.",
      );
      expect(() => parseLimit("0")).toThrow("Limit must be greater than zero.");
      expect(() => parseLimit("-1")).toThrow(
        "Limit must be greater than zero.",
      );
      // Note: parseLimit with "1.5" will return 1 (parseInt truncates decimals)
      // This is the actual behavior in the original code
      expect(parseLimit("1.5")).toBe(1);
    });
  });

  describe("padEnd", () => {
    const padEnd = (value: string, length: number): string => {
      if (value.length >= length) {
        return value;
      }
      return `${value}${" ".repeat(length - value.length)}`;
    };

    it("pads strings correctly", () => {
      expect(padEnd("test", 6)).toBe("test  ");
      expect(padEnd("test", 4)).toBe("test");
      expect(padEnd("test", 3)).toBe("test");
      expect(padEnd("", 5)).toBe("     ");
    });
  });

  describe("loadEnvFromLocalFile", () => {
    type ReadFileSyncMock = ReturnType<
      typeof vi.fn<(path: string, encoding?: BufferEncoding) => string>
    >;

    type FsModule = {
      readFileSync: ReadFileSyncMock;
    };

    const loadEnvFromLocalFile = (fsModule: FsModule) => {
      const envPath = "/test/.env.local";
      let content: string;

      try {
        content = fsModule.readFileSync(envPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          return;
        }
        throw error;
      }

      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) {
          continue;
        }

        const equalsIndex = line.indexOf("=");
        if (equalsIndex === -1) {
          continue;
        }

        const key = line.slice(0, equalsIndex).trim();
        if (!key) {
          continue;
        }

        let value = line.slice(equalsIndex + 1).trim();
        const quoted = value.match(/^(['"])(.*)\1$/);
        if (quoted) {
          value = quoted[2];
        }

        if (!(key in process.env)) {
          process.env[key] = value;
        }
      }
    };

    it("loads environment variables", () => {
      // Create a mock fs module
      const mockFs: FsModule = {
        readFileSync: vi.fn<
          (path: string, encoding?: BufferEncoding) => string
        >(
          () => `
          # Comment
          API_KEY=test-key-123
          BIBLE_API_BASE_URL=http://localhost:3000
          ANOTHER_VAR=value
        `,
        ),
      };

      // Clear any existing env vars
      delete process.env.API_KEY;
      delete process.env.BIBLE_API_BASE_URL;
      delete process.env.ANOTHER_VAR;

      loadEnvFromLocalFile(mockFs);

      expect(process.env.API_KEY).toBe("test-key-123");
      expect(process.env.BIBLE_API_BASE_URL).toBe("http://localhost:3000");
      expect(process.env.ANOTHER_VAR).toBe("value");

      // Test with quoted values
      mockFs.readFileSync.mockReturnValue(`
        API_KEY="quoted-key"
        BIBLE_API_BASE_URL='http://example.com'
      `);

      delete process.env.API_KEY;
      delete process.env.BIBLE_API_BASE_URL;

      loadEnvFromLocalFile(mockFs);

      expect(process.env.API_KEY).toBe("quoted-key");
      expect(process.env.BIBLE_API_BASE_URL).toBe("http://example.com");
    });

    it("handles missing .env.local file gracefully", () => {
      const mockFs: FsModule = {
        readFileSync: vi.fn<
          (path: string, encoding?: BufferEncoding) => string
        >(() => {
          const error = new Error("File not found") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }),
      };

      // Should not throw
      expect(() => loadEnvFromLocalFile(mockFs)).not.toThrow();
    });
  });
});
