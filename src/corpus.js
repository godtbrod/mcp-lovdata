import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { getMeta, openDb, openLovtidendDb, packText, setMeta } from "./db.js";
import { fetchCases, fetchSessions } from "./stortinget.js";
import { parseDocument } from "./parse.js";
import { parseGazette } from "./lovtidend.js";

const run = promisify(execFile);

/**
 * Windows har bsdtar i System32 og forstår C:\-stier. Git Bash sin GNU tar
 * ligger ofte først i PATH og tolker «C:» som et vertsnavn for fjernarkiv.
 * Derfor full sti på win32.
 */
const TAR =
  process.platform === "win32"
    ? join(process.env.SystemRoot || "C:/Windows", "System32", "tar.exe")
    : "tar";

export const DATASETS = [
  { key: "lover", name: "Gjeldende lover", url: "https://api.lovdata.no/v1/publicData/get/gjeldende-lover.tar.bz2" },
  {
    key: "forskrifter",
    name: "Gjeldende sentrale forskrifter",
    url: "https://api.lovdata.no/v1/publicData/get/gjeldende-sentrale-forskrifter.tar.bz2",
  },
];

/**
 * Arkivene pakkes ut i tmpdir, ikke i hjemmemappa. Maskinen har en mekanisk
 * SMR-disk der tusenvis av små filer er det dyreste man kan gjøre; /tmp er
 * tmpfs, og indeksen som blir igjen er én enkelt fil.
 */
