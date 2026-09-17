#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { dbPath, indexProblem, lovtidendPath, lovtidendProblem } from "./db.js";
import { Corpus, Lovtidend } from "./query.js";
import { sync, syncLovtidend, syncStortinget } from "./corpus.js";
import { normalizeArticle, periodEnd, periodStart, toLegacyId, toRefid } from "./lovtidend.js";
import { getCaselaw, searchCaselaw } from "./hudoc.js";
import { fetchCase, fetchPublication, publicationId } from "./stortinget.js";
import { getOpinion, searchOpinions } from "./sivilombudet.js";

const DOC_TYPES = ["lov", "forskrift", "delegering", "instruks", "stortingsvedtak"];

const server = new McpServer(
  { name: "lovdata", version: "0.1.0" },
  {
    instructions: [
      "Norske lover og sentrale forskrifter fra Lovdatas åpne datasett (NLOD 2.0),",
      "indeksert lokalt i SQLite og søkbare i fulltekst. Ingen nettverkskall ved søk.",
      "",
      "Korpuset er de KONSOLIDERTE, GJELDENDE tekstene — ikke rettspraksis, ikke",
      "forarbeider, ikke lokale forskrifter, ikke opphevet regelverk, og ingen",
      "historiske versjoner. Alt det ligger bak betaling i Lovdata Pro.",
      "",
      "Vanlig arbeidsflyt:",
      "  1. `search` med det juridiske spørsmålet — treffene er enkeltparagrafer.",
      "  2. `get_article` for hele paragrafen når utdraget ikke er nok.",
      "  3. `get_document` for metadata, hjemmel og innholdsfortegnelse.",
      "Kjenner du lovens navn, gå rett på `get_document` med f.eks. «arbeidsmiljøloven».",
      "",
      "RETTSPRAKSIS: `caselaw_search` og `caselaw_get` søker i Den europeiske",
      "menneskerettsdomstolen (EMD) via Europarådets åpne HUDOC-base. Det er ikke",
      "norsk rettspraksis — Høyesterett finnes ikke i noen fri, maskinlesbar kilde —",
      "men EMD-praksis ER norsk rett: menneskerettsloven § 2 gjør EMK til norsk lov,",
      "og § 3 gir den forrang ved motstrid med annen lovgivning.",
      "",
      "FORARBEIDER: `preparatory_search` og `preparatory_get` dekker Stortingets saker",
      "fra 1986 til i dag — proposisjoner, innstillinger, meldinger og",
      "representantforslag. Det er der lovgivers mening står, og den er en tung",
      "rettskilde ved tolkning av uklar lovtekst.",
      "",
      "FORVALTNINGSPRAKSIS: `ombudsman_search` og `ombudsman_get` dekker Sivilombudets",
      "uttalelser — tyngst på forvaltningsloven, offentleglova og saksbehandling.",
      "",
      "ENDRINGSHISTORIKK: `lovtidend_search` og `lovtidend_get` dekker Norsk Lovtidend",
      "avd. I — kunngjøringen av hver nye lov og forskrift og hver endring i dem, med",
      "dato, departement, ikrafttredelse og nøyaktig hvilke paragrafer som ble endret.",
      "Det svarer på HVA som ble endret, NÅR og AV HVILKEN endringslov. Det gir ikke",
      "lovteksten slik den lød på en gitt dato — historiske versjoner finnes bare i",
      "Lovdata Pro. Uten `sync ... historikk: true` dekker det bare inneværende år.",
      "",
      "Sitér alltid paragrafen ordrett og oppgi lov og §-nummer. Datasettet oppdateres",
      "hver natt hos Lovdata; `status` viser hvor gammel den lokale indeksen er.",
    ].join("\n"),
  },
);

let corpus;
function open() {
  if (corpus) return corpus;
  const problem = indexProblem();
  if (problem) {
    throw new Error(`${problem} Kjør verktøyet \`sync\` (eller \`npm run sync\`) én gang først — det tar rundt tre minutter.`);
  }
  corpus = new Corpus();
  return corpus;
}

let gazette;
function openGazette() {
  if (gazette) return gazette;
  const problem = lovtidendProblem();
  if (problem) {
    throw new Error(
      `${problem} Kjør verktøyet \`sync\` én gang — det henter årets kunngjøringer på noen sekunder. ` +
        "Sett `historikk: true` for årgangene tilbake til 2001 (70 MB, halvannet minutt, ~260 MB på disk).",
    );
  }
  gazette = new Lovtidend();
  return gazette;
}

/** Fjerner tomme felt rekursivt, slik at svaret ikke fylles av null. */
function compact(obj) {
  if (Array.isArray(obj)) {
    const arr = obj.map(compact).filter((v) => v !== undefined);
    return arr.length ? arr : undefined;
  }
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const c = compact(v);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return obj === null || obj === "" || obj === undefined ? undefined : obj;
}

const asText = (v) => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }],
});
const asError = (m) => ({ content: [{ type: "text", text: m }], isError: true });
const guard = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    return asError(`Feil: ${err.message}`);
  }
};

const label = (d) => d.short_title || d.title || d.doc_id || d.id;
const docRef = (d) => ({
  docId: d.doc_id ?? d.id,
  navn: label(d),
  type: d.type,
  legacyId: d.legacy_id ?? undefined,
});

