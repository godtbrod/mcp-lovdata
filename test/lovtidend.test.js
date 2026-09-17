import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import {
  articlesIn,
  changedParts,
  compareArticles,
  normalizeArticle,
  parseGazette,
  periodEnd,
  periodStart,
  refidFrom,
  toLegacyId,
  toRefid,
} from "../src/lovtidend.js";
import { gazetteWriter, lovtidendPackages, tarEntries } from "../src/corpus.js";
import { openLovtidendDb, queryTerms, setMeta } from "../src/db.js";
import { Lovtidend, makeSnippet } from "../src/query.js";

// Et utdrag av en ekte kunngjøring, kortet ned: LOV-2023-12-15-88, der
// endringene er merket på paragrafnivå slik Lovdata har gjort siden 2023.
const MERKET = `<!DOCTYPE html><html lang="nb"><head><title>Lov om endringer i arbeidsmiljøloven</title></head>
<body><header class="documentHeader"><dl class="data-document-key-info">
<dt class="legacyID">Datokode</dt><dd class="legacyID">LOV-2023-12-15-88</dd>
<dt class="dokid">DokumentID</dt><dd class="dokid">LTI/lov/2023-12-15-88</dd>
<dt class="ministry">Departement</dt><dd class="ministry"><ul><li>Arbeids- og inkluderingsdepartementet</li></ul></dd>
<dt class="dateInForce">I kraft fra</dt><dd class="dateInForce">Kongen bestemmer</dd>
<dt class="changesToDocuments">Endrer</dt><dd class="changesToDocuments"><ul><li>lov/2005-06-17-62</li><li>lov/2017-06-16-67</li></ul></dd>
<dt class="dateOfPublication">Kunngjort</dt><dd class="dateOfPublication">2023-12-15 12:50</dd>
<dt class="journalNumber">Journalnummer</dt><dd class="journalNumber">2023-1301</dd>
<dt class="titleShort">Korttittel</dt><dd class="titleShort">Endringslov til arbeidsmilj&oslash;loven</dd>
<dt class="title">Tittel</dt><dd class="title">Lov om endringer i arbeidsmilj&oslash;loven (forutsigbare arbeidsvilk&aring;r)</dd>
<dt class="miscInformation">Annet</dt><dd class="miscInformation">Prop.130 L (2022&ndash;2023), Innst.60 L (2023&ndash;2024).</dd>
<dt class="refid">RefID</dt><dd class="refid">lov/2023-12-15-88</dd>
</dl></header><main class="documentBody"><h1>Lov om endringer i arbeidsmiljøloven</h1>
<section class="section"><h2>I</h2>
<article class="document-change" data-document="lov/2005-06-17-62">
<article class="defaultP">I lov 17. juni 2005 nr. 62 om arbeidsmiljø gjøres følgende endringer:</article>
<article class="change" data-change-part="lov/2005-06-17-62/&sect;15-6/ledd/3">
<article class="defaultP">§ 15-6 tredje ledd skal lyde:</article>
<article class="legalP">Prøvetiden kan ikke avtales lengre enn seks måneder.</article></article>
<article class="change" data-add-new-part="lov/2005-06-17-62/&sect;14-8a">
<article class="defaultP">Ny § 14-8 a skal lyde:</article></article>
</article></section></main></body></html>`;

// Og en av den gamle typen: instruksjonene står bare i teksten.
const UMERKET = `<!DOCTYPE html><html><head><title>Endringslov</title></head><body>
<header class="documentHeader"><dl class="data-document-key-info">
<dt class="legacyID">Datokode</dt><dd class="legacyID">LOV-2015-04-24-20</dd>
<dt class="dokid">DokumentID</dt><dd class="dokid">LTI/lov/2015-04-24-20</dd>
<dt class="dateInForce">I kraft fra</dt><dd class="dateInForce">2015-07-01</dd>
<dt class="changesToDocuments">Endrer</dt><dd class="changesToDocuments"><ul><li>lov/2005-06-17-62</li><li>lov/2009-12-18-131</li></ul></dd>
<dt class="dateOfPublication">Kunngjort</dt><dd class="dateOfPublication">2015-04-24</dd>
<dt class="title">Tittel</dt><dd class="title">Lov om endringer i arbeidsmiljøloven og sosialtjenesteloven</dd>
<dt class="refid">RefID</dt><dd class="refid">lov/2015-04-24-20</dd>
</dl></header><main class="documentBody">
<section class="section"><h2>I</h2>
<article class="legalP">I lov 17. juni 2005 nr. 62 om arbeidsmiljø gjøres følgende endringer:</article>
<article class="defaultP">§ 14-9 første ledd bokstav a skal lyde:</article>
<article class="defaultP">§§ 14-12 og 14-13 oppheves.</article>
</section><section class="section"><h2>II</h2>
<article class="legalP">I lov 18. desember 2009 nr. 131 om sosiale tjenester gjøres følgende endringer:</article>
<article class="defaultP">§ 20 skal lyde:</article>
</section></main></body></html>`;

