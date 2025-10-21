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
