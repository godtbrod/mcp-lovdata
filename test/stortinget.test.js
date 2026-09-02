import assert from "node:assert/strict";
import { test } from "node:test";

import { documentKind, parseDate, publicationId } from "../src/stortinget.js";

test("parseDate leser Stortingets .NET-datoer", () => {
  // Tidspunktet er lokal midnatt: 2026-08-23T22:00:00Z er 24. august i Oslo.
  assert.equal(parseDate("/Date(1787522400000+0200)/"), "2026-08-24");
  assert.equal(parseDate("/Date(1787522400000)/"), "2026-08-23", "uten offset tolkes det som UTC");
  assert.equal(parseDate("/Date(-62135596800000)/"), undefined, "år 1 er en tom dato, ikke en dato");
  assert.equal(parseDate(null), undefined);
  assert.equal(parseDate("2026-01-01"), undefined);
});

test("documentKind leses ut av henvisningen, ikke av type-koden", () => {
  assert.equal(documentKind("Prop. 12 L (2024-2025)"), "Lovproposisjon");
  assert.equal(documentKind("Prop. 110 S (2025–2026)"), "Proposisjon");
  assert.equal(documentKind("Innst. 449 S (2025-2026)"), "Innstilling");
  assert.equal(documentKind("Meld. St. 4 (2024-2025)"), "Stortingsmelding");
  assert.equal(documentKind("Dokument 8:288 S"), "Representantforslag");
  assert.equal(documentKind("Dokument 3:5 (2024-2025)"), "Dokumentserien");
});

test("documentKind takler null og ukjent form", () => {
  // Eldre saker har henvisning = null; default-parameteren fanger ikke det.
  assert.equal(documentKind(null), undefined);
  assert.equal(documentKind(undefined), undefined);
  assert.equal(documentKind("Noe helt annet"), undefined);
});

test("publicationId bygger IDen Stortingets eksport forventer", () => {
  assert.equal(publicationId("Innst. 449 S (2025-2026)", "2025-2026"), "inns-202526-449s");
  assert.equal(publicationId("Prop. 110 S", "2025-2026"), "prop-202526-110s");
  assert.equal(publicationId("Innst. 1 S", "2025-2026"), "inns-202526-001s", "nummeret polstres til tre siffer");
  assert.equal(publicationId("Meld. St. 4", "2024-2025"), "stmeld-202425-004");
});

test("publicationId gir undefined når den ikke kjenner formen", () => {
  assert.equal(publicationId("Lovvedtak 47 (2025-2026)", "2025-2026"), undefined);
  assert.equal(publicationId("Innst. 449 S", undefined), undefined);
  assert.equal(publicationId(null, "2025-2026"), undefined);
});