// ------------------------------------------------------------------ Søk

server.registerTool(
  "search",
  {
    title: "Søk i lover og forskrifter",
    description: [
      "Fulltekstsøk i alle paragrafer. Hvert treff er én paragraf med utdrag der",
      "søkeordene er markert med «hermetegn».",
      "",
      "Skriv søkeordene, ikke spørsmålet: «oppsigelse prøvetid» slår «kan jeg sies opp",
      "i prøvetiden?». Bøyning tas av seg selv — «oppsigelse» treffer «oppsigelsen»",
      "og «oppsigelsesvern» — så skriv grunnformen og la endelsen ligge.",
      "",
      "Vil du ha ordet i nøyaktig den formen du skrev, sett det i anførselstegn:",
      "«\"oppsigelse\"» treffer ikke «oppsigelsen». Det samme gjelder flerordsfraser",
      "(«\"tvungent psykisk helsevern\"»), som må stå ord for ord.",
      "",
      "`scope: \"titler\"` søker i dokumenttitler i stedet — bruk det til «hvilke",
      "forskrifter finnes om X». `docId` avgrenser søket til én lov.",
    ].join("\n"),
    inputSchema: {
      query: z.string().min(1).describe('Søkeord, f.eks. "oppsigelse prøvetid" eller "\\"tvungent psykisk helsevern\\""'),
      scope: z.enum(["tekst", "titler"]).default("tekst").describe("Søk i paragraftekst eller i dokumenttitler."),
      type: z.enum(DOC_TYPES).optional().describe("Begrens til én dokumenttype."),
      ministry: z.string().optional().describe('Delstreng av departementsnavnet, f.eks. "Justis".'),
      docId: z.string().optional().describe("Søk bare i dette dokumentet (dokid fra et tidligere treff)."),
      limit: z.number().int().min(1).max(50).default(10),
      offset: z.number().int().min(0).default(0),
    },
  },
  guard(async ({ query, scope, type, ministry, docId, limit, offset }) => {
    const c = open();
    if (scope === "titler") {
      const { total, hits } = c.searchTitles({ query, type, limit });
      return asText({
        total,
        treff: hits.map((h) => ({
          ...docRef(h),
          tittel: h.title,
          departement: h.ministry ?? undefined,
          ikrafttredelse: h.date_in_force ?? undefined,
          paragrafer: h.article_count,
        })),
      });
    }
    const { total, hits } = c.searchArticles({ query, type, ministry, docId, limit, offset });
    return asText({
      total,
      vist: hits.length,
      treff: hits.map((h) => ({
        ...docRef(h),
        paragraf: h.name,
        overskrift: h.heading ?? undefined,
        kapittel: h.chapter ?? undefined,
        utdrag: h.snippet,
      })),
      hint: total > hits.length + offset ? "Flere treff finnes — bruk offset for å bla." : undefined,
    });
  }),
);

// ------------------------------------------------------------- Dokument

server.registerTool(
  "get_document",
  {
    title: "Hent en lov eller forskrift",
    description: [
      "Slå opp et dokument på vanlig navn («arbeidsmiljøloven», «plan- og bygningsloven»),",
      "på dokid («NL/lov/2005-06-17-62») eller på den gamle koden («LOV-2005-06-17-62»).",
      "",
      "Gir metadata — departement, ikrafttredelse, siste endring, hjemmel — og",
      "innholdsfortegnelsen med alle paragrafer. Sett `includeText` for hele teksten;",
      "for store lover blir den avkortet, og da er `search` med `docId` bedre.",
    ].join("\n"),
    inputSchema: {
      reference: z.string().min(2).describe("Navn, dokid eller LOV-/FOR-kode."),
      type: z.enum(DOC_TYPES).optional().describe("Begrens oppslaget til én dokumenttype."),
      includeText: z.boolean().default(false).describe("Ta med hele lovteksten."),
      maxChars: z.number().int().min(2000).max(200_000).default(60_000).describe("Tak for teksten."),
    },
  },
  guard(async ({ reference, type, includeText, maxChars }) => {
    const c = open();
    const matches = c.resolve(reference, { type });
    if (!matches.length) return asError(`Fant ingen dokumenter som matcher «${reference}».`);
    const d = matches[0];
    const arts = c.articles(d.id);
    const out = {
      ...docRef(d),
      tittel: d.title,
      departement: d.ministry ?? undefined,
      rettsområde: d.legal_areas ?? undefined,
      ikrafttredelse: d.date_in_force ?? undefined,
      sisteEndringIKraft: d.last_change_in_force ?? undefined,
      sistEndretVed: d.last_changed_by ?? undefined,
      kunngjortI: d.published_in ?? undefined,
      gjelderFor: d.applies_to ?? undefined,
      hjemmel: d.based_on ? d.based_on.split(" ").slice(0, 12) : undefined,
      språk: d.language,
      url: d.url ?? undefined,
      antallParagrafer: arts.length,
      // Overskriften inneholder som regel paragrafnummeret allerede.
      innhold: arts.map((a) =>
        [a.chapter, a.heading?.startsWith(a.name.replace(/§/, "§ ")) || a.heading?.startsWith(a.name) ? a.heading : [a.name, a.heading].filter(Boolean).join(" ")]
          .filter(Boolean)
          .join(" · "),
      ),
      andreTreff: matches.slice(1, 4).map((m) => `${label(m)} (${m.type}, ${m.id})`),
    };
    if (includeText) {
      const { text, truncatedAt } = c.fullText(d.id, maxChars);
      out.tekst = text;
      if (truncatedAt) out.avkortetVed = `${truncatedAt} — bruk search med docId for resten`;
    }
    return asText(out);
  }),
);

