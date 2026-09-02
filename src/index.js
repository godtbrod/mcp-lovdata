#!/usr/bin/env node
import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { dbPath } from "./db.js";
import { Corpus } from "./query.js";
import { sync } from "./corpus.js";

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
      "Sitér alltid paragrafen ordrett og oppgi lov og §-nummer. Datasettet oppdateres",
      "hver natt hos Lovdata; `status` viser hvor gammel den lokale indeksen er.",
    ].join("\n"),
  },
);

let corpus;
function open() {
  if (!existsSync(dbPath())) {
    throw new Error(
      `Ingen lokal indeks i ${dbPath()}. Kjør verktøyet \`sync\` (eller \`npm run sync\`) én gang først — det tar rundt tre minutter.`,
    );
  }
  corpus ??= new Corpus();
  return corpus;
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
      "i prøvetiden?». Sett en frase i anførselstegn for eksakt treff, og bruk * for",
      "trunkering («arbeidsgiv*»).",
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
      innhold: arts.map((a) => [a.chapter, a.name, a.heading].filter(Boolean).join(" · ")),
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
    if (!existsSync(dbPath())) return asText({ indeks: dbPath(), finnes: false, hint: "Kjør sync først." });
    const s = open().status();
    const days = s.syncedAt ? (Date.now() - Date.parse(s.syncedAt)) / 86_400_000 : undefined;
    return asText({
      indeks: dbPath(),
      hentet: s.syncedAt,
      alder: days === undefined ? undefined : `${days.toFixed(1)} døgn`,
      dokumenter: s.documents,
      paragrafer: s.articles,
      fordeling: s.byType,
      merknad: days > 7 ? "Lovdata legger ut nye datapakker hver natt — vurder å kjøre sync." : undefined,
    });
  }),
);

server.registerTool(
  "sync",
  {
    title: "Hent ferske datapakker fra Lovdata",
    description: [
      "Laster ned begge datasettene på nytt og bygger indeksen om fra bunnen.",
      "Tar rundt tre minutter og laster ned ~27 MB. Lovdata legger ut nye pakker hver",
      "natt, så det er sjelden nødvendig oftere enn ukentlig.",
    ].join(" "),
    inputSchema: {},
  },
  guard(async () => {
    if (corpus) {
      corpus.close();
      corpus = undefined;
    }
    const lines = [];
    const result = await sync({ log: (m) => lines.push(m) });
    return asText({ ...result, logg: lines });
  }),
);

await server.connect(new StdioServerTransport());
process.stderr.write(`mcp-lovdata kjører, indeks: ${dbPath()}\n`);
