import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import initSqlJs from "sql.js";

const require = createRequire(import.meta.url);

const DEFAULT_TRANSLATION = "NLT";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;
const PROJECT_ROOT = process.cwd();
const DATABASE_PATH = path.join(PROJECT_ROOT, "data", "bible.sqlite");
const SQL_WASM_FILENAME = "sql-wasm.wasm";
const SQL_JS_WASM_ENV_KEY = "SQL_JS_WASM_PATH";
const DEFAULT_BLOB_ENDPOINT = "https://blob.vercel-storage.com";
const DEFAULT_BLOB_PREFIX = "translations";

type TranslationJson = Record<string, Record<string, Record<string, string>>>;

type SqlJs = Awaited<ReturnType<typeof initSqlJs>>;
type SqlDatabase = InstanceType<SqlJs["Database"]>;

type VerseRecord = {
  book: string;
  chapter: number;
  verse: number;
  text: string;
  embedding: Float32Array;
};

type CorpusData = {
  translation: string;
  dimension: number;
  verses: VerseRecord[];
};

type VerseMatch = {
  verse: VerseRecord;
  score: number;
};

export type BibleSearchOptions = {
  term: string;
  limit?: number;
  maxResults?: number;
  translation?: string;
};

export type BibleSearchResult = {
  book: string;
  chapter: number;
  verse: number;
  text: string;
  translation: string;
  score: number;
};

let sqlModulePromise: Promise<SqlJs> | undefined;
let corpusPromise: Promise<CorpusData> | undefined;
const translationCache = new Map<string, Promise<TranslationJson>>();

export async function searchBible({
  term,
  limit,
  maxResults,
  translation,
}: BibleSearchOptions): Promise<BibleSearchResult[]> {
  const query = normalizeText(term ?? "");
  if (!query) {
    return [];
  }

  const rawLimit = limit ?? maxResults ?? DEFAULT_LIMIT;
  const clampedLimit = clampLimit(rawLimit);
  if (clampedLimit === 0) {
    return [];
  }

  const requestedTranslation = normalizeTranslation(translation);

  const corpus = await loadCorpus();
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return [];
  }

  const queryVector = vectorizeTokens(tokens, corpus.dimension);
  if (isZeroVector(queryVector)) {
    return [];
  }

  const matches = selectTopMatches(corpus.verses, queryVector, clampedLimit);
  if (requestedTranslation === corpus.translation) {
    return matches.map((match) => ({
      book: match.verse.book,
      chapter: match.verse.chapter,
      verse: match.verse.verse,
      text: match.verse.text,
      translation: corpus.translation,
      score: match.score,
    }));
  }

  const translationJson = await loadTranslationJson(requestedTranslation);

  return matches.map((match) => {
    const translated = lookupTranslationText(
      translationJson,
      match.verse,
      requestedTranslation,
    );

    return {
      book: match.verse.book,
      chapter: match.verse.chapter,
      verse: match.verse.verse,
      text: translated,
      translation: requestedTranslation,
      score: match.score,
    };
  });
}

function clampLimit(raw: number): number {
  if (!Number.isFinite(raw)) {
    throw new Error("Search result limit must be a finite number.");
  }

  const integer = Math.floor(raw);
  if (integer < 0) {
    throw new Error("Search result limit cannot be negative.");
  }

  return Math.min(integer, MAX_LIMIT);
}

function normalizeTranslation(value?: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0
    ? trimmed.toUpperCase()
    : DEFAULT_TRANSLATION;
}

async function loadSqlModule(): Promise<SqlJs> {
  if (!sqlModulePromise) {
    sqlModulePromise = (async () => {
      const wasmBinary = await loadSqlWasmBinary();
      return initSqlJs({ wasmBinary });
    })();
  }
  return sqlModulePromise;
}

async function loadCorpus(): Promise<CorpusData> {
  if (!corpusPromise) {
    corpusPromise = (async () => {
      const sql = await loadSqlModule();
      let fileBuffer: Uint8Array;

      try {
        fileBuffer = await fs.readFile(DATABASE_PATH);
      } catch (error) {
        throw new Error(
          `Unable to read Bible database at ${DATABASE_PATH}. ` +
            "Run `pnpm bible:ingest` to generate it.",
          { cause: error as Error },
        );
      }

      const db = new sql.Database(fileBuffer);

      try {
        const translation =
          readMetadata(db, "translation") ?? DEFAULT_TRANSLATION;
        const rawDimension = readMetadata(db, "embedding_dimension");
        const dimension = rawDimension
          ? Number.parseInt(rawDimension, 10)
          : NaN;
        if (!Number.isFinite(dimension) || dimension <= 0) {
          throw new Error(
            "Invalid or missing embedding dimension metadata in Bible database.",
          );
        }

        const verses = loadVerses(db, translation);
        if (verses.length === 0) {
          throw new Error(
            `No verses found in the Bible database for translation ${translation}.`,
          );
        }

        return { translation, dimension, verses };
      } finally {
        db.close();
      }
    })();
  }

  return corpusPromise;
}

