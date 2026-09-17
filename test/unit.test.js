import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { decodeEntities, documentType, outerElements, parseDocument, stripTags } from "../src/parse.js";
import { indexProblem, openDb, setMeta, toMatchQuery } from "../src/db.js";

test("decodeEntities takler navngitte og numeriske referanser", () => {
  assert.equal(decodeEntities("Bl&aring;b&aelig;r &amp; sm&oslash;r"), "Blåbær & smør");
  assert.equal(decodeEntities("&#167; 100 &#x2014; slutt"), "§ 100 — slutt");
  assert.equal(decodeEntities("&ukjent;"), "&ukjent;");
});

test("stripTags gir lesbar tekst med linjeskift per avsnitt", () => {
  const html = '<article class="legalP">Første ledd.</article><article class="legalP">Andre ledd.</article>';
  assert.equal(stripTags(html), "Første ledd.\nAndre ledd.");
});

test("stripTags skiller listepunkter fra den innledende setningen", () => {
  const html =
    '<article class="legalP">plikter å hindre at andre får vite om:' +
    '<ol class="defaultList"><li>noens personlige forhold, eller</li>' +
    "<li>tekniske innretninger</li></ol></article>";
  const lines = stripTags(html).split("\n").filter(Boolean);
  assert.equal(lines[0], "plikter å hindre at andre får vite om:");
  assert.equal(lines[1], "noens personlige forhold, eller");
  assert.equal(lines[2], "tekniske innretninger");
});

test("outerElements finner ytterste element og hopper over nøstede", () => {
  const html =
    '<article class="legalArticle" data-name="§1">ute<article class="legalP">inne</article></article>' +
    '<article class="legalArticle" data-name="§2">to</article>';
  const found = outerElements(html, "article", "legalArticle");
  assert.equal(found.length, 2);
  assert.match(found[0].startTag, /§1/);
  assert.match(found[0].html, /inne/, "det nøstede innholdet skal bli med");
  assert.equal(found[1].html, "to");
});

test("outerElements ignorerer andre klasser", () => {
  const html = '<article class="defaultP">nei</article><article class="legalArticle">ja</article>';
  assert.deepEqual(outerElements(html, "article", "legalArticle").map((e) => e.html), ["ja"]);
});

const DOC = `<html><head><title>Testlov</title></head><body>
<header class="documentHeader"><dl class="data-document-key-info">
<dt class="dokid">DokumentID</dt><dd class="dokid">NL/lov/2020-01-01-1</dd>
<dt class="legacyID">Datokode</dt><dt class="legacyID">x</dt><dd class="legacyID">LOV-2020-01-01-1</dd>
<dt class="title">Tittel</dt><dd class="title">Lov om testing (testlova)</dd>
<dt class="titleShort">Korttittel</dt><dd class="titleShort">Testlova &ndash; tl</dd>
<dt class="ministry">Departement</dt><dd class="ministry"><ul><li>Justis- og beredskapsdepartementet</li></ul></dd>
<dt class="basedOn">Hjemmel</dt><dd class="basedOn"><a href="lov/1999-01-01-1/&sect;3">§3</a></dd>
</dl></header>
<main class="documentBody">
<section class="section" data-name="kap1" id="kapittel-1"><h2>Kapittel 1. Innleiing</h2>
<article class="legalArticle" data-name="§1" data-lovdata-URL="NL/lov/2020-01-01-1/§1">
<h3 class="legalArticleHeader"><span class="legalArticleValue">§ 1</span>. Formål</h3>
<article class="legalP">Lova skal verne.</article>
<article class="changesToParent">Endret ved lov 2021-05-05.</article>
</article></section></main></body></html>`;

test("parseDocument leser metadata, kapittel, tekst og endringer", () => {
  const d = parseDocument(DOC, "lover/nl/nl-20200101-001.xml");
  assert.equal(d.id, "NL/lov/2020-01-01-1");
  assert.equal(d.type, "lov");
  assert.equal(d.legacyId, "LOV-2020-01-01-1");
  assert.equal(d.shortTitle, "Testlova – tl");
  assert.equal(d.ministry, "Justis- og beredskapsdepartementet");
  assert.deepEqual(d.basedOn, ["lov/1999-01-01-1/§3"]);
  assert.equal(d.language, "nb");
  assert.equal(d.articles.length, 1);

  const a = d.articles[0];
  assert.equal(a.name, "§1");
  assert.equal(a.heading, "§ 1. Formål");
  assert.equal(a.chapter, "Kapittel 1. Innleiing");
  assert.equal(a.text, "Lova skal verne.", "endringshistorikken skal holdes utenfor lovteksten");
  assert.match(a.changes, /Endret ved lov 2021-05-05/);
});