test("parseGazette leser hodet i en kunngjøring", () => {
  const d = parseGazette(MERKET);
  assert.equal(d.id, "LTI/lov/2023-12-15-88");
  assert.equal(d.type, "lov");
  assert.equal(d.legacyId, "LOV-2023-12-15-88");
  assert.equal(d.refid, "lov/2023-12-15-88");
  assert.equal(d.shortTitle, "Endringslov til arbeidsmiljøloven");
  assert.equal(d.ministry, "Arbeids- og inkluderingsdepartementet");
  assert.equal(d.published, "2023-12-15 12:50");
  assert.equal(d.publishedDate, "2023-12-15");
  assert.equal(d.year, 2023);
  assert.equal(d.inForce, "Kongen bestemmer");
  assert.equal(d.inForceDate, undefined, "fritekst er ingen dato");
  assert.match(d.misc, /Prop\.130 L/);
  assert.match(d.text, /Prøvetiden kan ikke avtales lengre enn seks måneder\./);
  assert.ok(!d.text.includes("<"), "teksten skal være uten markup");
});

test("parseGazette finner paragrafene fra Lovdatas egen merking", () => {
  const { parts } = parseGazette(MERKET);
  assert.deepEqual(parts, [
    { target: "lov/2005-06-17-62", article: null },
    { target: "lov/2017-06-16-67", article: null },
    // §-tegnet står som &sect; i attributtet og må avkodes.
    { target: "lov/2005-06-17-62", article: "§15-6" },
    { target: "lov/2005-06-17-62", article: "§14-8a" },
  ]);
});

test("parseGazette leser paragrafene ut av teksten i eldre kunngjøringer", () => {
  const { parts } = parseGazette(UMERKET);
  const aml = parts.filter((p) => p.target === "lov/2005-06-17-62" && p.article).map((p) => p.article);
  const sos = parts.filter((p) => p.target === "lov/2009-12-18-131" && p.article).map((p) => p.article);
  assert.deepEqual(aml, ["§14-9", "§14-12", "§14-13"]);
  // Paragrafene under «II» hører til den andre loven, ikke den første.
  assert.deepEqual(sos, ["§20"]);
});

test("changedParts holder seg til dokumentene i Endrer-feltet", () => {
  const body = `<main><article class="defaultP">I lov 1. januar 2000 nr. 1 om noe annet gjøres følgende endringer:</article>
    <article class="defaultP">§ 5 skal lyde:</article></main>`;
  // Loven i teksten står ikke i Endrer-feltet: da er den nevnt, ikke endret,
  // og paragrafen hører til den ene loven som faktisk endres.
  assert.deepEqual(changedParts(body, ["lov/1999-01-01-9"]), [
    { target: "lov/1999-01-01-9", article: null },
    { target: "lov/1999-01-01-9", article: "§5" },
  ]);
});

test("articlesIn plukker paragrafnumre ut av instruksjoner", () => {
  assert.deepEqual(articlesIn("§ 15-6 tredje ledd skal lyde:"), ["§15-6"]);
  assert.deepEqual(articlesIn("§§ 25 a og 25 b oppheves."), ["§25a", "§25b"]);
  assert.deepEqual(articlesIn("Ny § 14-8 a skal lyde:"), ["§14-8a"]);
  assert.deepEqual(articlesIn("Nåværende § 7 blir ny § 8."), ["§7", "§8"]);
  // «andre» begynner på a, men er et ord — ikke bokstaven i «§ 15 a».
  assert.deepEqual(articlesIn("§ 15 andre ledd skal lyde:"), ["§15"]);
});

test("refidFrom leser lovhenvisninger i klartekst", () => {
  assert.equal(refidFrom("I lov 17. juni 2005 nr. 62 om arbeidsmiljø").refid, "lov/2005-06-17-62");
  assert.equal(refidFrom("I forskrift 6. april 2022 nr. 633 om import").refid, "forskrift/2022-04-06-633");
  assert.equal(refidFrom("I lov av 22. juni 2018 nr. 77 om tobakk").refid, "lov/2018-06-22-77");
  // Enkelte gamle lover har ingen nummer; refid er da bare datoen.
  assert.equal(refidFrom("I lov 3. mai 1957 om pensjonering").refid, "lov/1957-05-03");
  assert.equal(refidFrom("Ingen henvisning her"), undefined);
});

