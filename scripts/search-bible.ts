import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

import { searchBible, type BibleSearchResult } from "../lib/bible/index";

loadEnvFromLocalFile();

type ScriptOptions = {
  term: string;
  translation: string;
  limit: number;
  useApi: boolean;
};

const DEFAULT_TERM = "love";
const DEFAULT_TRANSLATION = "NLT";
const DEFAULT_LIMIT = 5;

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { term, translation, limit, useApi } = options;

  const start = performance.now();
  const results = useApi
    ? await searchViaApi({ term, translation, limit })
    : await searchBible({ term, translation, limit });
  const durationMs = performance.now() - start;

  if (results.length === 0) {
    console.log("No verses found.");
    return;
  }

  const references = results.map(
    (result) => `${result.book} ${result.chapter}:${result.verse}`,
  );
  const scores = results.map((result) =>
    typeof result.score === "number" ? result.score.toFixed(3) : "n/a",
  );
  const translations = results.map((result) => result.translation ?? "");

  const referenceWidth = Math.max(
    "Reference".length,
    ...references.map((value) => value.length),
  );
  const scoreWidth = Math.max(
    "Score".length,
    ...scores.map((value) => value.length),
  );
  const translationWidth = Math.max(
    "Translation".length,
    ...translations.map((value) => value.length),
  );
  const verseHeader = "Verse";
  const separatorWidth = Math.max(
    `Results for "${term}" (${translation}, limit ${limit})${
      useApi ? " via API" : ""
    }`.length,
    referenceWidth + scoreWidth + translationWidth + verseHeader.length + 6,
  );

  const header = `Results for "${term}" (${translation}, limit ${limit})${
    useApi ? " via API" : ""
  }`;
  console.log(header);
  console.log(`Completed in ${durationMs.toFixed(0)} ms`);
  console.log("-".repeat(separatorWidth));
  console.log(
    [
      padEnd("Reference", referenceWidth),
      padEnd("Score", scoreWidth),
      padEnd("Translation", translationWidth),
      verseHeader,
    ].join("  "),
  );
  console.log("-".repeat(separatorWidth));

  results.forEach((result, index) => {
    const reference = references[index];
    const score = scores[index];
    const translationLabel = translations[index];
    console.log(
      [
        padEnd(reference, referenceWidth),
        padEnd(score, scoreWidth),
        padEnd(translationLabel, translationWidth),
        result.text,
      ].join("  "),
    );
  });
}

function parseArguments(argv: string[]): ScriptOptions {
  const termParts: string[] = [];
  let translation = DEFAULT_TRANSLATION;
  let limit = DEFAULT_LIMIT;
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

  const term = termParts.join(" ").trim() || DEFAULT_TERM;

  return {
    term,
    translation,
    limit,
    useApi,
  };
}

function parseLimit(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    throw new Error("Limit must be a finite integer.");
  }

  if (parsed <= 0) {
    throw new Error("Limit must be greater than zero.");
  }

  return parsed;
}

function padEnd(value: string, length: number): string {
  if (value.length >= length) {
    return value;
  }
  return `${value}${" ".repeat(length - value.length)}`;
}

async function searchViaApi({
  term,
  translation,
  limit,
}: Omit<ScriptOptions, "useApi">): Promise<BibleSearchResult[]> {
  const baseUrl = process.env.BIBLE_API_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      "BIBLE_API_BASE_URL environment variable must be set to use --api flag.",
    );
  }

  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error(
      "API_KEY environment variable must be set to use --api flag.",
    );
  }

  const url = new URL(baseUrl);
  const normalizedPath = url.pathname.replace(/\/$/, "");
  url.pathname = `${normalizedPath}/api/search`;
  url.searchParams.set("term", term);
  url.searchParams.set("translation", translation);
  url.searchParams.set("limit", String(limit));

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "x-api-key": apiKey,
      },
    });
  } catch (error) {
    throw new Error(
      `Failed to reach Bible API at ${url.toString()}: ${String(error)}`,
    );
  }

  if (!response.ok) {
    const rawBody = await response.text();
    let detail: string | undefined;
    if (rawBody.trim().length > 0) {
      try {
        const parsed = JSON.parse(rawBody) as { error?: unknown };
        detail =
          typeof parsed?.error === "string"
            ? parsed.error
            : JSON.stringify(parsed, null, 2);
      } catch {
        detail = rawBody;
      }
    }

    throw new Error(
      `Bible API request failed (${response.status} ${response.statusText})${
        detail ? `: ${detail}` : ""
      }`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`Unable to parse Bible API response: ${String(error)}`);
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    !Array.isArray((payload as { results?: unknown }).results)
  ) {
    throw new Error("Bible API response is missing a results array.");
  }

  return (payload as { results: BibleSearchResult[] }).results;
}

function loadEnvFromLocalFile(): void {
  const envPath = path.resolve(process.cwd(), ".env.local");
  let content: string;

  try {
    content = fs.readFileSync(envPath, "utf8");
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
}

(async () => {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
})();