// ------------------------------------------------------------- Paragraf

server.registerTool(
  "get_article",
  {
    title: "Hent én paragraf ordrett",
    description: [
      "Hele teksten i én paragraf, pluss endringshistorikken for den.",
      "Bruk dette før du siterer — søketreffene er utdrag med utelatelser.",
      "`reference` tolkes som i get_document, `article` skrives «§ 14-9» eller «§14-9».",
    ].join(" "),
    inputSchema: {
      reference: z.string().min(2).describe("Lov eller forskrift — navn, dokid eller LOV-kode."),
      article: z.string().min(1).describe('Paragrafnummer, f.eks. "§ 100" eller "14-9".'),
      context: z.boolean().default(false).describe("Ta med paragrafen før og etter."),
    },
  },
  guard(async ({ reference, article, context }) => {
    const c = open();
    const matches = c.resolve(reference);
    if (!matches.length) return asError(`Fant ingen dokumenter som matcher «${reference}».`);
    const d = matches[0];
    const name = article.trim().replace(/^§\s*/, "§");
    const a = c.article(d.id, name.startsWith("§") ? name : `§${name}`);
    if (!a) {
      const names = c.articles(d.id).map((x) => x.name).slice(0, 40);
      return asError(`Fant ikke «${article}» i ${label(d)}. Paragrafer der: ${names.join(", ")}${names.length === 40 ? " …" : ""}`);
    }
    const out = {
      ...docRef(d),
      tittel: d.title,
      paragraf: a.name,
      overskrift: a.heading ?? undefined,
      kapittel: a.chapter ?? undefined,
      tekst: a.text,
      endringer: a.changes ?? undefined,
      url: a.lovdata_url ? `https://lovdata.no/dokument/${a.lovdata_url}` : d.url,
    };
    if (context) {
      const all = c.articles(d.id);
      const i = all.findIndex((x) => x.name === a.name);
      out.naboer = [all[i - 1], all[i + 1]].filter(Boolean).map((x) => `${x.name} ${x.heading ?? ""}`.trim());
    }
    return asText(out);
  }),
);

// -------------------------------------------------------------- Bla og se

server.registerTool(
  "list_documents",
  {
    title: "Bla i korpuset",
    description: [
      "List dokumenter filtrert på type, departement eller endringsdato, sortert med",
      "sist endrede først. Bruk `since` for «hva er nytt i regelverket siden ...».",
      "Uten filtre svarer verktøyet med hvilke departementer som finnes, og hvor mye",
      "hvert av dem har publisert.",
    ].join(" "),
    inputSchema: {
      type: z.enum(DOC_TYPES).optional(),
      ministry: z.string().optional().describe('Delstreng av departementsnavn, f.eks. "Helse".'),
      since: z.string().regex(/^\d{4}(-\d{2}){0,2}$/).optional().describe('Ikrafttredelse eller endring fra og med, f.eks. "2026-01".'),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
    },
  },
  guard(async ({ type, ministry, since, limit, offset }) => {
    const c = open();
    if (!type && !ministry && !since) {
      return asText({
        departementer: c.ministries().map((m) => `${m.ministry} (${m.n})`),
        hint: "Filtrer med type, ministry eller since for en dokumentliste.",
      });
    }
    const { total, rows } = c.list({ type, ministry, since: since ? `${since}-01`.slice(0, 10) : undefined, limit, offset });
    return asText({
      total,
      dokumenter: rows.map((r) => ({
        ...docRef(r),
        tittel: r.title,
        departement: r.ministry ?? undefined,
        ikrafttredelse: r.date_in_force ?? undefined,
        sisteEndring: r.last_change_in_force ?? undefined,
        paragrafer: r.article_count,
      })),
    });
  }),
);

// ---------------------------------------------------------------- Drift

server.registerTool(
  "status",
  {
    title: "Status for den lokale indeksen",
    description:
      "Når korpuset sist ble hentet, hvor mange dokumenter og paragrafer det inneholder, og fordelingen på type. Sjekk denne når ferskhet betyr noe.",
    inputSchema: {},
  },
  guard(async () => {
    const age = (iso) => (iso ? `${((Date.now() - Date.parse(iso)) / 86_400_000).toFixed(1)} døgn` : undefined);
    const ltProblem = lovtidendProblem();
    let lovtidend;
    if (ltProblem) {
      lovtidend = {
        klar: false,
        problem: ltProblem,
        hint: "Kjør sync. Legg til historikk: true for årgangene tilbake til 2001.",
      };
    } else {
      const s = openGazette().status();
      lovtidend = {
        indeks: lovtidendPath(),
        hentet: s.syncedAt,
        alder: age(s.syncedAt),
        kunngjøringer: s.count,
        årganger: s.years,
        historikk: s.history ? "2001 og framover er hentet" : "bare inneværende år — kjør sync med historikk: true for 2001–i fjor",
        fordeling: s.byType,
      };
    }

    const problem = indexProblem();
    if (problem) return asText({ indeks: dbPath(), klar: false, problem, hint: "Kjør sync først.", lovtidend });
    const c = open();
    const s = c.status();
    const forarbeider = c.casesStatus();
    const days = s.syncedAt ? (Date.now() - Date.parse(s.syncedAt)) / 86_400_000 : undefined;
    return asText({
      indeks: dbPath(),
      hentet: s.syncedAt,
      alder: age(s.syncedAt),
      dokumenter: s.documents,
      paragrafer: s.articles,
      fordeling: s.byType,
      forarbeider,
      lovtidend,
      merknad: days > 7 ? "Lovdata legger ut nye datapakker hver natt — vurder å kjøre sync." : undefined,
    });
  }),
);