let wasmBinaryPromise: Promise<Uint8Array> | undefined;

async function loadSqlWasmBinary(): Promise<Uint8Array> {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = (async () => {
      const candidates = resolveSqlWasmCandidates();

      const tried: string[] = [];
      for (const candidate of candidates) {
        try {
          return await fs.readFile(candidate);
        } catch (error) {
          if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
            tried.push(candidate);
            continue;
          }

          throw new Error(
            `Unable to read SQL.js WASM binary at ${candidate}.`,
            { cause: error as Error },
          );
        }
      }

      throw new Error(
        [
          "Unable to locate SQL.js WASM binary.",
          `Looked in: ${tried.join(", ") || "none"}.`,
          "Set SQL_JS_WASM_PATH to an absolute path if the binary lives elsewhere.",
        ].join(" "),
      );
    })();
  }

  return wasmBinaryPromise;
}

function resolveSqlWasmCandidates(): string[] {
  const candidates = new Set<string>();

  if (process.env[SQL_JS_WASM_ENV_KEY]) {
    const candidate = process.env[SQL_JS_WASM_ENV_KEY]!;
    candidates.add(
      path.isAbsolute(candidate)
        ? candidate
        : path.join(PROJECT_ROOT, candidate),
    );
  }

  const resolvedFromRequire = tryResolveModule("sql.js/dist/sql-wasm.wasm");
  if (resolvedFromRequire) {
    candidates.add(resolvedFromRequire);
  }

  candidates.add(
    path.join(
      PROJECT_ROOT,
      "node_modules",
      "sql.js",
      "dist",
      SQL_WASM_FILENAME,
    ),
  );
  candidates.add(path.join(PROJECT_ROOT, "data", SQL_WASM_FILENAME));

  return Array.from(candidates);
}

function tryResolveModule(specifier: string): string | undefined {
  try {
    return require.resolve(specifier);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException | undefined)?.code === "MODULE_NOT_FOUND"
    ) {
      return undefined;
    }
    throw error;
  }
}

function readMetadata(db: SqlDatabase, key: string): string | undefined {
  const statement = db.prepare(
    "SELECT value FROM metadata WHERE key = ? LIMIT 1;",
  );

  try {
    statement.bind([key]);
    if (!statement.step()) {
      return undefined;
    }

    const values = statement.get() as unknown[];
    const value = values[0];

    if (typeof value === "string") {
      return value;
    }

    if (typeof value === "number") {
      return value.toString();
    }

    return undefined;
  } finally {
    statement.free();
  }
}

function loadVerses(db: SqlDatabase, translation: string): VerseRecord[] {
  const statement = db.prepare(
    `
      SELECT book, chapter, verse, text, embedding
      FROM verses
      WHERE translation = ?
    `,
  );

  const verses: VerseRecord[] = [];

  try {
    statement.bind([translation]);

    while (statement.step()) {
      const row = statement.get() as unknown[];

      const book = row[0];
      const chapter = row[1];
      const verse = row[2];
      const text = row[3];
      const rawEmbedding = row[4];

      if (
        typeof book !== "string" ||
        typeof chapter !== "number" ||
        typeof verse !== "number" ||
        typeof text !== "string"
      ) {
        throw new Error("Encountered verse row with unexpected types.");
      }

      if (!(rawEmbedding instanceof Uint8Array)) {
        throw new Error(
          `Unexpected embedding type for ${book} ${chapter}:${verse}`,
        );
      }

      const floatView = new Float32Array(
        rawEmbedding.buffer,
        rawEmbedding.byteOffset,
        rawEmbedding.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );
      const embedding = new Float32Array(floatView.length);
      embedding.set(floatView);

      verses.push({
        book,
        chapter,
        verse,
        text,
        embedding,
      });
    }
  } finally {
    statement.free();
  }

  return verses;
}

async function loadTranslationJson(
  translation: string,
): Promise<TranslationJson> {
  const normalized = translation.toUpperCase();
  let cached = translationCache.get(normalized);
  if (!cached) {
    cached = (async () => {
      const blobConfig = resolveBlobConfig();
      if (blobConfig) {
        const remote = await loadTranslationFromBlob(normalized, blobConfig);
        if (remote) {
          return remote;
        }
      }

      return loadTranslationFromFilesystem(normalized);
    })();

    cached.catch(() => {
      translationCache.delete(normalized);
    });

    translationCache.set(normalized, cached);
  }

  return cached;
}

