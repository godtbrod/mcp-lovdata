import { getMeta, openDb, openLovtidendDb, queryTerms, toMatchQuery, unpackText } from "./db.js";
import { compareArticles, toRefid } from "./lovtidend.js";

/** Lovdatas datofelter kan inneholde fritekst; dette skiller ut ekte ISO-datoer. */
const ISO_DATE = (col) => `${col} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'`;

const TYPE_ORDER = `CASE d.type WHEN 'lov' THEN 0 WHEN 'forskrift' THEN 1
  WHEN 'stortingsvedtak' THEN 2 WHEN 'instruks' THEN 3 ELSE 4 END`;

export class Corpus {
  constructor() {
    this.db = openDb();
  }

  status() {
    const row = (k) => getMeta(this.db, k);
    const types = this.db.prepare("SELECT type, COUNT(*) n FROM documents GROUP BY type ORDER BY n DESC").all();
    return {
      syncedAt: row("synced_at"),
      documents: Number(row("documents") ?? 0),
      articles: Number(row("articles") ?? 0),
      byType: Object.fromEntries(types.map((t) => [t.type, t.n])),
    };
  }

  /**
   * Slå opp et dokument på navn, dokid eller den gamle LOV-/FOR-koden.
   * Navnesøket rangerer et treff i tittelens parentes øverst — det er der
   * kortnavnet står («Lov om arbeidsmiljø … (arbeidsmiljøloven)») — og
   * foretrekker lov framfor delegeringsvedtak med samme ord i tittelen.
   */
  resolve(reference, { limit = 5, type } = {}) {
    const ref = reference.trim();
    const exact = this.db
      .prepare("SELECT * FROM documents WHERE lower(id) = lower(?) OR lower(legacy_id) = lower(?) LIMIT 1")
      .get(ref, ref);
    if (exact) return [exact];

    const match = toMatchQuery(ref);
    if (!match) return [];
    return this.db
      .prepare(
        `SELECT d.* FROM documents_fts f JOIN documents d ON d.id = f.doc_id
         WHERE documents_fts MATCH ?1 ${type ? "AND d.type = ?4" : ""}
         ORDER BY
           CASE WHEN lower(d.title) LIKE '%(' || lower(?2) || ')%' THEN 0 ELSE 1 END,
           ${TYPE_ORDER},
           bm25(documents_fts, 0.0, 2.0, 8.0, 1.0, 1.0)
         LIMIT ?3`,
      )
      .all(...(type ? [match, ref, limit, type] : [match, ref, limit]));
  }

  /** Fulltekstsøk i paragraftekst, eventuelt avgrenset til ett dokument. */
  searchArticles({ query, type, ministry, docId, limit = 10, offset = 0 }) {
    const match = toMatchQuery(query);
    if (!match) return { total: 0, hits: [] };
    const where = ["articles_fts MATCH :match"];
    // node:sqlite avviser navngitte parametre som ikke finnes i spørringen,
    // så tellingen og siden må ha hvert sitt sett.
    const filters = { match };
    if (type) { where.push("d.type = :type"); filters.type = type; }
    if (ministry) { where.push("d.ministry LIKE :ministry"); filters.ministry = `%${ministry}%`; }
    if (docId) { where.push("a.doc_id = :docId"); filters.docId = docId; }
    const clause = where.join(" AND ");
    const params = { ...filters, limit, offset };

    const total = this.db
      .prepare(`SELECT COUNT(*) n FROM articles_fts f JOIN articles a ON a.rowid = f.rowid
                JOIN documents d ON d.id = a.doc_id WHERE ${clause}`)
      .get(filters).n;

    const hits = this.db
      .prepare(
        `SELECT a.doc_id, a.name, a.heading, a.chapter, a.lovdata_url,
                d.title, d.short_title, d.type, d.ministry, d.legacy_id,
                snippet(articles_fts, 3, '«', '»', ' … ', 18) AS snippet
         FROM articles_fts f
         JOIN articles a ON a.rowid = f.rowid
         JOIN documents d ON d.id = a.doc_id
         WHERE ${clause}
         ORDER BY ${TYPE_ORDER}, bm25(articles_fts, 4.0, 2.0, 1.0, 1.0)
         LIMIT :limit OFFSET :offset`,
      )
      .all(params);
    return { total, hits };
  }