export async function sync({ log = () => {}, datasets = DATASETS } = {}) {
  const work = await mkdtemp(join(tmpdir(), "lovdata-"));
  const db = openDb({ create: true });
  const started = Date.now();
  try {
    db.exec("BEGIN");
    db.exec("DELETE FROM articles_fts");
    db.exec("DELETE FROM documents_fts");
    db.exec("DELETE FROM articles");
    db.exec("DELETE FROM documents");

    const insDoc = db.prepare(`INSERT OR REPLACE INTO documents
      (id, type, legacy_id, title, short_title, ministry, legal_areas, date_in_force,
       last_change_in_force, last_changed_by, last_updated, published_in, applies_to,
       based_on, language, source_file, url, article_count)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insDocFts = db.prepare(
      "INSERT INTO documents_fts(doc_id, title, short_title, ministry, legal_areas) VALUES (?,?,?,?,?)",
    );
    const insArt = db.prepare(`INSERT INTO articles
      (doc_id, ordinal, name, heading, chapter, text, changes, lovdata_url)
      VALUES (?,?,?,?,?,?,?,?)`);
    const insArtFts = db.prepare(
      "INSERT INTO articles_fts(rowid, name, heading, chapter, text) VALUES (?,?,?,?,?)",
    );

    let documents = 0;
    let articles = 0;
    let skipped = 0;

    for (const ds of datasets) {
      const archive = join(work, `${ds.key}.tar.bz2`);
      log(`laster ned ${ds.name} …`);
      const res = await fetch(ds.url, { headers: { "User-Agent": "mcp-lovdata" } });
      if (!res.ok) throw new Error(`${ds.url}: HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(archive));
      const bytes = (await stat(archive)).size;

      const dir = join(work, ds.key);
      await mkdir(dir, { recursive: true });
      log(`pakker ut ${(bytes / 1e6).toFixed(1)} MB …`);
      await run(TAR, ["xjf", archive, "-C", dir], { maxBuffer: 1 << 24 });
      await rm(archive);

      for (const file of await listXml(dir)) {
        let doc;
        try {
          doc = parseDocument(await readFile(file, "utf8"), file);
        } catch {
          skipped++;
          continue;
        }
        if (!doc.id) {
          skipped++;
          continue;
        }
        insDoc.run(
          doc.id, doc.type, doc.legacyId ?? null, doc.title ?? null, doc.shortTitle ?? null,
          doc.ministry ?? null, doc.legalAreas ?? null, doc.dateInForce ?? null,
          doc.lastChangeInForce ?? null, doc.lastChangedBy ?? null, doc.lastUpdated ?? null,
          doc.publishedIn ?? null, doc.appliesTo ?? null, doc.basedOn.join(" ") || null,
          doc.language, doc.sourceFile, doc.url ?? null, doc.articles.length,
        );
        insDocFts.run(doc.id, doc.title ?? "", doc.shortTitle ?? "", doc.ministry ?? "", doc.legalAreas ?? "");
        doc.articles.forEach((a, i) => {
          const { lastInsertRowid } = insArt.run(
            doc.id, i, a.name, a.heading ?? null, a.chapter ?? null, a.text, a.changes ?? null, a.lovdataUrl ?? null,
          );
          insArtFts.run(lastInsertRowid, a.name, a.heading ?? "", a.chapter ?? "", a.text);
        });
        documents++;
        articles += doc.articles.length;
        if (documents % 500 === 0) log(`  ${documents} dokumenter …`);
      }
      await rm(dir, { recursive: true, force: true });
    }

    setMeta(db, "synced_at", new Date().toISOString());
    setMeta(db, "documents", documents);
    setMeta(db, "articles", articles);
    db.exec("COMMIT");
    log("optimaliserer indeksen …");
    db.exec("INSERT INTO articles_fts(articles_fts) VALUES('optimize')");
    db.exec("VACUUM");
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    log(`ferdig: ${documents} dokumenter, ${articles} paragrafer på ${seconds} s`);
    return { documents, articles, skipped, seconds: Number(seconds) };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* transaksjonen var ikke åpen */ }
    throw err;
  } finally {
    db.close();
    await rm(work, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------- Lovtidend

const PUBLIC_DATA = "https://api.lovdata.no/v1/publicData";

/**
 * Lovtidend-pakkene i Lovdatas liste. Filnavnene endrer seg ved årsskiftet —
 * «lovtidend-avd1-2026» blir en del av «lovtidend-avd1-2001-2026», og en ny
 * «lovtidend-avd1-2027» dukker opp — så de leses fra lista, ikke hardkodes.
 */
export function lovtidendPackages(list) {
  return list
    .map((p) => {
      const m = /^lovtidend-avd1-(\d{4})(?:-(\d{4}))?\.tar\.bz2$/.exec(p.filename ?? "");
      if (!m) return undefined;
      return {
        filename: p.filename,
        from: Number(m[1]),
        to: Number(m[2] ?? m[1]),
        history: Boolean(m[2]),
        lastModified: p.lastModified,
        bytes: Number(p.sizeBytes) || undefined,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.from - b.from);
}

/**
 * Leser en ukomprimert tar-strøm og gir filene én og én, uten å skrive noe
 * til disk. Historikken er 38 000 filer og nesten 700 MB utpakket; å legge dem
 * på disk og lese dem inn igjen tok dobbelt så lang tid på Windows.
 */
export async function* tarEntries(stream) {
  const chunks = [];
  let have = 0;
  const take = (n) => {
    const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, have);
    chunks.length = 0;
    const out = all.subarray(0, n);
    if (all.length > n) chunks.push(all.subarray(n));
    have -= n;
    return out;
  };
  const cstr = (buf, start, len) => {
    const end = buf.indexOf(0, start);
    return buf.toString("utf8", start, end === -1 || end > start + len ? start + len : end);
  };
  let longName;
  let need = 512;
  let header;
  for await (const chunk of stream) {
    chunks.push(chunk);
    have += chunk.length;
    while (have >= need) {
      if (!header) {
        header = take(512);
        if (header.every((b) => b === 0)) {
          header = undefined;
          continue;
        }
        const size = parseInt(cstr(header, 124, 12).trim() || "0", 8);
        header = { block: header, size };
        need = Math.ceil(size / 512) * 512;
        continue;
      }
      const { block, size } = header;
      const body = take(need).subarray(0, size);
      header = undefined;
      need = 512;
      const type = String.fromCharCode(block[156]);
      if (type === "L") {
        longName = cstr(body, 0, body.length);
      } else if (type === "x") {
        // pax-hode: «30 path=lti/2026/…\n». bsdtar skriver det bare ved behov.
        longName = /(?:^|\n)\d+ path=([^\n]*)/.exec(body.toString("utf8"))?.[1] ?? longName;
      } else if (type === "0" || type === "\0") {
        const prefix = cstr(block, 345, 155);
        const name = longName ?? (prefix ? `${prefix}/${cstr(block, 0, 100)}` : cstr(block, 0, 100));
        longName = undefined;
        yield { name, data: body };
      } else {
        longName = undefined;
      }
    }
  }
}

/**
 * Tar-strømmen ut av et .tar.bz2-arkiv. Windows har ingen bzip2, men bsdtar
 * kan skrive arkivet om til ukomprimert tar på stdout («@arkiv»). Andre
 * steder er bzip2 alltid til stede — GNU tar bruker den selv til xjf.
 */
function decompress(archive) {
  const child =
    process.platform === "win32"
      ? spawn(TAR, ["-cf", "-", `@${archive}`], { stdio: ["ignore", "pipe", "pipe"] })
      : spawn("bzip2", ["-dc", archive], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`utpakking feilet (kode ${code}): ${stderr.trim().slice(0, 300)}`)),
    );
  });
  // Uten en fangst her blir en feil før noen venter på den en uhåndtert rejection.
  exited.catch(() => {});
  return { stream: child.stdout, exited, kill: () => child.kill() };
}