test("parseDocument skiller nynorskutgaven fra bokmålsutgaven", () => {
  const nn = parseDocument(DOC, "lover/nl/nl-20200101-001-nn.xml");
  assert.equal(nn.language, "nn");
  assert.equal(nn.id, "NL/lov/2020-01-01-1#nn", "samme dokid må ikke overskrive bokmålsutgaven");
});

test("documentType leser mappa i både Windows- og Unix-stier", () => {
  // På Windows kommer stiene med «\». Ble de bare delt på «/», fikk alle
  // dokumentene typen «ukjent», og type-filteret og rangeringen sluttet å virke.
  assert.equal(documentType("C:\\Temp\\lovdata-x\\lover\\nl\\nl-20050617-062.xml"), "lov");
  assert.equal(documentType("/tmp/lovdata-x/forskrifter/sf/sf-20170619-0840.xml"), "forskrift");
});

test("toMatchQuery siterer ord og lar fraser stå", () => {
  assert.equal(toMatchQuery("oppsigelse prøvetid"), '"oppsigelse"* "prøvetid"*');
  assert.equal(toMatchQuery('"tvungent psykisk helsevern"'), '"tvungent psykisk helsevern"');
  assert.equal(toMatchQuery("arbeidsgiv*"), '"arbeidsgiv"*');
});

test("toMatchQuery søker prefiks, så bøyning ikke skjuler treff", () => {
  // «oppsigelsen» i paragrafteksten skal treffes av «oppsigelse» i søket.
  assert.equal(toMatchQuery("oppsigelse"), '"oppsigelse"*');
  // Korte ord ville dratt inn for mye: «bil*» treffer «bilag» og «bilde».
  assert.equal(toMatchQuery("bil"), '"bil"');
  assert.equal(toMatchQuery("barn"), '"barn"*', "fire tegn er grensen, og den er med");
  // Anførselstegn er veien ut når eksakt form er poenget.
  assert.equal(toMatchQuery('"oppsigelse"'), '"oppsigelse"');
});

test("toMatchQuery fjerner bindeord, men ikke inne i fraser", () => {
  assert.equal(toMatchQuery("oppsigelse i prøvetiden"), '"oppsigelse"* "prøvetiden"*');
  assert.equal(toMatchQuery('"i og med" støy'), '"i og med" "støy"*');
});

test("toMatchQuery beholder ordene når alt er bindeord", () => {
  assert.equal(toMatchQuery("i og"), '"i" "og"', "et tomt MATCH-uttrykk ville gitt syntaksfeil");
});

test("toMatchQuery gir tom streng for tegn som ikke kan indekseres", () => {
  assert.equal(toMatchQuery("§"), "");
  assert.equal(toMatchQuery("   "), "");
});

test("indexProblem skiller manglende, uferdig og ferdig indeks", () => {
  const dir = mkdtempSync(join(tmpdir(), "lovdata-test-"));
  const before = process.env.LOVDATA_DB;
  process.env.LOVDATA_DB = join(dir, "lovdata.db");
  try {
    assert.match(indexProblem(), /Ingen lokal indeks/);

    // Slik ser fila ut når første sync stopper før lovtekstene er skrevet:
    // skjemaet finnes, tabellene er tomme, og synced_at mangler.
    const db = openDb({ create: true });
    db.close();
    assert.match(indexProblem(), /aldri ferdig bygget/, "en tom indeks skal ikke se brukbar ut");

    const done = openDb({ create: true });
    setMeta(done, "synced_at", new Date().toISOString());
    done.close();
    assert.equal(indexProblem(), null);
  } finally {
    if (before === undefined) delete process.env.LOVDATA_DB;
    else process.env.LOVDATA_DB = before;
    rmSync(dir, { recursive: true, force: true });
  }
});