  /** Fulltekstsøk bare i dokumenttitler — for «hvilke forskrifter finnes om X». */
  searchTitles({ query, type, limit = 10 }) {
    const match = toMatchQuery(query);
    if (!match) return { total: 0, hits: [] };
    const filter = type ? "AND d.type = :type" : "";
    const filters = type ? { match, type } : { match };
    const params = { ...filters, limit };
    const total = this.db
      .prepare(`SELECT COUNT(*) n FROM documents_fts f JOIN documents d ON d.id = f.doc_id
                WHERE documents_fts MATCH :match ${filter}`)
      .get(filters).n;
    const hits = this.db
      .prepare(
        `SELECT d.id AS doc_id, d.title, d.short_title, d.type, d.ministry, d.legacy_id,
                d.date_in_force, d.article_count
         FROM documents_fts f JOIN documents d ON d.id = f.doc_id
         WHERE documents_fts MATCH :match ${filter}
         ORDER BY ${TYPE_ORDER}, bm25(documents_fts, 0.0, 2.0, 8.0, 1.0, 1.0)
         LIMIT :limit`,
      )
      .all(params);
    return { total, hits };
  }

  document(docId) {
    return this.db.prepare("SELECT * FROM documents WHERE id = ?").get(docId);
  }

  /** Oppslag på den gamle koden («LOV-2005-06-17-62») — det Lovtidend lenker med. */
  byLegacy(code) {
    return code ? this.db.prepare("SELECT * FROM documents WHERE legacy_id = ? LIMIT 1").get(code) : undefined;
  }

  articles(docId) {
    return this.db
      .prepare("SELECT ordinal, name, heading, chapter, lovdata_url, length(text) AS len FROM articles WHERE doc_id = ? ORDER BY ordinal")
      .all(docId);
  }

  /** Én paragraf. Navnet skrives «§ 14-9» eller «§14-9» — begge skal treffe. */
  article(docId, name) {
    const wanted = name.replace(/\s+/g, "").toLowerCase();
    return this.db
      .prepare(
        `SELECT * FROM articles WHERE doc_id = ?
         AND lower(replace(replace(name, ' ', ''), '.', '')) = ?`,
      )
      .get(docId, wanted.replace(/\./g, "")) ??
      this.db.prepare("SELECT * FROM articles WHERE doc_id = ? AND lower(name) LIKE ? ORDER BY ordinal LIMIT 1")
        .get(docId, `%${wanted}%`);
  }

  fullText(docId, maxChars) {
    const rows = this.db.prepare("SELECT name, heading, chapter, text FROM articles WHERE doc_id = ? ORDER BY ordinal").all(docId);
    let out = "";
    let chapter = null;
    let truncatedAt = null;
    for (const r of rows) {
      if (r.chapter && r.chapter !== chapter) {
        chapter = r.chapter;
        out += `\n\n## ${chapter}\n`;
      }
      out += `\n${r.name}${r.heading && r.heading !== r.name ? ` ${r.heading}` : ""}\n${r.text}\n`;
      if (maxChars && out.length > maxChars) { truncatedAt = r.name; break; }
    }
    return { text: out.trim(), truncatedAt };
  }

  ministries(type) {
    return this.db
      .prepare(`SELECT ministry, COUNT(*) n FROM documents
                WHERE ministry IS NOT NULL ${type ? "AND type = ?" : ""}
                GROUP BY ministry ORDER BY n DESC LIMIT 40`)
      .all(...(type ? [type] : []));
  }