server.registerTool(
  "sync",
  {
    title: "Hent ferske datapakker fra Lovdata",
    description: [
      "Laster ned Lovdata-datasettene på nytt og bygger lovindeksen om fra bunnen,",
      "friskner opp forarbeidene fra Stortinget og henter årets Lovtidend. Tar rundt",
      "tre minutter. Indeksen oppdateres bare når sync kjøres — av en timer der det er",
      "satt opp, ellers ikke. `status` viser hvor gammel den er.",
      "",
      "`historikk: true` tar med Lovtidend tilbake til 2001: 70 MB ekstra nedlasting,",
      "halvannet minutt og rundt 260 MB på disk. Er den først hentet, holdes den",
      "oppdatert av hver vanlige sync — uten nedlasting når Lovdata ikke har endret den.",
    ].join("\n"),
    inputSchema: {
      historikk: z
        .boolean()
        .optional()
        .describe("Ta med Lovtidend 2001–i fjor. Uten verdi: bare hvis historikken er hentet før."),
    },
  },
  guard(async ({ historikk }) => {
    if (corpus) {
      corpus.close();
      corpus = undefined;
    }
    if (gazette) {
      gazette.close();
      gazette = undefined;
    }
    const lines = [];
    const result = await sync({ log: (m) => lines.push(m) });
    const forarbeider = await syncStortinget({ log: (m) => lines.push(m) });
    // Lovtidend ligger i sin egen fil, så en feil her rører ikke lovindeksen —
    // da er det bedre å melde fra enn å la hele synken se mislykket ut.
    let lovtidend;
    try {
      lovtidend = await syncLovtidend({ log: (m) => lines.push(m), history: historikk });
    } catch (err) {
      lovtidend = { feil: err.message, merknad: "Lovindeksen og forarbeidene ble oppdatert som normalt." };
    }
    return asText({ ...result, forarbeider, lovtidend, logg: lines });
  }),
);

// --------------------------------------------------------- Rettspraksis

const ARTICLE_HINT = [
  "EMK-artikkel som tall: 2 liv, 3 tortur, 5 frihet, 6 rettferdig rettergang,",
  "8 privatliv og familieliv, 9 tros- og livssynsfrihet, 10 ytringsfrihet,",
  "11 forsamlings- og foreningsfrihet, 13 effektivt rettsmiddel, 14 diskriminering.",
  "«P1-1» er eiendomsvernet i første tilleggsprotokoll.",
].join(" ");

server.registerTool(
  "caselaw_search",
  {
    title: "Søk i EMD-praksis",
    description: [
      "Søk i avgjørelser fra Den europeiske menneskerettsdomstolen via Europarådets",
      "åpne HUDOC-base. Standard er dommer mot Norge, på engelsk.",
      "",
      "Dette er ikke norsk rettspraksis. Høyesterett og lagmannsrettene finnes ikke i",
      "noen fri, maskinlesbar kilde — Lovdata Pro tar betalt, og domstol.no sperrer",
      "sitt API i robots.txt. EMD-praksis er derimot åpent publisert, og er samtidig",
      "en del av norsk rett gjennom menneskerettsloven §§ 2 og 3.",
      "",
      "Sett `respondent` til en annen ISO-kode for saker mot andre stater, eller til",
      "null for alle. `importance: 2` gir bare de prinsipielle avgjørelsene.",
      "",
      "Leter du etter én bestemt sak, bruk `caseName` eller `appNo`. `text` søker i",
      "hele dommens tekst og treffer derfor alle avgjørelser som SITERER saken —",
      "nyttig for å se hvordan en dom er fulgt opp, men feil verktøy for å finne den.",
    ].join("\n"),
    inputSchema: {
      text: z.string().optional().describe('Fritekst, f.eks. "child welfare" eller "care order".'),
      respondent: z
        .string()
        .nullable()
        .default("NOR")
        .describe("Innklaget stat som ISO-kode. NOR er standard; null søker i alle stater."),
      article: z.string().optional().describe(ARTICLE_HINT),
      importance: z
        .number()
        .int()
        .min(1)
        .max(4)
        .optional()
        .describe("Ta bare med avgjørelser på dette viktighetsnivået eller høyere. 1 = Key case."),
      branch: z
        .enum(["GRANDCHAMBER", "CHAMBER", "COMMITTEE"])
        .optional()
        .describe("Storkammer, kammer eller komité."),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Fra og med denne datoen."),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Til og med denne datoen."),
      caseName: z
        .string()
        .optional()
        .describe('Søk i saksnavnet, f.eks. "Strand Lobben". Bruk dette når du leter etter én bestemt sak — fritekst i `text` treffer alle dommer som NEVNER den.'),
      appNo: z.string().optional().describe('Klagenummer, f.eks. "37283/13".'),
      includeDecisions: z
        .boolean()
        .default(false)
        .describe("Ta med avvisningsavgjørelser og annet enn dommer."),
      limit: z.number().int().min(1).max(50).default(10),
      offset: z.number().int().min(0).default(0),
    },
  },
  guard(async ({ text, caseName, appNo, respondent, article, importance, branch, from, to, includeDecisions, limit, offset }) => {
    const r = await searchCaselaw({
      // null må sendes videre som null: gjøres den om til undefined, slår
      // standardverdien «NOR» inn igjen og «alle stater» blir stille til Norge.
      text, caseName, appNo, respondent, article, importance, branch, from, to,
      onlyJudgments: !includeDecisions, limit, offset,
    });
    return asText({
      total: r.total,
      vist: r.hits.length,
      avgjørelser: r.hits,
      hint: r.hits.length
        ? "Bruk caselaw_get med itemid for hele dommen."
        : "Ingen treff. Prøv uten `text`, eller løsne på artikkel og viktighet.",
    });
  }),
);

