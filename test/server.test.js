/**
 * Ende-til-ende gjennom MCP-serveren: verktøyskjemaene, feilhåndteringen og
 * svarformatet. Enhetstestene dekker spørringene, ikke laget rundt dem.
 * Ingen nettverk — indeksen bygges i en midlertidig mappe.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { gazetteWriter } from "../src/corpus.js";
import { openLovtidendDb, setMeta } from "../src/db.js";
import { textOf, withClient } from "./harness.js";

const dir = mkdtempSync(join(tmpdir(), "lovdata-server-test-"));
const saved = { LOVDATA_DB: process.env.LOVDATA_DB, LOVTIDEND_DB: process.env.LOVTIDEND_DB };

before(() => {
  // Lovindeksen finnes med vilje ikke: Lovtidend skal virke uten den.
  process.env.LOVDATA_DB = join(dir, "lovdata.db");
  process.env.LOVTIDEND_DB = join(dir, "lovtidend.db");

  const db = openLovtidendDb({ create: true });
  const { add } = gazetteWriter(db);
  add(
    {
      id: "LTI/lov/2023-12-15-88",
      refid: "lov/2023-12-15-88",
      legacyId: "LOV-2023-12-15-88",
      type: "lov",
      title: "Lov om endringer i arbeidsmiljøloven (forutsigbare arbeidsvilkår)",
      shortTitle: "Endringslov til arbeidsmiljøloven",
      ministry: "Arbeids- og inkluderingsdepartementet",
      published: "2023-12-15 12:50",
      publishedDate: "2023-12-15",
      inForce: "Kongen bestemmer",
      misc: "Prop.130 L (2022–2023), Innst.60 L (2023–2024).",
      text: "§ 15-6 tredje ledd skal lyde: Prøvetiden kan ikke avtales lengre enn seks måneder.",
      parts: [
        { target: "lov/2005-06-17-62", article: null },
        { target: "lov/2005-06-17-62", article: "§15-6" },
      ],
      basedOn: [],
    },
    2023,
  );
  setMeta(db, "synced_at", new Date().toISOString());
  db.close();
});

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const call = (client, name, args) => client.callTool({ name, arguments: args });

test("serveren tilbyr Lovtidend-verktøyene", async () => {
  await withClient(async (client) => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("lovtidend_search"), `mangler lovtidend_search, har ${names.join(", ")}`);
    assert.ok(names.includes("lovtidend_get"));
  });
});

test("lovtidend_search finner endringer i en lov uten at lovindeksen finnes", async () => {
  await withClient(async (client) => {
    const res = await call(client, "lovtidend_search", { endrer: "LOV-2005-06-17-62", paragraf: "§ 15-6" });
    assert.equal(res.isError, undefined, textOf(res));
    const svar = JSON.parse(textOf(res));
    assert.equal(svar.total, 1);
    assert.equal(svar.kunngjøringer[0].kode, "LOV-2023-12-15-88");
    assert.equal(svar.kunngjøringer[0].url, "https://lovdata.no/dokument/LTI/lov/2023-12-15-88");
    // Uten lovindeksen kjenner vi ikke navnet på loven som endres, bare koden.
    assert.deepEqual(svar.kunngjøringer[0].endrer, ["LOV-2005-06-17-62 §15-6"]);
  });
});

test("lovtidend_search krever at en paragraf hører til et dokument", async () => {
  await withClient(async (client) => {
    const res = await call(client, "lovtidend_search", { paragraf: "§ 15-6" });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /paragraf.*endrer/s);
  });
});

test("lovtidend_search avviser en periode den ikke forstår", async () => {
  await withClient(async (client) => {
    // Før dette ble et ugyldig format stille ignorert, og svaret dekket alle år.
    const res = await call(client, "lovtidend_search", { from: "01.01.2024" });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /2024-03-01|år, år-måned/);
  });
});

test("lovtidend_get gir hele kunngjøringen, og en tydelig feil når koden ikke finnes", async () => {
  await withClient(async (client) => {
    const res = await call(client, "lovtidend_get", { reference: "LOV-2023-12-15-88" });
    const doc = JSON.parse(textOf(res));
    assert.match(doc.tekst, /seks måneder/);
    assert.match(doc.annet, /Prop\.130 L/);
    assert.equal(doc.avkortet, undefined);

    const mangler = await call(client, "lovtidend_get", { reference: "LOV-1900-01-01-1" });
    assert.equal(mangler.isError, true);
    assert.match(textOf(mangler), /lovtidend_search/);
  });
});

test("status svarer selv om lovindeksen mangler, og viser Lovtidend", async () => {
  await withClient(async (client) => {
    const svar = JSON.parse(textOf(await call(client, "status", {})));
    assert.equal(svar.klar, false, "lovindeksen er ikke bygget i denne testen");
    assert.equal(svar.lovtidend.kunngjøringer, 1);
    assert.equal(svar.lovtidend.årganger, "2023–2023");
    assert.match(svar.lovtidend.historikk, /inneværende år/);
  });
});