  list({ type, ministry, since, limit = 20, offset = 0 }) {
    const where = [];
    const filters = {};
    if (type) { where.push("type = :type"); filters.type = type; }
    if (ministry) { where.push("ministry LIKE :ministry"); filters.ministry = `%${ministry}%`; }
    // Datofeltene er fritekst hos Lovdata: «Kongen fastset», «Når overenskomsten
    // trer i kraft». Bare verdier som faktisk ser ut som en ISO-dato kan sammenlignes.
    if (since) {
      where.push(
        `((${ISO_DATE("date_in_force")} AND date_in_force >= :since)
          OR (${ISO_DATE("last_change_in_force")} AND last_change_in_force >= :since))`,
      );
      filters.since = since;
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const params = { ...filters, limit, offset };
    const total = this.db.prepare(`SELECT COUNT(*) n FROM documents ${clause}`).get(filters).n;
    const rows = this.db
      .prepare(
        `SELECT id AS doc_id, title, short_title, type, ministry, legacy_id,
                date_in_force, last_change_in_force, article_count
         FROM documents ${clause}
         ORDER BY COALESCE(
                    CASE WHEN ${ISO_DATE("last_change_in_force")} THEN last_change_in_force END,
                    CASE WHEN ${ISO_DATE("date_in_force")} THEN date_in_force END,
                    ''
                  ) DESC, id
         LIMIT :limit OFFSET :offset`,
      )
      .all(params);
    return { total, rows };
  }

  /** Fritekstsøk i stortingssakene — altså i forarbeidene. */
  searchCases({ query, kind, session, limit = 10, offset = 0 }) {
    const match = toMatchQuery(query);
    if (!match) return { total: 0, hits: [] };
    const where = ["1=1"];
    const filters = { match };
    if (kind) { where.push("c.kind = :kind"); filters.kind = kind; }
    if (session) { where.push("c.session = :session"); filters.session = session; }
    const clause = where.join(" AND ");
    const params = { ...filters, limit, offset };
    // bm25() kan ikke evalueres sammen med GROUP BY, og SQLite flater ut en vanlig
    // subspørring slik at feilen kommer likevel. MATERIALIZED tvinger den til å
    // regne ut rangeringen først, før sakene slås sammen på tvers av sesjoner.
    const cte = `WITH ranked AS MATERIALIZED (
                   SELECT case_id, bm25(cases_fts, 0.0, 2.0, 2.0, 4.0, 1.0) AS rank
                   FROM cases_fts WHERE cases_fts MATCH :match
                 )`;
    const join = `FROM ranked f JOIN cases c ON c.id = f.case_id WHERE ${clause}`;
    const total = this.db.prepare(`${cte} SELECT COUNT(DISTINCT c.id) n ${join}`).get(filters).n;
    const hits = this.db
      .prepare(
        `${cte}
         SELECT c.id, MAX(c.session) AS session, c.title, c.short_title, c.reference,
                c.kind, c.committee, c.topics, c.updated, MIN(f.rank) AS rank
         ${join}
         GROUP BY c.id
         ORDER BY session DESC, rank
         LIMIT :limit OFFSET :offset`,
      )
      .all(params);
    return { total, hits };
  }

  caseKinds() {
    return this.db
      .prepare("SELECT kind, COUNT(*) n FROM cases WHERE kind IS NOT NULL GROUP BY kind ORDER BY n DESC")
      .all();
  }

  casesStatus() {
    const row = this.db.prepare("SELECT COUNT(*) n, MIN(session) a, MAX(session) b FROM cases").get();
    return { cases: row.n, fraSesjon: row.a, tilSesjon: row.b };
  }

  close() {
    this.db.close();
  }
}

// ------------------------------------------------------------- Lovtidend

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Utdrag med søkeordene markert. FTS5-tabellen for Lovtidend er contentless
 * (teksten ligger komprimert i gazette), og da gir snippet() bare null.
 *
 * Vinduet legges der flest forskjellige søkeord står nær hverandre — i en
 * kunngjøring på 40 000 tegn er det forskjellen på å se selve endringen og å
 * se innledningen.
 */
export function makeSnippet(text, terms, { width = 260 } = {}) {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  const short = (from) =>
    (from > 0 ? "… " : "") + clean.slice(from, from + width).trim() + (from + width < clean.length ? " …" : "");
  if (!terms.length || !clean) return short(0);

  const hits = [];
  terms.forEach((t, i) => {
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRe(t.word)}${t.prefix ? "[\\p{L}\\p{N}]*" : ""}(?![\\p{L}\\p{N}])`,
      "giu",
    );
    let m;
    let n = 0;
    while ((m = re.exec(clean)) && n++ < 50) hits.push({ term: i, start: m.index, end: m.index + m[0].length });
  });
  if (!hits.length) return short(0);
  hits.sort((a, b) => a.start - b.start);

  let best = { score: -1, from: 0 };
  for (const [i, hit] of hits.entries()) {
    const seen = new Set();
    for (let j = i; j < hits.length && hits[j].end <= hit.start + width; j++) seen.add(hits[j].term);
    if (seen.size > best.score) best = { score: seen.size, from: Math.max(0, hit.start - 40) };
  }

  const to = Math.min(clean.length, best.from + width);
  let out = "";
  let at = best.from;
  for (const hit of hits) {
    if (hit.start < at || hit.end > to) continue;
    out += `${clean.slice(at, hit.start)}«${clean.slice(hit.start, hit.end)}»`;
    at = hit.end;
  }
  out += clean.slice(at, to);
  return (best.from > 0 ? "… " : "") + out.trim() + (to < clean.length ? " …" : "");
}

const LTI_ORDER = "CASE g.type WHEN 'lov' THEN 0 ELSE 1 END";

/** Norsk Lovtidend avd. I — kunngjøringene. Egen fil, se lovtidendPath. */
export class Lovtidend {
  constructor() {
    this.db = openLovtidendDb();
  }

  status() {
    const row = this.db.prepare("SELECT COUNT(*) n, MIN(year) a, MAX(year) b FROM gazette").get();
    const types = this.db.prepare("SELECT type, COUNT(*) n FROM gazette GROUP BY type ORDER BY n DESC").all();
    return {
      syncedAt: getMeta(this.db, "synced_at"),
      count: row.n,
      years: row.n ? `${row.a}–${row.b}` : undefined,
      history: getMeta(this.db, "history") === "1",
      byType: Object.fromEntries(types.map((t) => [t.type, t.n])),
    };
  }

  /**
   * Søk i kunngjøringene. Uten `query` er det en ren liste, sortert med de
   * sist kunngjorte først; med `query` sorteres det etter relevans.
   */
  search({ query, type, ministry, endrer, article, hjemmel, from, to, inForceFrom, inForceTo, limit = 10, offset = 0 }) {
    const where = [];
    const filters = {};
    let fts = "";
    if (query) {
      const match = toMatchQuery(query);
      if (!match) return { total: 0, hits: [] };
      fts = "JOIN gazette_fts f ON f.rowid = g.rowid";
      where.push("gazette_fts MATCH :match");
      filters.match = match;
    }
    if (type) { where.push("g.type = :type"); filters.type = type; }
    if (ministry) { where.push("(g.ministry LIKE :ministry OR g.agency LIKE :ministry)"); filters.ministry = `%${ministry}%`; }
    if (from) { where.push("g.published_date >= :from"); filters.from = from; }
    if (to) { where.push("g.published_date <= :to"); filters.to = to; }
    if (inForceFrom) { where.push("g.in_force_date >= :inForceFrom"); filters.inForceFrom = inForceFrom; }
    if (inForceTo) { where.push("g.in_force_date <= :inForceTo"); filters.inForceTo = inForceTo; }
    // IN, ikke EXISTS: med EXISTS leste planleggeren seg gjennom alle
    // kunngjøringene og slo opp lenkene for hver. IN slår opp lenkene først.
    if (endrer) {
      where.push(`g.rowid IN (SELECT l.gazette FROM gazette_links l
                  WHERE l.kind = 'endrer' AND l.target = :endrer${article ? " AND l.article = :article" : ""})`);
      filters.endrer = endrer;
      if (article) filters.article = article;
    }
    if (hjemmel) {
      where.push("g.rowid IN (SELECT l.gazette FROM gazette_links l WHERE l.kind = 'hjemmel' AND l.target = :hjemmel)");
      filters.hjemmel = hjemmel;
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = this.db.prepare(`SELECT COUNT(*) n FROM gazette g ${fts} ${clause}`).get(filters).n;
    const order = query
      ? `${LTI_ORDER}, bm25(gazette_fts, 8.0, 4.0, 2.0, 1.0)`
      : "g.published_date DESC, g.id DESC";
    const rows = this.db
      .prepare(`SELECT g.rowid, g.id, g.refid, g.legacy_id, g.type, g.year, g.title, g.short_title,
                       g.ministry, g.agency, g.published, g.published_date, g.in_force, g.in_force_date, g.misc
                FROM gazette g ${fts} ${clause} ORDER BY ${order} LIMIT :limit OFFSET :offset`)
      .all({ ...filters, limit, offset });
    const terms = query ? queryTerms(query) : [];
    const hits = rows.map((r) => ({
      ...r,
      // Uten søkeord er det ingenting å markere, og teksten trenger ikke pakkes ut.
      snippet: terms.length ? makeSnippet(this.text(r.rowid), terms) : undefined,
      changes: this.links(r.rowid, "endrer"),
    }));
    return { total, hits };
  }

  /** De vanligste departementsnavnene — til hjelp når et filter ikke traff. */
  ministries(limit = 12) {
    return this.db
      .prepare("SELECT ministry, COUNT(*) n FROM gazette WHERE ministry IS NOT NULL GROUP BY ministry ORDER BY n DESC LIMIT ?")
      .all(limit)
      .map((r) => r.ministry);
  }

  text(rowid) {
    return unpackText(this.db.prepare("SELECT text FROM gazette_text WHERE gazette = ?").get(rowid)?.text);
  }

  /**
   * Sorteringen gjøres i JS med vilje: med ORDER BY i spørringen valgte
   * planleggeren indeksen på (kind, target) for å slippe å sortere, og leste
   * seg gjennom alle 150 000 endringslenkene i stedet for de ti på denne raden.
   */
  links(rowid, kind) {
    return this.db
      .prepare("SELECT target, article FROM gazette_links WHERE gazette = ? AND kind = ?")
      .all(rowid, kind)
      .sort((a, b) => a.target.localeCompare(b.target) || compareArticles(a.article, b.article));
  }

  /**
   * Slå opp én kunngjøring på dokid, LOV-/FOR-kode eller refid. Formene
   * normaliseres først; lower() i spørringen ville gjort indeksene ubrukelige.
   */
  get(reference) {
    const ref = reference.trim();
    const refid = toRefid(ref) ?? ref.toLowerCase();
    const row = this.db
      .prepare("SELECT * FROM gazette WHERE id = :id OR legacy_id = :legacy OR refid = :refid LIMIT 1")
      .get({ id: `LTI/${refid}`, legacy: ref.toUpperCase(), refid });
    if (!row) return undefined;
    return {
      ...row,
      text: this.text(row.rowid),
      changes: this.links(row.rowid, "endrer"),
      basedOn: this.links(row.rowid, "hjemmel"),
      inForceBy: this.inForceBy(row.refid),
    };
  }

  /**
   * Endringslover står ofte med «Kongen bestemmer» som ikrafttredelse. Datoen
   * kommer siden i en egen kunngjøring — en kgl.res. med loven som hjemmel.
   */
  inForceBy(refid) {
    if (!refid) return [];
    return this.db
      .prepare(`SELECT g.id, g.legacy_id, g.title, g.in_force, g.in_force_date, g.published_date
                FROM gazette g JOIN gazette_links l ON l.gazette = g.rowid
                WHERE l.kind = 'hjemmel' AND l.target = ? AND g.title LIKE 'Ikraftsetting%'
                ORDER BY g.published_date`)
      .all(refid);
  }

  /** Alle kunngjøringer som endrer dette dokumentet, eldst først. */
  changesTo({ target, article, limit = 50, offset = 0 }) {
    const filters = { target, limit, offset };
    const clause = article ? "AND l.article = :article" : "";
    if (article) filters.article = article;
    const total = this.db
      .prepare(`SELECT COUNT(DISTINCT l.gazette) n FROM gazette_links l
                WHERE l.kind = 'endrer' AND l.target = :target ${clause}`)
      .get(article ? { target, article } : { target }).n;
    const rows = this.db
      .prepare(`SELECT DISTINCT g.rowid, g.id, g.legacy_id, g.title, g.short_title, g.type,
                       g.published_date, g.in_force, g.in_force_date, g.ministry
                FROM gazette_links l JOIN gazette g ON g.rowid = l.gazette
                WHERE l.kind = 'endrer' AND l.target = :target ${clause}
                ORDER BY g.published_date DESC LIMIT :limit OFFSET :offset`)
      .all(filters);
    return { total, rows };
  }

  close() {
    this.db.close();
  }
}