server.registerTool(
  "caselaw_get",
  {
    title: "Hent en EMD-dom i fulltekst",
    description: [
      "Hele teksten i én EMD-avgjørelse, hentet på `itemid` fra et søketreff.",
      "Dommene er lange — ofte 30 000 til 300 000 tegn — så teksten avkortes.",
      "Sett `section` for å hoppe til den delen du trenger: THE FACTS, THE LAW,",
      "eller FOR THESE REASONS for domsslutningen.",
    ].join(" "),
    inputSchema: {
      itemid: z.string().min(3).describe("HUDOC-id fra et søketreff, f.eks. 001-250427."),
      section: z
        .string()
        .optional()
        .describe('Hopp til første forekomst av denne teksten, f.eks. "THE LAW" eller "FOR THESE REASONS".'),
      maxChars: z.number().int().min(1000).max(120_000).default(30_000),
    },
  },
  guard(async ({ itemid, section, maxChars }) => {
    const doc = await getCaselaw(itemid);
    let text = doc.text;
    let from = 0;
    if (section) {
      // Ikke toUpperCase().indexOf(): enkelte tegn (ß, ﬁ) blir lengre i versaler,
      // og da peker indeksen inn i feil posisjon i originalteksten.
      const needle = new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const found = needle.exec(text.slice(200));
      const i = found ? found.index + 200 : -1;
      if (i === -1) {
        return asError(
          `Fant ikke «${section}» i dommen. Overskriftene i teksten er: ${
            [...text.matchAll(/^[A-Z][A-Z .,'()-]{6,60}$/gm)].map((m) => m[0].trim()).slice(0, 12).join(" | ")
          }`,
        );
      }
      from = i;
      text = text.slice(i);
    }
    const truncated = text.length > maxChars;
    return asText({
      itemid,
      url: doc.url,
      pdf: doc.pdf,
      totaltAntallTegn: doc.text.length,
      fraPosisjon: from || undefined,
      avkortet: truncated || undefined,
      tekst: truncated ? `${text.slice(0, maxChars)}\n\n[… avkortet, øk maxChars eller bruk section]` : text,
    });
  }),
);

// ---------------------------------------------------------- Forarbeider

server.registerTool(
  "preparatory_search",
  {
    title: "Søk i forarbeider",
    description: [
      "Søk i Stortingets saker fra 1986 til i dag: proposisjoner, innstillinger,",
      "stortingsmeldinger og representantforslag. Dette er forarbeidene — der",
      "lovgivers mening står, og en tung rettskilde når lovteksten er uklar.",
      "",
      "Søket går mot sakstitler, henvisninger og emneord, ikke mot dokumentteksten:",
      "Stortingets API har ingen fritekstsøk i selve dokumentene. Søk derfor på det",
      "loven eller saken heter, ikke på en formulering du forventer å finne inni.",
      "",
      "Henvisningen i treffet («Prop. 12 L (2024–2025)») er det du siterer, og det",
      "`preparatory_get` bruker for å hente teksten.",
    ].join("\n"),
    inputSchema: {
      query: z.string().min(2).describe('Stikkord fra sakstittelen, f.eks. "arbeidsmiljøloven prøvetid".'),
      kind: z
        .enum(["Lovproposisjon", "Proposisjon", "Innstilling", "Stortingsmelding", "Representantforslag", "Dokumentserien"])
        .optional()
        .describe("Begrens til én dokumenttype. Lovproposisjon (Prop. L) er der lovendringer begrunnes."),
      session: z.string().regex(/^\d{4}-\d{2,4}$/).optional().describe('Stortingssesjon, f.eks. "2024-2025".'),
      limit: z.number().int().min(1).max(50).default(10),
      offset: z.number().int().min(0).default(0),
    },
  },
  guard(async ({ query, kind, session, limit, offset }) => {
    const c = open();
    const { total, hits } = c.searchCases({ query, kind, session, limit, offset });
    return asText({
      total,
      vist: hits.length,
      saker: hits.map((h) =>
        compact({
          sakId: h.id,
          sesjon: h.session,
          henvisning: h.reference || undefined,
          dokumenttype: h.kind ?? undefined,
          tittel: h.short_title || h.title,
          komite: h.committee ?? undefined,
          emner: h.topics ?? undefined,
        }),
      ),
      hint: hits.length
        ? "Bruk preparatory_get med sakId for saksgang, vedtak og dokumenttekst."
        : // Søket går mot titler, ikke dokumenttekst — flere ord blir fort for smalt.
          `Ingen treff. Søket dekker sakstitler og emneord, ikke dokumentteksten, og alle ordene må stå i samme tittel. Prøv færre ord — «${
            query.split(/\s+/)[0]
          }» alene.`,
    });
  }),
);