type BlobConfig = {
  baseUrl: string;
  token: string;
  prefix: string;
};

function resolveBlobConfig(): BlobConfig | null {
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  if (!token) {
    return null;
  }

  const baseUrl = DEFAULT_BLOB_ENDPOINT;
  const prefix = DEFAULT_BLOB_PREFIX;

  return {
    baseUrl,
    token,
    prefix,
  };
}

async function loadTranslationFromBlob(
  translation: string,
  config: BlobConfig,
): Promise<TranslationJson | null> {
  const key = `${config.prefix}/${translation}/${translation}_bible.json`;
  const url = `${config.baseUrl}/${key}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.token}`,
      },
    });
  } catch (error) {
    throw new Error(
      `Unable to reach Blob storage for translation ${translation}.`,
      { cause: error as Error },
    );
  }

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(
      `Blob storage returned ${response.status} ${response.statusText} for translation ${translation}.`,
    );
  }

  const raw = await response.text();
  try {
    return JSON.parse(raw) as TranslationJson;
  } catch (error) {
    throw new Error(
      `Blob translation payload for ${translation} is not valid JSON.`,
      { cause: error as Error },
    );
  }
}

async function loadTranslationFromFilesystem(
  translation: string,
): Promise<TranslationJson> {
  const filePath = path.join(
    PROJECT_ROOT,
    "lib",
    "bible",
    "translations",
    translation,
    `${translation}_bible.json`,
  );

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to load translation data for ${translation} at ${filePath}.`,
      { cause: error as Error },
    );
  }

  try {
    return JSON.parse(raw) as TranslationJson;
  } catch (error) {
    throw new Error(`Translation file for ${translation} is not valid JSON.`, {
      cause: error as Error,
    });
  }
}

function lookupTranslationText(
  translation: TranslationJson,
  verse: VerseRecord,
  translationName: string,
): string {
  const book = translation[verse.book];
  if (!book) {
    throw new Error(
      `Book ${verse.book} is not available in translation ${translationName}.`,
    );
  }

  const chapter = book[String(verse.chapter)];
  if (!chapter) {
    throw new Error(
      `Chapter ${verse.chapter} is not available in ${verse.book} (${translationName}).`,
    );
  }

  const text = chapter[String(verse.verse)];
  if (typeof text !== "string") {
    throw new Error(
      `Verse ${verse.book} ${verse.chapter}:${verse.verse} is not available in translation ${translationName}.`,
    );
  }

  return text;
}

function selectTopMatches(
  verses: VerseRecord[],
  queryVector: Float32Array,
  limit: number,
): VerseMatch[] {
  if (limit === 0) {
    return [];
  }

  const matches: VerseMatch[] = [];

  for (const verse of verses) {
    const score = dotProduct(queryVector, verse.embedding);
    if (!Number.isFinite(score)) {
      continue;
    }

    if (matches.length < limit) {
      matches.push({ verse, score });
      continue;
    }

    let smallestIndex = 0;
    for (let index = 1; index < matches.length; index += 1) {
      if (matches[index].score < matches[smallestIndex].score) {
        smallestIndex = index;
      }
    }

    if (score <= matches[smallestIndex].score) {
      continue;
    }

    matches[smallestIndex] = { verse, score };
  }

  return matches.sort((left, right) => right.score - left.score);
}

function dotProduct(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) {
    throw new Error("Vectors must have the same length to compute similarity.");
  }

  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    sum += left[index] * right[index];
  }
  return sum;
}

function vectorizeTokens(tokens: string[], dimension: number): Float32Array {
  const vector = new Float32Array(dimension);
  if (tokens.length === 0) {
    return vector;
  }

  for (const token of tokens) {
    const index = hashToken(token, dimension);
    vector[index] += 1;
  }

  let sumSquares = 0;
  for (let index = 0; index < vector.length; index += 1) {
    sumSquares += vector[index] * vector[index];
  }

  if (sumSquares > 0) {
    const norm = Math.sqrt(sumSquares);
    for (let index = 0; index < vector.length; index += 1) {
      vector[index] /= norm;
    }
  }

  return vector;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function hashToken(token: string, dimension: number): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
    hash >>>= 0;
  }

  return hash % dimension;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isZeroVector(vector: Float32Array): boolean {
  for (let index = 0; index < vector.length; index += 1) {
    if (vector[index] !== 0) {
      return false;
    }
  }
  return true;
}
