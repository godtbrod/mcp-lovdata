import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { openDb, setMeta } from "./db.js";
import { parseDocument } from "./parse.js";

const run = promisify(execFile);

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
      await run("mkdir", ["-p", dir]);
      log(`pakker ut ${(bytes / 1e6).toFixed(1)} MB …`);
      await run("tar", ["xjf", archive, "-C", dir], { maxBuffer: 1 << 24 });
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

async function listXml(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".xml")) out.push(join(entry.parentPath ?? dir, entry.name));
  }
  return out.sort();
}
