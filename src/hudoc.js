/**
 * Rettspraksis fra Den europeiske menneskerettsdomstolen (EMD), via HUDOC —
 * Europarådets åpne database. Ingen autentisering.
 *
 * Hvorfor EMD og ikke Høyesterett: norsk rettspraksis finnes ikke i noen fri,
 * maskinlesbar kilde. Lovdata Pro tar betalt for den, og domstol.no sperrer
 * /api i robots.txt. EMD-praksis er derimot åpent publisert — og er norsk rett:
 * menneskerettsloven § 2 gjør EMK til norsk lov, og § 3 gir den forrang ved
 * motstrid med annen lovgivning.
 */

import { stripTags } from "./parse.js";

const BASE = "https://hudoc.echr.coe.int";

const FIELDS = [
  "itemid", "docname", "appno", "kpdate", "article", "conclusion", "importance",
  "doctypebranch", "originatingbody", "ecli", "languageisocode", "respondent",
  "violation", "nonviolation", "extractedappno", "typedescription",
];

/** Viktighetsgrad slik HUDOC koder den. 1 er de prinsipielle avgjørelsene. */
export const IMPORTANCE = {
  1: "Key case (høyeste)",
  2: "Nivå 1 — betydelig rettsutvikling",
  3: "Nivå 2 — begrenset rettsutvikling",
  4: "Nivå 3 — anvender etablert praksis",
};

const BRANCH = {
  GRANDCHAMBER: "Storkammer",
  CHAMBER: "Kammer",
  COMMITTEE: "Komité",
  ADMISSIBILITY: "Avvisningsavgjørelse",
  ADMISSIBILITYCOM: "Avvisningsavgjørelse (kommisjonen)",
};

class HudocError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** HUDOC svarer med 502 fra tid til annen. Ett nytt forsøk holder som regel. */
async function get(path, params, { timeoutMs = 60_000, raw = false, attempts = 3 } = {}) {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "mcp-lovdata", Accept: raw ? "text/html" : "application/json" },
        signal: controller.signal,
      });
      if (res.status >= 500) {
        last = new HudocError(`HUDOC svarte HTTP ${res.status} for ${url.pathname}`);
        if (attempt < attempts - 1) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw last;
      }
      if (!res.ok) throw new HudocError(`HUDOC svarte HTTP ${res.status} for ${url.pathname}`);
      if (raw) return await res.text();
      const body = await res.text();
      try {
        return JSON.parse(body);
      } catch {
        // HUDOC svarer med en 404-side i HTML når spørresyntaksen ikke godtas.
        throw new HudocError("HUDOC forsto ikke spørringen. Sjekk feltnavn og anførselstegn.");
      }
    } catch (err) {
      if (err instanceof HudocError) throw err;
      last =
        err?.name === "AbortError"
          ? new HudocError(`HUDOC svarte ikke innen ${timeoutMs} ms.`)
          : new HudocError(`HUDOC: ${err.message}`);
      if (attempt < attempts - 1) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw last;
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

/** HUDOC bruker Lucene-syntaks; anførselstegn må balanseres for å unngå 404. */
function quote(value) {
  return `"${String(value).replace(/"/g, "")}"`;
}

export function buildQuery({ text, caseName, appNo, respondent, article, from, to, importance, branch, onlyJudgments }) {
  const parts = ["contentsitename:ECHR"];
  if (onlyJudgments !== false) parts.push(`(documentcollectionid2:${quote("JUDGMENTS")})`);
  if (respondent) parts.push(`(respondent:${quote(respondent)})`);
  if (article) parts.push(`(article:${quote(article)})`);
  if (branch) parts.push(`(doctypebranch:${quote(branch)})`);
  if (importance) parts.push(`(importance<=${Number(importance)})`);
  if (from) parts.push(`(kpdate>=${from})`);
  if (to) parts.push(`(kpdate<=${to})`);
  if (caseName) parts.push(`(docname:${quote(caseName)})`);
  if (appNo) parts.push(`(appno:${quote(appNo)})`);
  if (text?.trim()) parts.push(`(${text.trim()})`);
  return parts.join(" AND ");
}

export const shape = (columns) => {
  const list = (v) => (v ? String(v).split(";").filter(Boolean) : undefined);
  return {
    itemid: columns.itemid,
    sak: columns.docname,
    klagenummer: columns.appno,
    dato: columns.kpdate?.slice(0, 10),
    stat: columns.respondent,
    instans: BRANCH[columns.doctypebranch] ?? columns.doctypebranch,
    artikler: list(columns.article),
    krenkelse: list(columns.violation),
    ikkeKrenkelse: list(columns.nonviolation),
    konklusjon: columns.conclusion || undefined,
    viktighet: columns.importance ? (IMPORTANCE[columns.importance] ?? columns.importance) : undefined,
    ecli: columns.ecli || undefined,
    språk: columns.languageisocode,
    siterteSaker: list(columns.extractedappno)?.slice(1, 12),
    url: `${BASE}/?i=${columns.itemid}`,
  };
};

/**
 * Søk i EMD-praksis. Standard er avgjørelser mot Norge på engelsk — HUDOC har
 * hver avgjørelse i både engelsk og fransk versjon, og uten språkfilter kommer
 * alt i par.
 */
export async function searchCaselaw({
  text, respondent = "NOR", article, from, to, importance, branch,
  caseName, appNo, language = "ENG", onlyJudgments = true, limit = 10, offset = 0,
}) {
  // null betyr «alle stater»; undefined betyr «ikke oppgitt», altså Norge.
  const state = respondent === null ? undefined : respondent;
  const query = buildQuery({ text, caseName, appNo, respondent: state, article, from, to, importance, branch, onlyJudgments });
  const withLang = language ? `${query} AND (languageisocode:${quote(language)})` : query;
  const data = await get("/app/query/results", {
    query: withLang,
    select: FIELDS.join(","),
    // sort er obligatorisk: uten den svarer HUDOC med en 404-side. Og feltet må
    // være ett HUDOC kjenner — «rank» gir stille null treff i stedet for en feil.
    sort: "kpdate Descending",
    start: offset,
    length: limit,
  });
  return {
    total: data.resultcount ?? 0,
    hits: (data.results ?? []).map((r) => shape(r.columns)),
    query: withLang,
  };
}

/** Full tekst i en avgjørelse. HUDOC leverer den som HTML. */
export async function getCaselaw(itemid) {
  const html = await get("/app/conversion/docx/html/body", { library: "ECHR", id: itemid }, { raw: true });
  // Samme tekstuttrekk som for lovtekstene, inkludert heksadesimale entiteter
  // som &#xa0; — HUDOC er full av dem.
  const text = stripTags(html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " "));
  return { itemid, text, pdf: `${BASE}/app/conversion/pdf/?library=ECHR&id=${itemid}`, url: `${BASE}/?i=${itemid}` };
}