test("normalizeArticle og toRefid gjør formene om til én", () => {
  assert.equal(normalizeArticle("§ 15-6"), "§15-6");
  assert.equal(normalizeArticle("15-6"), "§15-6");
  assert.equal(normalizeArticle("§ 7 a"), "§7a");
  assert.equal(toRefid("LOV-2005-06-17-62"), "lov/2005-06-17-62");
  assert.equal(toRefid("FOR-2022-04-06-633"), "forskrift/2022-04-06-633");
  assert.equal(toRefid("NL/lov/2005-06-17-62"), "lov/2005-06-17-62");
  assert.equal(toRefid("NL/lov/1814-05-17#nn"), "lov/1814-05-17", "nynorskutgaven er samme dokument");
  assert.equal(toRefid("DEL/forskrift/2005-06-17-609"), "forskrift/2005-06-17-609");
  assert.equal(toRefid("arbeidsmiljøloven"), undefined, "navn må slås opp i lovindeksen");
  assert.equal(toLegacyId("lov/2005-06-17-62"), "LOV-2005-06-17-62");
  assert.equal(toLegacyId("forskrift/2022-04-06-633"), "FOR-2022-04-06-633");
});

test("compareArticles sorterer paragrafer som en jurist leser dem", () => {
  const sorted = ["§14-12", "§2-2", "§1-8", "§14-8a", "§14-8"].sort(compareArticles);
  assert.deepEqual(sorted, ["§1-8", "§2-2", "§14-8", "§14-8a", "§14-12"]);
});

test("periodStart og periodEnd utvider år og måned til datoer", () => {
  assert.equal(periodStart("2024"), "2024-01-01");
  assert.equal(periodEnd("2024"), "2024-12-31");
  assert.equal(periodStart("2024-03"), "2024-03-01");
  assert.equal(periodEnd("2024-02"), "2024-02-29", "skuddår");
  assert.equal(periodEnd("2023-02"), "2023-02-28");
  assert.equal(periodStart("2024-03-15"), "2024-03-15");
  assert.equal(periodStart("i fjor"), undefined);
});

test("lovtidendPackages leser årstall ut av filnavnene", () => {
  const packages = lovtidendPackages([
    { filename: "gjeldende-lover.tar.bz2", lastModified: "x" },
    { filename: "lovtidend-avd1-2026.tar.bz2", lastModified: "a", sizeBytes: "1407920" },
    { filename: "lovtidend-avd1-2001-2025.tar.bz2", lastModified: "b", sizeBytes: "69305260" },
  ]);
  assert.deepEqual(
    packages.map((p) => [p.filename, p.from, p.to, p.history]),
    [
      ["lovtidend-avd1-2001-2025.tar.bz2", 2001, 2025, true],
      ["lovtidend-avd1-2026.tar.bz2", 2026, 2026, false],
    ],
  );
  assert.equal(packages[0].bytes, 69_305_260);
});

/** Et tar-hode: navn, oktal størrelse, og typeflagg. Sjekksummen leses ikke. */
function tarBlock(name, size, type = "0") {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write(size.toString(8).padStart(11, "0"), 124, 12, "ascii");
  block.write(type, 156, 1, "ascii");
  return block;
}

test("tarEntries deler strømmen i filer", async () => {
  const body = Buffer.from("<html>første</html>", "utf8");
  const other = Buffer.from("x".repeat(600), "utf8");
  const archive = Buffer.concat([
    tarBlock("lti/2026/", 0, "5"),
    tarBlock("lti/2026/nl-20260101-001.xml", body.length),
    body,
    Buffer.alloc(512 - (body.length % 512)),
    tarBlock("lti/2026/nl-20260101-002.xml", other.length),
    other,
    Buffer.alloc(1024 - (other.length % 512)),
    Buffer.alloc(1024), // avslutningsblokkene
  ]);
  // Små biter med vilje: en fil kan komme i flere deler, og et hode kan bli delt.
  const stream = Readable.from(
    (function* () {
      for (let i = 0; i < archive.length; i += 100) yield archive.subarray(i, i + 100);
    })(),
  );
  const files = [];
  for await (const entry of tarEntries(stream)) files.push({ name: entry.name, text: entry.data.toString("utf8") });
  assert.deepEqual(
    files.map((f) => f.name),
    ["lti/2026/nl-20260101-001.xml", "lti/2026/nl-20260101-002.xml"],
    "mapper skal ikke komme ut som filer",
  );
  assert.equal(files[0].text, "<html>første</html>");
  assert.equal(files[1].text.length, 600);
});