server.registerTool(
  "preparatory_get",
  {
    title: "Hent en stortingssak med dokumenttekst",
    description: [
      "Detaljer om én sak: emner, komité, saksgang, vedtak og lenker til dokumentene.",
      "Sett `includeText` for å hente selve teksten i innstillingen eller proposisjonen",
      "— den er ofte lang, så den avkortes.",
    ].join(" "),
    inputSchema: {
      caseId: z.string().min(1).describe("sakId fra et søketreff."),
      includeText: z.boolean().default(false).describe("Hent dokumentteksten, ikke bare metadataene."),
      maxChars: z.number().int().min(1000).max(150_000).default(30_000),
    },
  },
  guard(async ({ caseId, includeText, maxChars }) => {
    const sak = await fetchCase(caseId);
    const out = compact({
      sakId: sak.id,
      sesjon: sak.session,
      henvisning: sak.reference,
      dokumenttype: sak.kind,
      tittel: sak.shortTitle || sak.title,
      komite: sak.committee,
      ferdigbehandlet: sak.finished,
      emner: sak.topics,
      stikkord: sak.keywords,
      saksgang: sak.steps,
      vedtak: sak.decision,
      innstilling: sak.recommendation,
      dokumenter: sak.documents,
      url: sak.url,
    });
    if (includeText) {
      // Publikasjons-IDen utledes av henvisningen; en sak kan ha flere referanser.
      const refs = (sak.reference ?? "").split(",").map((r) => r.trim()).filter(Boolean);
      for (const ref of refs) {
        const pid = publicationId(ref, sak.session);
        if (!pid) continue;
        try {
          const pub = await fetchPublication(pid);
          if (!pub.text) continue;
          out.tekstFra = ref;
          out.totaltAntallTegn = pub.text.length;
          out.tekst =
            pub.text.length > maxChars ? `${pub.text.slice(0, maxChars)}\n\n[… avkortet]` : pub.text;
          break;
        } catch {
          // Ikke alle henvisninger har en publikasjon i eksporten; prøv neste.
        }
      }
      if (!out.tekst) out.merknad = `Fant ingen dokumenttekst for «${sak.reference}». Bruk lenkene i dokumenter.`;
    }
    return asText(out);
  }),
);

// ------------------------------------------------------------ Lovtidend

/**
 * Lovtidend lenker med refid («lov/2005-06-17-62»). Brukeren skriver som
 * regel navnet, så navn slås opp i lovindeksen først.
 */
function asRefid(value) {
  const direct = toRefid(value);
  if (direct) return { refid: direct };
  let corpusRef;
  try {
    corpusRef = open();
  } catch (err) {
    // Navneoppslag krever lovindeksen; koden krever den ikke.
    throw new Error(`«${value}» må slås opp i lovindeksen, og den er ikke klar. ${err.message} Koden virker uansett, f.eks. «LOV-1988-04-29-21».`);
  }
  const matches = corpusRef.resolve(value);
  if (!matches.length) return {};
  return { refid: toRefid(matches[0].id), tolket: `${label(matches[0])} (${matches[0].legacy_id ?? matches[0].id})` };
}

/** Navnene på dokumentene en kunngjøring peker på, når lovindeksen har dem. */
function namesFor(refids) {
  const names = new Map();
  let corpusRef;
  try {
    corpusRef = open();
  } catch {
    return names;
  }
  for (const refid of new Set(refids)) {
    const doc = corpusRef.byLegacy(toLegacyId(refid));
    if (doc) names.set(refid, label(doc));
  }
  return names;
}

/**
 * «lov/2005-06-17-62» + [§14-5, §15-6] → «arbeidsmiljøloven §14-5, §15-6».
 * En statsbudsjettforskrift kan endre hundre dokumenter; da kortes lista ned.
 */
function describeLinks(links, names, { maxTargets = 12, maxArticles = 15 } = {}) {
  const byTarget = new Map();
  for (const l of links) {
    const list = byTarget.get(l.target) ?? [];
    if (l.article) list.push(l.article);
    byTarget.set(l.target, list);
  }
  const out = [...byTarget].slice(0, maxTargets).map(([target, articles]) => {
    const shown = articles.slice(0, maxArticles).join(", ");
    const more = articles.length > maxArticles ? ` … (+${articles.length - maxArticles})` : "";
    return `${names.get(target) ?? toLegacyId(target) ?? target}${articles.length ? ` ${shown}${more}` : ""}`;
  });
  if (byTarget.size > maxTargets) out.push(`… og ${byTarget.size - maxTargets} dokumenter til`);
  return out;
}