/**
 * Skriving til Lovtidend-indeksen, samlet ett sted: én kunngjøring inn, og
 * sletting av det en ny datapakke erstatter. Testene bruker den samme veien
 * inn i indeksen som synken gjør.
 */
export function gazetteWriter(db) {
  const insDoc = db.prepare(`INSERT INTO gazette
    (id, refid, legacy_id, type, year, title, short_title, ministry, agency, published,
     published_date, in_force, in_force_date, journal_number, misc, legal_areas)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insText = db.prepare("INSERT INTO gazette_text(gazette, text) VALUES (?,?)");
  const insFts = db.prepare("INSERT INTO gazette_fts(rowid, title, short_title, misc, text) VALUES (?,?,?,?,?)");
  const insLink = db.prepare("INSERT INTO gazette_links(gazette, kind, target, article) VALUES (?,?,?,?)");
  const existing = db.prepare("SELECT rowid FROM gazette WHERE id = ?");

  const drop = (where, ...args) => {
    for (const sql of [
      `DELETE FROM gazette_fts WHERE rowid IN (SELECT rowid FROM gazette WHERE ${where})`,
      `DELETE FROM gazette_text WHERE gazette IN (SELECT rowid FROM gazette WHERE ${where})`,
      `DELETE FROM gazette_links WHERE gazette IN (SELECT rowid FROM gazette WHERE ${where})`,
      `DELETE FROM gazette WHERE ${where}`,
    ]) db.prepare(sql).run(...args);
  };

  const add = (doc, year) => {
    // Samme kunngjøring to ganger i én pakke ville ellers brutt på id.
    if (existing.get(doc.id)) drop("id = ?", doc.id);
    const { lastInsertRowid: row } = insDoc.run(
      doc.id, doc.refid ?? null, doc.legacyId ?? null, doc.type ?? null, year ?? null,
      doc.title ?? null, doc.shortTitle ?? null, doc.ministry ?? null, doc.agency ?? null,
      doc.published ?? null, doc.publishedDate ?? null, doc.inForce ?? null, doc.inForceDate ?? null,
      doc.journalNumber ?? null, doc.misc ?? null, doc.legalAreas ?? null,
    );
    insText.run(row, packText(doc.text ?? ""));
    insFts.run(row, doc.title ?? "", doc.shortTitle ?? "", doc.misc ?? "", doc.text ?? "");
    for (const p of doc.parts ?? []) insLink.run(row, "endrer", p.target, p.article);
    for (const ref of doc.basedOn ?? []) {
      const m = ref.match(/^((?:lov|forskrift)\/[^/]+)(?:\/(§[^/]+))?/);
      if (m) insLink.run(row, "hjemmel", m[1], m[2] ?? null);
    }
    return row;
  };

  return { add, drop };
}

/**
 * Norsk Lovtidend avd. I. Hver pakke erstatter årgangene den dekker, i én
 * transaksjon, og hoppes over når Lovdata ikke har endret den siden sist.
 *
 * `history`: true henter også 2001–(i fjor), false aldri. Uten verdi friskes
 * historikken opp bare hvis den er hentet før — den som har valgt den, beholder
 * den oppdatert, uten at alle andre må laste ned 70 MB.
 */
export async function syncLovtidend({ log = () => {}, history, force = false } = {}) {
  const started = Date.now();
  const res = await fetch(`${PUBLIC_DATA}/list`, { headers: { "User-Agent": "mcp-lovdata" } });
  if (!res.ok) throw new Error(`${PUBLIC_DATA}/list: HTTP ${res.status}`);
  const packages = lovtidendPackages(await res.json());
  if (!packages.length) throw new Error("Fant ingen Lovtidend-pakker i Lovdatas liste.");

  const db = openLovtidendDb({ create: true });
  const work = await mkdtemp(join(tmpdir(), "lovtidend-"));
  const result = { hentet: [], uendret: [] };
  try {
    const wantHistory = history ?? getMeta(db, "history") === "1";
    const chosen = packages.filter((p) => !p.history || wantHistory);

    const { add, drop } = gazetteWriter(db);

    for (const pkg of chosen) {
      const key = `package:${pkg.filename}`;
      if (!force && getMeta(db, key) === pkg.lastModified) {
        log(`Lovtidend ${pkg.from}${pkg.history ? `–${pkg.to}` : ""}: uendret siden sist`);
        result.uendret.push(pkg.filename);
        continue;
      }
      const archive = join(work, pkg.filename);
      log(`laster ned Lovtidend ${pkg.from}${pkg.history ? `–${pkg.to}` : ""} …`);
      const dl = await fetch(`${PUBLIC_DATA}/get/${pkg.filename}`, { headers: { "User-Agent": "mcp-lovdata" } });
      if (!dl.ok) throw new Error(`${pkg.filename}: HTTP ${dl.status}`);
      await pipeline(Readable.fromWeb(dl.body), createWriteStream(archive));
      log(`leser ${((await stat(archive)).size / 1e6).toFixed(1)} MB …`);

      const tar = decompress(archive);
      let documents = 0;
      let skipped = 0;
      db.exec("BEGIN");
      try {
        drop("year BETWEEN ? AND ?", pkg.from, pkg.to);
        for await (const { name, data } of tarEntries(tar.stream)) {
          if (!name.endsWith(".xml")) continue;
          let doc;
          try {
            doc = parseGazette(data.toString("utf8"));
          } catch {
            skipped++;
            continue;
          }
          if (!doc.id) {
            skipped++;
            continue;
          }
          // Årgangen er mappa i arkivet; det er den neste pakke erstatter.
          add(doc, Number(name.match(/(?:^|\/)(\d{4})\//)?.[1]) || doc.year);
          documents++;
          if (documents % 5000 === 0) log(`  ${documents} kunngjøringer …`);
        }
        await tar.exited;
        setMeta(db, key, pkg.lastModified);
        if (pkg.history) setMeta(db, "history", "1");
        setMeta(db, "synced_at", new Date().toISOString());
        db.exec("COMMIT");
      } catch (err) {
        tar.kill();
        try { db.exec("ROLLBACK"); } catch { /* transaksjonen var ikke åpen */ }
        throw err;
      }
      await rm(archive, { force: true });
      log(`  ${documents} kunngjøringer fra ${pkg.from}${pkg.history ? `–${pkg.to}` : ""}`);
      result.hentet.push({ pakke: pkg.filename, kunngjøringer: documents, hoppetOver: skipped || undefined });
    }

    // Også når alt var uendret: indeksen ER ajour, og det er det alderen sier noe om.
    setMeta(db, "synced_at", new Date().toISOString());
    if (result.hentet.length) {
      db.exec("INSERT INTO gazette_fts(gazette_fts) VALUES('optimize')");
      // Uten statistikk gjettet planleggeren feil og leste seg gjennom hele
      // lenketabellen på oppslag som skulle tatt mikrosekunder.
      db.exec("ANALYZE");
      // WAL-fila vokser til størrelsen på det som ble skrevet og blir liggende
      // til noen sjekkpunkter den. Det gjør vi med en gang.
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    const row = db.prepare("SELECT COUNT(*) n, MIN(year) a, MAX(year) b FROM gazette").get();
    result.kunngjøringer = row.n;
    result.årganger = row.n ? `${row.a}–${row.b}` : undefined;
    result.sekunder = Number(((Date.now() - started) / 1000).toFixed(1));
    log(`Lovtidend: ${row.n} kunngjøringer (${result.årganger ?? "ingen"}) på ${result.sekunder} s`);
    return result;
  } finally {
    db.close();
    await rm(work, { recursive: true, force: true });
  }
}

async function listXml(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".xml")) out.push(join(entry.parentPath ?? dir, entry.name));
  }
  return out.sort();
}

/**
 * Forarbeidene fra Stortinget. Sakslistene per sesjon er små, og gamle
 * sesjoner endrer seg ikke — derfor hentes hver sesjon bare én gang, mens de
 * to nyeste friskes opp hver gang. Det holder ukesynken på under et minutt
 * i stedet for 70 MB nedlasting.
 */
export async function syncStortinget({ log = () => {}, refreshNewest = 2 } = {}) {
  const db = openDb({ create: true });
  const started = Date.now();
  try {
    const sessions = await fetchSessions();
    // Sesjoner fram i tid finnes i lista og har ingen saker ennå.
    const today = new Date().toISOString().slice(0, 10);
    const usable = sessions.filter((s) => !s.fra || s.fra <= today);
    const newest = new Set(usable.slice(0, refreshNewest).map((s) => s.id));

    const insCase = db.prepare(`INSERT OR REPLACE INTO cases
      (id, session, title, short_title, reference, kind, committee, topics, updated)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const insFts = db.prepare(
      "INSERT INTO cases_fts(case_id, title, short_title, reference, topics) VALUES (?,?,?,?,?)",
    );
    const dropFts = db.prepare("DELETE FROM cases_fts WHERE case_id = ?");
    const dropSession = db.prepare("SELECT id FROM cases WHERE session = ?");
    const dropCases = db.prepare("DELETE FROM cases WHERE session = ?");

    let added = 0;
    let skipped = 0;
    for (const session of usable) {
      const key = `storting_${session.id}`;
      if (getMeta(db, key) && !newest.has(session.id)) {
        skipped++;
        continue;
      }
      let cases;
      try {
        cases = await fetchCases(session.id);
      } catch (err) {
        log(`  ${session.id}: ${err.message}`);
        continue;
      }
      db.exec("BEGIN");
      for (const row of dropSession.all(session.id)) dropFts.run(row.id);
      dropCases.run(session.id);
      for (const c of cases) {
        insCase.run(c.id, c.session, c.title, c.shortTitle, c.reference, c.kind ?? null, c.committee, c.topics, c.updated);
        insFts.run(c.id, c.title, c.shortTitle, c.reference, c.topics ?? "");
      }
      setMeta(db, key, String(cases.length));
      db.exec("COMMIT");
      added += cases.length;
      log(`  ${session.id}: ${cases.length} saker`);
    }
    const total = db.prepare("SELECT COUNT(*) n FROM cases").get().n;
    setMeta(db, "storting_synced_at", new Date().toISOString());
    setMeta(db, "storting_cases", total);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    log(`forarbeider: ${total} saker totalt (${added} hentet, ${skipped} sesjoner uendret) på ${seconds} s`);
    return { cases: total, fetched: added, unchangedSessions: skipped, seconds: Number(seconds) };
  } finally {
    db.close();
  }
}
