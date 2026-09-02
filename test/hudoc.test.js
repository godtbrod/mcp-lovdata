import assert from "node:assert/strict";
import { test } from "node:test";

import { buildQuery, shape } from "../src/hudoc.js";

test("buildQuery setter alltid contentsitename og begrenser til dommer", () => {
  const q = buildQuery({ respondent: "NOR" });
  assert.match(q, /^contentsitename:ECHR AND/);
  assert.match(q, /documentcollectionid2:"JUDGMENTS"/);
  assert.match(q, /respondent:"NOR"/);
});

test("buildQuery tar med avvisningsavgjørelser når det bes om", () => {
  assert.doesNotMatch(buildQuery({ onlyJudgments: false }), /JUDGMENTS/);
});

test("buildQuery bygger felt for artikkel, dato, viktighet og instans", () => {
  const q = buildQuery({
    article: "8", from: "2019-01-01", to: "2020-12-31", importance: 2, branch: "GRANDCHAMBER",
  });
  assert.match(q, /article:"8"/);
  assert.match(q, /kpdate>=2019-01-01/);
  assert.match(q, /kpdate<=2020-12-31/);
  assert.match(q, /importance<=2/);
  assert.match(q, /doctypebranch:"GRANDCHAMBER"/);
});

test("buildQuery skiller saksnavn fra fritekst", () => {
  const q = buildQuery({ caseName: "Strand Lobben", text: "care order" });
  assert.match(q, /docname:"Strand Lobben"/);
  assert.match(q, /\(care order\)/);
});

test("buildQuery fjerner anførselstegn i verdier", () => {
  // Ubalanserte anførselstegn får HUDOC til å svare med en 404-side.
  assert.match(buildQuery({ caseName: 'A "quoted" name' }), /docname:"A quoted name"/);
});

test("shape gjør HUDOC-kolonner om til norske felt", () => {
  const s = shape({
    itemid: "001-195909",
    docname: "CASE OF STRAND LOBBEN AND OTHERS v. NORWAY",
    appno: "37283/13",
    kpdate: "2019-09-10T00:00:00",
    respondent: "NOR",
    doctypebranch: "GRANDCHAMBER",
    article: "8;8-1",
    violation: "8;8-1",
    nonviolation: "",
    importance: "1",
    languageisocode: "ENG",
    extractedappno: "37283/13;12345/06;9876/10",
  });
  assert.equal(s.sak, "CASE OF STRAND LOBBEN AND OTHERS v. NORWAY");
  assert.equal(s.dato, "2019-09-10");
  assert.equal(s.instans, "Storkammer");
  assert.deepEqual(s.artikler, ["8", "8-1"]);
  assert.deepEqual(s.krenkelse, ["8", "8-1"]);
  assert.equal(s.ikkeKrenkelse, undefined, "tomme felt skal utelates");
  assert.match(s.viktighet, /Key case/);
  assert.deepEqual(s.siterteSaker, ["12345/06", "9876/10"], "sakens eget nummer skal ikke stå som sitert");
  assert.equal(s.url, "https://hudoc.echr.coe.int/?i=001-195909");
});
