import { openDb, getMeta, toMatchQuery } from "./db.js";

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
