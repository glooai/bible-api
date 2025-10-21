import crypto from "node:crypto";
import { type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import initSqlJs from "sql.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type TranslationJson = Record<string, Record<string, Record<string, string>>>;

type VerseRow = {
  translation: string;
  book: string;
  chapter: number;
  verse: number;
  text: string;
  embedding: Float32Array;
};

type ScriptOptions = {
  translation: string;
  dimension: number;
};

type SqlJs = Awaited<ReturnType<typeof initSqlJs>>;

type SqlDatabase = InstanceType<SqlJs["Database"]>;

const DEFAULT_TRANSLATION = "NLT";
const DEFAULT_DIMENSION = 384;

async function main() {
  await loadEnvFromLocalFile();

  const options = parseOptions(process.argv.slice(2), {
    translation: process.env.BIBLE_TRANSLATION ?? DEFAULT_TRANSLATION,
    dimension: parseDimension(process.env.EMBED_DIM) ?? DEFAULT_DIMENSION,
  });

  const bibleJsonPath = path.join(
    projectRoot(),
    "lib",
    "bible",
    "translations",
    options.translation,
    `${options.translation}_bible.json`,
  );

  const sql = await initSqlJs({
    locateFile: (file: string) =>
      path.join(projectRoot(), "node_modules", "sql.js", "dist", file),
  });

  const db = new sql.Database();
  ensureSchema(db);

  console.log(
    `Loading ${options.translation} translation (embedding dimension ${options.dimension})`,
  );
  const translationJson = await loadTranslation(bibleJsonPath);
  const verses = flattenTranslation(
    options.translation,
    translationJson,
    options.dimension,
  );

  console.log(`Loaded ${verses.length.toLocaleString()} verses. Inserting...`);
  insertVerses(db, verses);
  recordMetadata(db, options);

  await writeDatabase(db, options.translation);
  console.log("Done!");

  await syncTranslationsWithBlob();
}

function projectRoot() {
  return path.join(__dirname, "..");
}

function parseDimension(raw?: string | null): number | undefined {
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid embedding dimension: ${raw}`);
  }
  return value;
}

function parseOptions(args: string[], defaults: ScriptOptions): ScriptOptions {
  let translation = defaults.translation;
  let dimension = defaults.dimension;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--translation" || arg === "-t") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --translation");
      }
      translation = value.toUpperCase();
      index += 1;
    } else if (arg === "--dimension" || arg === "-d") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --dimension");
      }
      dimension = parseDimension(value) ?? dimension;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { translation, dimension };
}

async function loadTranslation(filePath: string): Promise<TranslationJson> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as TranslationJson;
  } catch (error) {
    throw new Error(
      `Unable to read translation data at ${filePath}. ` +
        "Set --translation to a translation folder that exists in lib/bible/translations.",
      { cause: error as Error },
    );
  }
}

function flattenTranslation(
  translation: string,
  translationJson: TranslationJson,
  dimension: number,
): VerseRow[] {
  const verses: VerseRow[] = [];

  for (const [book, chapters] of Object.entries(translationJson)) {
    for (const [chapterKey, chapterContent] of Object.entries(chapters)) {
      const chapter = Number.parseInt(chapterKey, 10);

      for (const [verseKey, text] of Object.entries(chapterContent)) {
        const verse = Number.parseInt(verseKey, 10);
        const cleaned = normalizeText(text);
        verses.push({
          translation,
          book,
          chapter,
          verse,
          text: cleaned,
          embedding: vectorize(cleaned, dimension),
        });
      }
    }
  }

  return verses;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function vectorize(text: string, dimension: number): Float32Array {
  // Hashing trick keeps embeddings light-weight without external ML dependencies.
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

async function syncTranslationsWithBlob(): Promise<void> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    console.warn(
      "BLOB_READ_WRITE_TOKEN is not set; skipping translation Blob sync.",
      );
    return;
  }

  const translationsDir = path.join(
    projectRoot(),
    "lib",
    "bible",
    "translations",
  );
  const prefix = blobPrefix();
  const manifestKey = `${prefix}/manifest.json`;
  const manifest = await readBlobManifest(manifestKey, token);
  let manifestDirty = false;

  let entries: Dirent[];
  try {
    entries = await fs.readdir(translationsDir, { withFileTypes: true });
  } catch (error) {
    console.warn(
      `Unable to enumerate translations directory at ${translationsDir}.`,
      error,
    );
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const translation = entry.name.toUpperCase();
    const filePath = path.join(
      translationsDir,
      entry.name,
      `${translation}_bible.json`,
    );

    if (!(await fileExists(filePath))) {
      continue;
    }

    try {
      const changed = await syncTranslationFileToBlob({
        translation,
        filePath,
        token,
        prefix,
        manifest,
      });
      if (changed) {
        manifestDirty = true;
      }
    } catch (error) {
      console.warn(
        `Failed to upload ${translation} translation to Blob storage.`,
        error,
      );
    }
  }

  if (manifestDirty) {
    try {
      await putBlobObject({
        key: manifestKey,
        body: encodeJson(manifest),
        token,
        contentType: "application/json",
      });
      console.log(
        `Updated translation manifest at ${manifestKey} (${Object.keys(manifest).length} entries).`,
      );
    } catch (error) {
      console.warn(
        "Failed to update translation manifest in Blob storage.",
        error,
      );
    }
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

type SyncTranslationOptions = {
  translation: string;
  filePath: string;
  token: string;
  prefix: string;
  manifest: BlobManifest;
};

async function syncTranslationFileToBlob({
  translation,
  filePath,
  token,
  prefix,
  manifest,
}: SyncTranslationOptions): Promise<boolean> {
  const buffer = await fs.readFile(filePath);
  const hash = createSha256(buffer);
  const translationKey = `${prefix}/${translation}/${translation}_bible.json`;

  const existing = manifest[translation];

  if (existing?.hash === hash) {
    console.log(
      `Blob translation ${translation} is up to date (hash ${hash.slice(0, 8)}).`,
    );
    return false;
  }

  await putBlobObject({
    key: translationKey,
    body: buffer as Uint8Array,
    token,
    contentType: "application/json",
  });

  console.log(
    `Uploaded translation ${translation} to Blob storage (${formatBytes(buffer.byteLength)}).`,
  );

  manifest[translation] = {
    hash,
    size: buffer.byteLength,
    updatedAt: new Date().toISOString(),
  };

  return true;
}

type FetchBlobOptions = {
  method: "GET" | "HEAD";
};

async function fetchBlob(
  key: string,
  token: string,
  options: FetchBlobOptions,
): Promise<Response> {
  const url = `${blobEndpoint()}/${key}`;
  return fetch(url, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}

type PutBlobOptions = {
  key: string;
  body: Uint8Array;
  token: string;
  contentType: string;
};

async function putBlobObject({
  key,
  body,
  token,
  contentType,
}: PutBlobOptions): Promise<void> {
  const bodyBytes = new Uint8Array(body);
  const blob = new Blob([bodyBytes]);
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": body.byteLength.toString(),
    Authorization: `Bearer ${token}`,
  };

  const response = await fetch(`${blobEndpoint()}/${key}`, {
    method: "PUT",
    headers,
    body: blob as unknown as RequestInit["body"],
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = "";
    }

    throw new Error(
      `Failed to upload ${key} to Blob storage: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`,
    );
  }
}

function blobEndpoint(): string {
  return (
    process.env.BIBLE_BLOB_ENDPOINT ?? "https://blob.vercel-storage.com"
  ).replace(/\/+$/, "");
}

function blobPrefix(): string {
  return process.env.BIBLE_BLOB_PREFIX ?? "translations";
}

type TranslationManifest = {
  hash: string;
  size: number;
  updatedAt: string;
};

type BlobManifest = Record<string, TranslationManifest>;

function createSha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(value < 10 && index > 0 ? 1 : 0)} ${units[index]}`;
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

async function readBlobManifest(
  key: string,
  token: string,
): Promise<BlobManifest> {
  const response = await fetchBlob(key, token, { method: "GET" });
  if (response.status === 404) {
    return {};
  }

  if (!response.ok) {
    throw new Error(
      `Unable to read translation manifest at ${key}: ${response.status} ${response.statusText}`,
    );
  }

  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as BlobManifest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.warn("Manifest JSON is invalid. Rebuilding.", error);
    return {};
  }
}

async function loadEnvFromLocalFile(): Promise<void> {
  const envPath = path.join(projectRoot(), ".env.local");
  let content: string;

  try {
    content = await fs.readFile(envPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return;
    }

    console.warn(`Unable to load environment from ${envPath}.`, error);
    return;
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

function ensureSchema(db: SqlDatabase) {
  db.run(`
    CREATE TABLE IF NOT EXISTS verses (
      translation TEXT NOT NULL,
      book TEXT NOT NULL,
      chapter INTEGER NOT NULL,
      verse INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL,
      PRIMARY KEY (translation, book, chapter, verse)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function insertVerses(db: SqlDatabase, verses: VerseRow[]) {
  const statement = db.prepare(`
    INSERT OR REPLACE INTO verses
    (translation, book, chapter, verse, text, embedding)
    VALUES (?, ?, ?, ?, ?, ?);
  `);

  try {
    db.run("BEGIN TRANSACTION;");
    for (const verse of verses) {
      const bytes = new Uint8Array(verse.embedding.buffer.slice(0));
      statement.run([
        verse.translation,
        verse.book,
        verse.chapter,
        verse.verse,
        verse.text,
        bytes,
      ]);
    }
    db.run("COMMIT;");
  } catch (error) {
    db.run("ROLLBACK;");
    throw error;
  } finally {
    statement.free();
  }
}

function recordMetadata(db: SqlDatabase, options: ScriptOptions) {
  const entries: [string, string][] = [
    ["translation", options.translation],
    ["embedding_dimension", String(options.dimension)],
    ["vectorizer", "hashed-bow-fnv1a"],
    ["generated_at", new Date().toISOString()],
  ];

  const statement = db.prepare(`
    INSERT OR REPLACE INTO metadata (key, value)
    VALUES (?, ?);
  `);

  try {
    db.run("BEGIN TRANSACTION;");
    for (const [key, value] of entries) {
      statement.run([key, value]);
    }
    db.run("COMMIT;");
  } catch (error) {
    db.run("ROLLBACK;");
    throw error;
  } finally {
    statement.free();
  }
}

async function writeDatabase(db: SqlDatabase, translation: string) {
  const exportData = db.export();
  const buffer = Buffer.from(exportData);

  const dataDir = path.join(projectRoot(), "data");
  await fs.mkdir(dataDir, { recursive: true });

  const filePath = path.join(dataDir, "bible.sqlite");
  await fs.writeFile(filePath, buffer);

  console.log(
    `Saved ${translation} translation to ${path.relative(projectRoot(), filePath)}`,
  );
}

(async () => {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
})();