/** Enkelte kunngjøringstitler lister opp alle forskriftene de endrer. */
const shorten = (s, max = 180) => (s && s.length > max ? `${s.slice(0, max).trimEnd()} …` : s);

const gazetteRef = (h) => ({
  id: h.id,
  kode: h.legacy_id ?? undefined,
  type: h.type,
  tittel: shorten(h.short_title || h.title),
  kunngjort: h.published_date ?? undefined,
  iKraft: h.in_force ?? undefined,
  departement: h.ministry ?? undefined,
  etat: h.agency ?? undefined,
  url: `https://lovdata.no/dokument/${h.id}`,
});

server.registerTool(
  "lovtidend_search",
  {
    title: "Søk i Norsk Lovtidend",
    description: [
      "Kunngjøringene i Norsk Lovtidend avd. I: hver nye lov og forskrift, og hver",
      "endring i dem, slik den ble kunngjort — med dato, departement, ikrafttredelse",
      "og hvilke bestemmelser som ble endret. Det er her svaret står på «hva ble",
      "endret i ferieloven i 2024», «hvilken lov endret arbeidsmiljøloven § 15-6» og",
      "«hva har Landbruks- og matdepartementet kunngjort i år».",
      "",
      "MERK: dette er endringene, ikke lovteksten slik den lød på en gitt dato.",
      "Historiske versjoner av en lov finnes bare i Lovdata Pro. Gjeldende tekst",
      "henter du med `get_article`, som også lister hvilke endringslover som har",
      "endret paragrafen.",
      "",
      "`endrer` tar navnet på loven eller forskriften som ble endret",
      "(«ferieloven», «LOV-2005-06-17-62»), `paragraf` snevrer inn til én",
      "bestemmelse. Uten `query` er svaret en ren liste, sist kunngjort først.",
      "",
      "Årganger før inneværende år krever at `sync` er kjørt med `historikk: true`;",
      "`status` viser hvilke år som er hentet.",
    ].join("\n"),
    inputSchema: {
      query: z.string().optional().describe("Søkeord i kunngjøringsteksten. Kan sløyfes når filtrene er nok."),
      endrer: z
        .string()
        .optional()
        .describe('Dokumentet som ble endret — navn, dokid eller kode, f.eks. "ferieloven".'),
      paragraf: z.string().optional().describe('Bare endringer i denne bestemmelsen, f.eks. "§ 15-6". Krever `endrer`.'),
      hjemmel: z
        .string()
        .optional()
        .describe('Bare kunngjøringer gitt med hjemmel i dette dokumentet, f.eks. "matloven".'),
      type: z.enum(["lov", "forskrift"]).optional(),
      ministry: z.string().optional().describe('Delstreng av departement eller etat, f.eks. "Landbruks".'),
      from: z.string().optional().describe('Kunngjort fra og med, "2024", "2024-03" eller "2024-03-01".'),
      to: z.string().optional().describe("Kunngjort til og med, samme former."),
      inForceFrom: z.string().optional().describe("Trådte i kraft fra og med. Mange har ingen dato («Kongen bestemmer»)."),
      inForceTo: z.string().optional().describe("Trådte i kraft til og med."),
      limit: z.number().int().min(1).max(50).default(10),
      offset: z.number().int().min(0).default(0),
    },
  },
  guard(async ({ query, endrer, paragraf, hjemmel, type, ministry, from, to, inForceFrom, inForceTo, limit, offset }) => {
    const lt = openGazette();
    const tolket = {};
    let endrerRef;
    let hjemmelRef;
    if (endrer) {
      const r = asRefid(endrer);
      if (!r.refid) return asError(`Fant ingen lov eller forskrift som matcher «${endrer}».`);
      endrerRef = r.refid;
      if (r.tolket) tolket.endrer = r.tolket;
    }
    if (hjemmel) {
      const r = asRefid(hjemmel);
      if (!r.refid) return asError(`Fant ingen lov eller forskrift som matcher «${hjemmel}».`);
      hjemmelRef = r.refid;
      if (r.tolket) tolket.hjemmel = r.tolket;
    }
    if (paragraf && !endrerRef) return asError("`paragraf` må kombineres med `endrer` — ellers vet vi ikke hvilken lovs paragraf det gjelder.");

    const { total, hits } = lt.search({
      query,
      endrer: endrerRef,
      article: paragraf ? normalizeArticle(paragraf) : undefined,
      hjemmel: hjemmelRef,
      type,
      ministry,
      from: periodStart(from),
      to: periodEnd(to),
      inForceFrom: periodStart(inForceFrom),
      inForceTo: periodEnd(inForceTo),
      limit,
      offset,
    });
    const names = namesFor(hits.flatMap((h) => h.changes.map((c) => c.target)));
    return asText(
      compact({
        total,
        vist: hits.length,
        tolket: Object.keys(tolket).length ? tolket : undefined,
        kunngjøringer: hits.map((h) => ({
          ...gazetteRef(h),
          endrer: describeLinks(h.changes, names),
          utdrag: query ? h.snippet : undefined,
        })),
        hint:
          hits.length === 0
            ? paragraf
              ? "Ingen treff. Paragrafene leses ut av teksten i eldre kunngjøringer og kan mangle — prøv uten `paragraf`."
              : ministry
                ? `Ingen treff. Departementene skrives fullt ut: ${lt.ministries().join(", ")}.`
                : "Ingen treff. Sjekk `status` for hvilke årganger som er hentet, eller løsne på filtrene."
            : total > hits.length + offset
              ? "Flere treff finnes — bruk offset for å bla."
              : undefined,
      }),
    );
  }),
);

