import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { searchBible } from "./index";

type TranslationJson = Record<string, Record<string, Record<string, string>>>;

const translationCache = new Map<string, Promise<TranslationJson>>();
const translationsDir = path.join(
  process.cwd(),
  "lib",
  "bible",
  "translations",
);
const originalBlobToken = process.env.BLOB_READ_WRITE_TOKEN;

beforeEach(() => {
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  translationCache.clear();

  const fetchMock = vi.fn<typeof fetch>(async (input, _init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (!url.startsWith("https://blob.vercel-storage.com/")) {
      return new Response("Not Found", { status: 404 });
    }

    const match = url.match(/translations\/([^/]+)\/\1_bible\.json$/i);
    if (!match) {
      return new Response("Not Found", { status: 404 });
    }

    const translation = match[1].toUpperCase();
    const filePath = path.join(
      translationsDir,
      translation,
      `${translation}_bible.json`,
    );

    try {
      const raw = await fs.readFile(filePath, "utf8");
      return new Response(raw, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  });

  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  if (typeof originalBlobToken === "string") {
    process.env.BLOB_READ_WRITE_TOKEN = originalBlobToken;
  } else {
    delete process.env.BLOB_READ_WRITE_TOKEN;
  }

  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("searchBible", () => {
  it("returns NLT verses by default", async () => {
    const results = await searchBible({
      term: "steadfast love",
      limit: 3,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.translation === "NLT")).toBe(true);

    const expectedText = await getTranslationText(
      "NLT",
      results[0].book,
      results[0].chapter,
      results[0].verse,
    );

    expect(results[0].text).toBe(expectedText);
  });

  it("maps verses to requested translations", async () => {
    const baseResults = await searchBible({
      term: "steadfast love",
      limit: 5,
    });

    expect(baseResults.length).toBeGreaterThan(0);
    const seed = baseResults[0];

    const translatedResults = await searchBible({
      term: "steadfast love",
      translation: "KJV",
      limit: 5,
    });

    const match = translatedResults.find(
      (result) =>
        result.book === seed.book &&
        result.chapter === seed.chapter &&
        result.verse === seed.verse,
    );

    expect(match?.translation).toBe("KJV");

    if (!match) {
      throw new Error(
        "Unable to locate corresponding verse in translated results.",
      );
    }

    const expectedText = await getTranslationText(
      "KJV",
      match.book,
      match.chapter,
      match.verse,
    );

    expect(match.text).toBe(expectedText);
  });

  it("honors the maxResults alias", async () => {
    const results = await searchBible({
      term: "hope",
      maxResults: 2,
    });

    expect(results.length).toBe(2);
  });

  it("returns empty array for empty search term", async () => {
    const results = await searchBible({
      term: "",
    });

    expect(results).toEqual([]);
  });

  it("returns empty array for whitespace-only search term", async () => {
    const results = await searchBible({
      term: "   ",
    });

    expect(results).toEqual([]);
  });

  it("handles limit parameter correctly", async () => {
    const results = await searchBible({
      term: "love",
      limit: 1,
    });

    expect(results.length).toBe(1);
  });

  it("clamps limit to maximum value", async () => {
    const results = await searchBible({
      term: "love",
      limit: 100, // MAX_LIMIT is 50
    });

    expect(results.length).toBeLessThanOrEqual(50);
  });

  it("throws error for invalid limit values", async () => {
    await expect(
      searchBible({
        term: "love",
        limit: -1,
      }),
    ).rejects.toThrow("Search result limit cannot be negative.");

    await expect(
      searchBible({
        term: "love",
        limit: Infinity,
      }),
    ).rejects.toThrow("Search result limit must be a finite number.");
  });

  it("normalizes translation names to uppercase", async () => {
    const results = await searchBible({
      term: "love",
      translation: "nlt", // lowercase
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.translation === "NLT")).toBe(true);
  });

  it("uses default translation when none specified", async () => {
    const results = await searchBible({
      term: "love",
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.translation === "NLT")).toBe(true);
  });
});

async function getTranslationText(
  translation: string,
  book: string,
  chapter: number,
  verse: number,
): Promise<string> {
  const data = await loadTranslationJson(translation);
  const chapterData = data[book]?.[String(chapter)];
  const text = chapterData?.[String(verse)];

  if (typeof text !== "string") {
    throw new Error(
      `Missing ${book} ${chapter}:${verse} in translation ${translation}`,
    );
  }

  return text;
}

async function loadTranslationJson(
  translation: string,
): Promise<TranslationJson> {
  const key = translation.toUpperCase();
  let cached = translationCache.get(key);

  if (!cached) {
    cached = (async () => {
      const filePath = path.join(
        process.cwd(),
        "lib",
        "bible",
        "translations",
        key,
        `${key}_bible.json`,
      );

      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw) as TranslationJson;
    })();

    translationCache.set(key, cached);
  }

  return cached;
}
