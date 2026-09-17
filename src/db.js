import { DatabaseSync } from "node:sqlite";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { existsSync, mkdirSync } from "node:fs";
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
  return open(dbPath(), SCHEMA, create);
}

function open(path, schema, create) {
  if (create) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { readOnly: !create, allowExtension: false });
  if (create) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(schema);
  }
  return db;
}

/**
 * Lovtidend ligger i en egen fil ved siden av lovindeksen. Historikken er
 * flere hundre MB, og lovsynken avslutter med VACUUM — som skriver hele fila
 * på nytt. Med Lovtidend i samme fil ville hver lovsync blitt tregere, og en
 * Lovtidend-sync som feiler kan aldri skade lovindeksen når den ikke rører fila.
 */
export function lovtidendPath() {
  return process.env.LOVTIDEND_DB || join(dirname(dbPath()), "lovtidend.db");
}

const LOVTIDEND_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

-- Én rad per kunngjøring. year er årgangen i arkivet (lti/2024/…), og det er
-- den en ny datapakke erstatter.
CREATE TABLE IF NOT EXISTS gazette (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE, refid TEXT, legacy_id TEXT, type TEXT, year INTEGER,
  title TEXT, short_title TEXT, ministry TEXT, agency TEXT,
  published TEXT, published_date TEXT, in_force TEXT, in_force_date TEXT,
  journal_number TEXT, misc TEXT, legal_areas TEXT
);
CREATE INDEX IF NOT EXISTS gazette_year ON gazette(year);
CREATE INDEX IF NOT EXISTS gazette_published ON gazette(published_date);
CREATE INDEX IF NOT EXISTS gazette_refid ON gazette(refid);
CREATE INDEX IF NOT EXISTS gazette_legacy ON gazette(legacy_id);

-- Teksten deflate-komprimert, i sin egen tabell. Alle årgangene er 260 MB som
-- klartekst og 86 MB slik — på en kontormaskin er det forskjellen på en halv
-- gigabyte og ikke. At den ligger utenfor gazette gjør at et filtrert søk kan
-- lese gjennom kunngjøringene uten å dra med seg teksten i dem.
CREATE TABLE IF NOT EXISTS gazette_text (gazette INTEGER PRIMARY KEY, text BLOB);

-- Hva kunngjøringen endrer (kind 'endrer') og hjemler den bygger på ('hjemmel').
-- article er null for dokumentet som helhet, ellers «§15-6».
CREATE TABLE IF NOT EXISTS gazette_links (
  gazette INTEGER NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, article TEXT
);
CREATE INDEX IF NOT EXISTS gazette_links_target ON gazette_links(kind, target, article);
CREATE INDEX IF NOT EXISTS gazette_links_gazette ON gazette_links(gazette);

-- content='' lagrer bare søkeindeksen, ikke teksten en gang til — den ligger
-- komprimert i gazette. contentless_delete lar en årgang slettes med DELETE.
-- Prisen er at snippet() ikke virker; utdragene lages i stedet av makeSnippet.
CREATE VIRTUAL TABLE IF NOT EXISTS gazette_fts USING fts5(
  title, short_title, misc, text,
  content='', contentless_delete=1,
  tokenize="unicode61 remove_diacritics 0"
);
`;

export function openLovtidendDb({ create = false } = {}) {
  return open(lovtidendPath(), LOVTIDEND_SCHEMA, create);
}

/** Som indexProblem, for Lovtidend. Null når minst én årgang er hentet. */
export function lovtidendProblem() {
  const path = lovtidendPath();
  if (!existsSync(path)) return "Lovtidend er ikke hentet ennå.";
  let db;
  try {
    db = openLovtidendDb();
    return getMeta(db, "synced_at") ? null : "Lovtidend ble aldri ferdig hentet — en sync stoppet underveis.";
  } catch (err) {
    return `Lovtidend-indeksen i ${path} kan ikke leses: ${err.message}`;
  } finally {
    db?.close();
  }
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
 * Hvorfor lovindeksen ikke kan brukes, eller null når den kan det.
 *
 * At fila finnes er ikke nok. sync oppretter den med skjema før noe er lastet
 * ned, så en første sync som feiler underveis etterlater tomme tabeller — og
 * da svarte search «0 treff» og get_article «fant ingen dokumenter» for
 * arbeidsmiljøloven, uten et ord om at indeksen var tom. synced_at skrives i
 * samme transaksjon som lovtekstene, rett før COMMIT, så den finnes bare når
 * indeksen ble ferdig. En senere sync som feiler, ruller tilbake til forrige.
 */
export function indexProblem() {
  const path = dbPath();
  if (!existsSync(path)) return `Ingen lokal indeks i ${path}.`;
  let db;
  try {
    db = openDb();
    return getMeta(db, "synced_at") ? null : `Indeksen i ${path} ble aldri ferdig bygget — en sync stoppet underveis.`;
  } catch (err) {
    return `Indeksen i ${path} kan ikke leses: ${err.message}`;
  } finally {
    db?.close();
  }
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

/**
 * Norsk bøyer i endelsen, og unicode61 har ingen stemming: «oppsigelse» og
 * «oppsigelsen» er to ulike tokens. Søket «oppsigelse prøvetid» mistet derfor
 * aml § 15-6 helt, fordi paragrafen skriver bestemt form. Hvert ord søkes
 * som prefiks i stedet — men bare fra fire tegn, ellers ville «bil» dratt inn
 * «bilag» og «lov» alt som er lovlig. Vil du ha eksakt form, sett ordet i
 * anførselstegn: det går rett i frasegrenen og røres ikke.
 */
const MIN_PREFIKS = 4;

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
  const quoted = chosen.map((w) => {
    if (w.endsWith("*")) return `"${w.slice(0, -1).replace(/"/g, "")}"*`;
    const bare = w.replace(/"/g, "");
    return bare.length >= MIN_PREFIKS ? `"${bare}"*` : `"${bare}"`;
  });
  return [...phrases, ...quoted].join(" ");
}

/**
 * Ordene søket faktisk leter etter, lest ut av MATCH-uttrykket — da er de
 * alltid de samme som FTS5 brukte. Brukes til å markere treffene i utdrag der
 * snippet() ikke kan brukes, altså i Lovtidend.
 */
export function queryTerms(input) {
  const out = [];
  for (const m of toMatchQuery(input).matchAll(/"([^"]*)"(\*)?/g)) {
    const words = m[1].split(/\s+/).filter(Boolean);
    // Stjerna gjelder bare det siste ordet i en frase.
    words.forEach((word, i) => out.push({ word, prefix: Boolean(m[2]) && i === words.length - 1 }));
  }
  return out;
}

/** Lovtidend-teksten lagres komprimert; se skjemaet. */
export function packText(text) {
  return deflateRawSync(Buffer.from(text ?? "", "utf8"), { level: 6 });
}

export function unpackText(blob) {
  if (blob == null) return "";
  return typeof blob === "string" ? blob : inflateRawSync(blob).toString("utf8");
}
