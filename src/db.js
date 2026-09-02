import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Indeksen er én fil. På en mekanisk disk er det poenget: sekvensiell skriving. */
export function dbPath() {
  if (process.env.LOVDATA_DB) return process.env.LOVDATA_DB;
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "mcp-lovdata", "lovdata.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  type TEXT, legacy_id TEXT, title TEXT, short_title TEXT, ministry TEXT,
  legal_areas TEXT, date_in_force TEXT, last_change_in_force TEXT,
  last_changed_by TEXT, last_updated TEXT, published_in TEXT, applies_to TEXT,
  based_on TEXT, language TEXT, source_file TEXT, url TEXT, article_count INTEGER
);
CREATE INDEX IF NOT EXISTS documents_type ON documents(type);
CREATE INDEX IF NOT EXISTS documents_ministry ON documents(ministry);
CREATE INDEX IF NOT EXISTS documents_legacy ON documents(legacy_id);

CREATE TABLE IF NOT EXISTS articles (
  rowid INTEGER PRIMARY KEY,
  doc_id TEXT NOT NULL, ordinal INTEGER, name TEXT, heading TEXT, chapter TEXT,
  text TEXT, changes TEXT, lovdata_url TEXT
);
CREATE INDEX IF NOT EXISTS articles_doc ON articles(doc_id, ordinal);
CREATE INDEX IF NOT EXISTS articles_name ON articles(doc_id, name);

-- remove_diacritics 0: æ, ø og å er egne bokstaver på norsk, ikke aksenter.
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  name, heading, chapter, text,
  content='articles', content_rowid='rowid',
  tokenize="unicode61 remove_diacritics 0"
);
-- Stortingssaker: forarbeidene. Indekseres inkrementelt, ikke sammen med
-- lovtekstene, fordi gamle sesjoner aldri endrer seg.
CREATE TABLE IF NOT EXISTS cases (
  -- Samme sak går igjen i sesjonen den ble fremmet og den den ble behandlet,
  -- med samme id. Nøkkelen må derfor være sak pluss sesjon.
  id TEXT NOT NULL,
  session TEXT NOT NULL,
  title TEXT, short_title TEXT, reference TEXT, kind TEXT,
  committee TEXT, topics TEXT, updated TEXT,
  PRIMARY KEY (id, session)
);
CREATE INDEX IF NOT EXISTS cases_session ON cases(session);
CREATE INDEX IF NOT EXISTS cases_kind ON cases(kind);

CREATE VIRTUAL TABLE IF NOT EXISTS cases_fts USING fts5(
  case_id UNINDEXED, title, short_title, reference, topics,
  tokenize="unicode61 remove_diacritics 0"
);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  doc_id UNINDEXED, title, short_title, ministry, legal_areas,
  tokenize="unicode61 remove_diacritics 0"
);
`;

export function openDb({ create = false } = {}) {
  const path = dbPath();
  if (create) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { readOnly: !create, allowExtension: false });
  if (create) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);
  }
  return db;
}

export function getMeta(db, key) {
  return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;
}

export function setMeta(db, key, value) {
  db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    String(value),
  );
}

/**
 * FTS5 tolker en del tegn som operatorer. Brukeren skriver naturlig norsk,
 * så vi siterer hvert ord og lar «OR», «NEAR» og frasesøk med " gå igjennom.
 */
/**
 * Bindeord bærer ingen informasjon i et fulltektsøk, men FTS5 krever at ALLE
 * ord finnes. «oppsigelse i prøvetiden» mistet ellers treff bare fordi «i»
 * ikke sto i paragrafen. Fraser i anførselstegn røres ikke.
 */
const STOPPORD = new Set(
  ("i og om på for til av en et den det som er har med ved der når hva hvordan " +
   "kan skal må vil fra eller ikke seg sin sitt de dette disse man må være blir")
    .split(" "),
);

export function toMatchQuery(input) {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const phrases = [];
  const rest = trimmed.replace(/"([^"]+)"/g, (_, p) => {
    phrases.push(`"${p.replace(/"/g, "")}"`);
    return " ";
  });
  const words = rest
    .split(/[^\p{L}\p{N}§*-]+/u)
    .map((w) => w.trim())
    // Tokenizeren indekserer bare bokstaver og tall; «§» alene blir en tom frase.
    .filter((w) => /[\p{L}\p{N}]/u.test(w))
    .map((w) => w.toLowerCase());
  const meaningful = words.filter((w) => !STOPPORD.has(w));
  const chosen = meaningful.length ? meaningful : words;
  const quoted = chosen.map((w) =>
    w.endsWith("*") ? `"${w.slice(0, -1).replace(/"/g, "")}"*` : `"${w.replace(/"/g, "")}"`,
  );
  return [...phrases, ...quoted].join(" ");
}