test("makeSnippet legger vinduet der søkeordene står", () => {
  const text = `${"fyll ".repeat(200)}her står prøvetid og oppsigelse sammen.${" hale".repeat(200)}`;
  const s = makeSnippet(text, queryTerms("oppsigelse prøvetid"));
  assert.match(s, /«prøvetid»/);
  assert.match(s, /«oppsigelse»/);
  assert.match(s, /^… /, "utdrag fra midten skal vise at noe er utelatt");
});

test("makeSnippet markerer bøyde former, men ikke halve ord", () => {
  // Søkeord fra fire tegn søkes som prefiks, og da skal hele ordet markeres.
  assert.match(makeSnippet("Retten til oppsigelsesvern gjelder", queryTerms("oppsigelse")), /«oppsigelsesvern»/);
  assert.equal(makeSnippet("Teksten nevner noe helt annet", queryTerms("oppsigelse")).includes("«"), false);
});

test("Lovtidend søker, filtrerer og slår opp", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lovtidend-test-"));
  const before = process.env.LOVTIDEND_DB;
  process.env.LOVTIDEND_DB = join(dir, "lovtidend.db");
  t.after(() => {
    if (before === undefined) delete process.env.LOVTIDEND_DB;
    else process.env.LOVTIDEND_DB = before;
  });

  const db = openLovtidendDb({ create: true });
  const { add } = gazetteWriter(db);
  add(parseGazette(MERKET), 2023);
  add(parseGazette(UMERKET), 2015);
  add(
    {
      id: "LTI/forskrift/2023-12-15-2066",
      refid: "forskrift/2023-12-15-2066",
      legacyId: "FOR-2023-12-15-2066",
      type: "forskrift",
      title: "Ikraftsetting av lov 15. desember 2023 nr. 88 om endringer i arbeidsmiljøloven",
      ministry: "Arbeids- og inkluderingsdepartementet",
      published: "2023-12-18",
      publishedDate: "2023-12-18",
      inForce: "2024-07-01",
      inForceDate: "2024-07-01",
      text: "Loven trer i kraft 1. juli 2024.",
      parts: [{ target: "lov/2005-06-17-62", article: null }],
      basedOn: ["lov/2023-12-15-88"],
    },
    2023,
  );
  setMeta(db, "synced_at", new Date().toISOString());
  db.close();

  const lt = new Lovtidend();
  // Windows nekter å slette mappa så lenge fila er åpen, så dette må skje etterpå.
  t.after(() => {
    lt.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const alle = lt.search({ endrer: "lov/2005-06-17-62" });
  assert.equal(alle.total, 3);
  assert.deepEqual(alle.hits.map((h) => h.legacy_id), [
    "FOR-2023-12-15-2066",
    "LOV-2023-12-15-88",
    "LOV-2015-04-24-20",
  ], "uten søkeord sorteres det med sist kunngjorte først");

  const paragraf = lt.search({ endrer: "lov/2005-06-17-62", article: "§15-6" });
  assert.deepEqual(paragraf.hits.map((h) => h.legacy_id), ["LOV-2023-12-15-88"]);

  const periode = lt.search({ endrer: "lov/2005-06-17-62", from: "2016-01-01" });
  assert.equal(periode.total, 2, "2015-loven faller utenfor perioden");

  const tekst = lt.search({ query: "prøvetid" });
  assert.deepEqual(tekst.hits.map((h) => h.legacy_id), ["LOV-2023-12-15-88"]);
  assert.match(tekst.hits[0].snippet, /«Prøvetiden»/);

  const doc = lt.get("LOV-2023-12-15-88");
  assert.equal(doc.id, "LTI/lov/2023-12-15-88");
  assert.match(doc.text, /seks måneder/);
  assert.deepEqual(
    doc.inForceBy.map((r) => [r.legacy_id, r.in_force_date]),
    [["FOR-2023-12-15-2066", "2024-07-01"]],
    "«Kongen bestemmer» får datoen sin fra en senere kgl.res.",
  );
  assert.equal(lt.get("lov/2023-12-15-88").id, doc.id, "refid skal også treffe");
  assert.equal(lt.get("LTI/lov/2023-12-15-88").id, doc.id);
  assert.equal(lt.get("LOV-1900-01-01-1"), undefined);
});