server.registerTool(
  "lovtidend_get",
  {
    title: "Hent én kunngjøring fra Lovtidend",
    description: [
      "Hele kunngjøringsteksten — altså endringsloven eller endringsforskriften slik",
      "den ble vedtatt, med nøyaktig ordlyd på hver endring («§ 15-6 tredje ledd skal",
      "lyde: …»), hvilke dokumenter den endrer, hjemmel, og forarbeidene den bygger på",
      "(Prop. og Innst. står i feltet `annet`).",
      "",
      "Står det «Kongen bestemmer» om ikrafttredelsen, er datoen satt senere ved",
      "kgl.res.; de kunngjøringene listes i `ikraftsattVed`.",
      "",
      "Referansen er koden («LOV-2023-12-15-88»), dokid eller refid fra et søketreff.",
    ].join("\n"),
    inputSchema: {
      reference: z.string().min(3).describe('F.eks. "LOV-2023-12-15-88" eller "LTI/lov/2023-12-15-88".'),
      maxChars: z.number().int().min(1000).max(200_000).default(40_000),
    },
  },
  guard(async ({ reference, maxChars }) => {
    const lt = openGazette();
    const doc = lt.get(reference);
    if (!doc) {
      return asError(
        `Fant ingen kunngjøring som matcher «${reference}». Kunngjøringer slås opp på kode (LOV-2023-12-15-88), ` +
          "dokid eller refid — bruk lovtidend_search for å finne den.",
      );
    }
    const names = namesFor([...doc.changes, ...doc.basedOn].map((l) => l.target));
    const truncated = doc.text.length > maxChars;
    return asText(
      compact({
        ...gazetteRef(doc),
        fullTittel: doc.title,
        iKraftDato: doc.in_force_date ?? undefined,
        kunngjortTidspunkt: doc.published ?? undefined,
        journalnummer: doc.journal_number ?? undefined,
        rettsområde: doc.legal_areas ?? undefined,
        endrer: describeLinks(doc.changes, names),
        hjemmel: describeLinks(doc.basedOn, names),
        annet: doc.misc ?? undefined,
        ikraftsattVed: doc.inForceBy.map((r) => `${r.legacy_id ?? r.id}: i kraft ${r.in_force} (kunngjort ${r.published_date})`),
        totaltAntallTegn: doc.text.length,
        avkortet: truncated || undefined,
        tekst: truncated ? `${doc.text.slice(0, maxChars)}\n\n[… avkortet, øk maxChars]` : doc.text,
      }),
    );
  }),
);

// ------------------------------------------------------ Sivilombudet

server.registerTool(
  "ombudsman_search",
  {
    title: "Søk i Sivilombudets uttalelser",
    description: [
      "Fulltekstsøk i Sivilombudets uttalelser — omtrent 2 000 saker om forvaltningens",
      "saksbehandling. Tyngst på offentleglova, forvaltningsloven, innsyn, habilitet,",
      "taushetsplikt og begrunnelsesplikt.",
      "",
      "Uttalelsene er ikke bindende som en dom, men forvaltningen retter seg etter dem",
      "i praksis, og de er en etablert rettskilde i forvaltningsretten.",
      "Sett `type: \"besoksrapporter\"` for besøksrapportene fra forebyggingsenheten.",
    ].join("\n"),
    inputSchema: {
      query: z.string().min(2).describe('Søkeord, f.eks. "innsyn interne dokumenter".'),
      type: z.enum(["uttalelser", "besoksrapporter"]).default("uttalelser"),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Fra og med denne datoen."),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Til og med denne datoen."),
      limit: z.number().int().min(1).max(50).default(10),
      offset: z.number().int().min(0).default(0),
    },
  },
  guard(async ({ query, type, from, to, limit, offset }) =>
    asText(await searchOpinions({ query, type, from, to, limit, offset })),
  ),
);

server.registerTool(
  "ombudsman_get",
  {
    title: "Hent en uttalelse fra Sivilombudet",
    description:
      "Hele teksten i én uttalelse. Saksnummeret står i teksten som SOM-ÅÅÅÅ-NNNN, og det er slik uttalelsen siteres.",
    inputSchema: {
      id: z.number().int().describe("id fra et søketreff."),
      type: z.enum(["uttalelser", "besoksrapporter"]).default("uttalelser"),
      maxChars: z.number().int().min(1000).max(120_000).default(30_000),
    },
  },
  guard(async ({ id, type, maxChars }) => asText(await getOpinion(id, { type, maxChars }))),
);

await server.connect(new StdioServerTransport());
process.stderr.write(`mcp-lovdata kjører, indeks: ${dbPath()}\n`);
