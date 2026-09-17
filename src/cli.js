#!/usr/bin/env node
/**
 * Kommandolinje for de samme kildene som MCP-serveren tilbyr.
 * Importerer modulene direkte — ingen JSON-RPC-omvei — så lokale søk
 * svarer på millisekunder.
 */
import { dbPath, indexProblem, lovtidendProblem } from "./db.js";
import { Corpus, Lovtidend } from "./query.js";
import { normalizeArticle, periodEnd, periodStart, toLegacyId, toRefid } from "./lovtidend.js";

const ESC = "\u001b";
const isTty = process.stdout.isTTY;
const c = (code, s) => (isTty ? `${ESC}[${code}m${s}${ESC}[0m` : String(s));
const bold = (s) => c(1, s);
const dim = (s) => c(2, s);
const cyan = (s) => c(36, s);

const HELP = `${bold("lovdata")} — norsk rett fra kommandolinjen

${bold("Lovtekst")}
  lovdata sok <ord...>              søk i alle paragrafer
  lovdata lov <navn>                metadata og innholdsfortegnelse
  lovdata p <lov> <paragraf>        én paragraf ordrett
  lovdata titler <ord...>           søk i dokumenttitler

${bold("Lovtidend — endringer, med dato")}
  lovdata lt <ord...>               søk i kunngjøringene
  lovdata lt --endrer <lov>         alt som er endret i en lov
  lovdata kg <kode>                 hele kunngjøringen

${bold("Forarbeider")}
  lovdata fa <ord...>               søk i Stortingets saker
  lovdata sak <sakId>               saksgang, vedtak og dokumenter

${bold("Rettspraksis (EMD)")}
  lovdata emd <ord...>              søk i dommer, standard mot Norge
  lovdata dom <itemid>              hele dommen

${bold("Sivilombudet")}
  lovdata ombud <ord...>            søk i uttalelser
  lovdata uttalelse <id>            hele uttalelsen

${bold("Drift")}
  lovdata status                    indeksens alder og omfang
  lovdata sync                      hent ferske data og bygg om

${bold("Flagg")}
  --json          rå JSON i stedet for formatert tekst
  --limit N       antall treff (standard 10)
  --type X        lov | forskrift | delegering | instruks | stortingsvedtak
  --doc ID        avgrens sok til ett dokument
  --endrer LOV    lovtidend: dokumentet som ble endret
  --paragraf P    lovtidend: bare endringer i denne bestemmelsen
  --dep NAVN      lovtidend: delstreng av departement eller etat
  --fra ÅR        lovtidend: kunngjort fra og med (år, måned eller dato)
  --til ÅR        lovtidend: kunngjort til og med
  --historikk     sync: ta med Lovtidend 2001-i fjor (70 MB)
  --art N         EMK-artikkel for emd
  --stat KODE     ISO-kode for emd, «alle» for alle stater
  --sak NAVN      søk emd på saksnavn
  --viktighet N   1-4, 1 er de prinsipielle EMD-dommene
  --del TEKST     hopp til en seksjon i en dom, f.eks. "FOR THESE REASONS"
  --tekst         ta med dokumenttekst for en stortingssak
  --tegn N        tak for tekstlengde

${dim("Søkene er strenge OG: alle ordene må stå i samme paragraf, tittel,")}
${dim("uttalelse eller dom. Færre ord gir flere treff. Bøyning tas av seg selv —")}
${dim('"oppsigelse" treffer "oppsigelsen". "Ord i hermetegn" er eksakt form.')}`;

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else rest.push(a);
  }
  return { flags, args: rest };
}

const num = (v, fallback) => (v === undefined ? fallback : Number(v));

function requireIndex() {
  const problem = indexProblem();
  if (problem) {
    console.error(`lovdata: ${problem} Kjør «lovdata sync» først (~3 min).`);
    process.exit(2);
  }
  return new Corpus();
}

function requireLovtidend() {
  const problem = lovtidendProblem();
  if (problem) {
    console.error(`lovdata: ${problem} Kjør «lovdata sync» (legg til --historikk for 2001 og framover).`);
    process.exit(2);
  }
  return new Lovtidend();
}

/** Lovtidend lenker med refid; brukeren skriver lovens navn. */
function refidOf(value) {
  const direct = toRefid(String(value));
  if (direct) return direct;
  const matches = requireIndex().resolve(String(value));
  if (!matches.length) {
    console.error(`lovdata: fant ingen lov eller forskrift som matcher «${value}».`);
    process.exit(1);
  }
  console.error(dim(`(tolket «${value}» som ${matches[0].short_title || matches[0].title})`));
  return toRefid(matches[0].id);
}

/** Bryter tekst på ordgrense, med innrykk. */
function wrap(text, indent = "  ", width = (process.stdout.columns || 100) - 4) {
  return String(text)
    .split("\n")
    .flatMap((line) => {
      const out = [];
      let cur = "";
      for (const word of line.split(/\s+/)) {
        if (!word) continue;
        if (`${cur} ${word}`.trim().length > width) {
          out.push(cur.trim());
          cur = word;
        } else cur += ` ${word}`;
      }
      out.push(cur.trim());
      return out;
    })
    .map((l) => indent + l)
    .join("\n");
}

const out = (flags, data, render) => {
  if (flags.json) console.log(JSON.stringify(data, null, 1));
  else render();
};

const commands = {
  sok(args, flags) {
    const corpus = requireIndex();
    const { total, hits } = corpus.searchArticles({
      query: args.join(" "),
      type: flags.type,
      docId: flags.doc,
      limit: num(flags.limit, 10),
    });
    out(flags, { total, hits }, () => {
      if (!total) return console.log(dim('Ingen treff. Prøv færre ord, eller "frase i hermetegn".'));
      console.log(dim(`${total} treff`));
      for (const h of hits) {
        console.log(`\n${bold(h.short_title || h.title)} ${cyan(h.name)}${h.chapter ? dim(` · ${h.chapter}`) : ""}`);
        console.log(wrap(h.snippet.replace(/«([^»]*)»/g, (_, w) => c(33, w))));
        console.log(dim(`  ${h.doc_id}`));
      }
    });
  },

  titler(args, flags) {
    const corpus = requireIndex();
    const { total, hits } = corpus.searchTitles({
      query: args.join(" "),
      type: flags.type,
      limit: num(flags.limit, 10),
    });
    out(flags, { total, hits }, () => {
      console.log(dim(`${total} treff`));
      for (const h of hits) {
        console.log(`\n${bold(h.short_title || h.title)} ${dim(`(${h.type})`)}`);
        console.log(wrap(h.title));
        console.log(dim(`  ${h.legacy_id ?? h.doc_id} · ${h.article_count} paragrafer · ${h.ministry ?? "-"}`));
      }
    });
  },

  lov(args, flags) {
    const corpus = requireIndex();
    const matches = corpus.resolve(args.join(" "), { type: flags.type });
    if (!matches.length) {
      console.error("lovdata: fant ingen dokumenter.");
      process.exit(1);
    }
    const d = matches[0];
    const arts = corpus.articles(d.id);
    out(flags, { document: d, articles: arts }, () => {
      console.log(bold(d.title));
      console.log(dim(`${d.short_title ?? ""} · ${d.legacy_id ?? d.id}`));
      console.log(`\n${dim("Departement:")} ${d.ministry ?? "-"}`);
      console.log(`${dim("I kraft:    ")} ${d.date_in_force ?? "-"}`);
      console.log(`${dim("Sist endret:")} ${d.last_change_in_force ?? "-"}`);
      if (d.based_on) console.log(`${dim("Hjemmel:    ")} ${d.based_on.split(" ").slice(0, 6).join(", ")}`);
      console.log(`\n${dim(`${arts.length} paragrafer:`)}`);
      let chapter = null;
      for (const a of arts) {
        if (a.chapter && a.chapter !== chapter) {
          chapter = a.chapter;
          console.log(`\n  ${bold(chapter)}`);
        }
        console.log(`   ${cyan(a.name.padEnd(9))} ${a.heading ?? ""}`.trimEnd());
      }
      if (matches.length > 1) {
        console.log(dim(`\nAndre treff: ${matches.slice(1, 4).map((m) => m.short_title || m.id).join(" · ")}`));
      }
    });
  },

  p(args, flags) {
    const corpus = requireIndex();
    const article = args.pop();
    const matches = corpus.resolve(args.join(" "), { type: flags.type });
    if (!matches.length) {
      console.error("lovdata: fant ingen dokumenter.");
      process.exit(1);
    }
    const d = matches[0];
    const a = corpus.article(d.id, article.startsWith("§") ? article : `§${article}`);
    if (!a) {
      console.error(`lovdata: fant ikke ${article} i ${d.short_title ?? d.id}.`);
      console.error(dim(`Paragrafer: ${corpus.articles(d.id).map((x) => x.name).slice(0, 30).join(", ")}`));
      process.exit(1);
    }
    out(flags, { document: d, article: a }, () => {
      console.log(bold(`${d.short_title ?? d.title} ${a.name}`));
      if (a.heading) console.log(dim(a.heading));
      if (a.chapter) console.log(dim(a.chapter));
      console.log(`\n${wrap(a.text, "")}`);
      if (a.changes) console.log(`\n${dim(`Endringer: ${a.changes}`)}`);
      console.log(dim(`\nhttps://lovdata.no/dokument/${d.id}/${a.name}`));
    });
  },

  lt(args, flags) {
    const lovtidend = requireLovtidend();
    const endrer = flags.endrer ? refidOf(flags.endrer) : undefined;
    const { total, hits } = lovtidend.search({
      query: args.join(" ") || undefined,
      endrer,
      article: flags.paragraf ? normalizeArticle(String(flags.paragraf)) : undefined,
      type: flags.type,
      ministry: flags.dep,
      from: periodStart(flags.fra),
      to: periodEnd(flags.til),
      limit: num(flags.limit, 10),
    });
    out(flags, { total, hits }, () => {
      if (!total) return console.log(dim("Ingen treff. «lovdata status» viser hvilke årganger som er hentet."));
      console.log(dim(`${total} kunngjøringer`));
      for (const h of hits) {
        console.log(`\n${bold(h.short_title || h.title)} ${dim(`(${h.type})`)}`);
        console.log(dim(`  ${h.legacy_id} · kunngjort ${h.published_date} · i kraft ${h.in_force ?? "-"}`));
        if (h.ministry) console.log(dim(`  ${h.ministry}`));
        // Gruppert per dokument: en kunngjøring kan endre flere lover, og da
        // sier en lang rekke paragrafnumre uten eier ingenting.
        const perDoc = new Map();
        for (const change of h.changes) {
          if (!change.article) continue;
          perDoc.set(change.target, [...(perDoc.get(change.target) ?? []), change.article]);
        }
        for (const [target, articles] of [...perDoc].slice(0, 4)) {
          console.log(`  ${dim(toLegacyId(target) ?? target)} ${cyan(articles.slice(0, 12).join(", "))}`);
        }
        if (args.length) console.log(wrap(h.snippet.replace(/«([^»]*)»/g, (_, w) => c(33, w))));
      }
    });
  },

  kg(args, flags) {
    const lovtidend = requireLovtidend();
    const doc = lovtidend.get(args.join(" "));
    if (!doc) {
      console.error("lovdata: fant ingen kunngjøring med den koden.");
      process.exit(1);
    }
    out(flags, doc, () => {
      console.log(bold(doc.title));
      console.log(dim(`${doc.legacy_id} · ${doc.ministry ?? "-"}`));
      console.log(`\n${dim("Kunngjort:")} ${doc.published ?? "-"}`);
      console.log(`${dim("I kraft:  ")} ${doc.in_force ?? "-"}`);
      for (const r of doc.inForceBy) console.log(dim(`  satt i kraft ${r.in_force} ved ${r.legacy_id}`));
      if (doc.misc) console.log(`\n${wrap(doc.misc, "")}`);
      const endrer = doc.changes.filter((x) => x.article === null).map((x) => toLegacyId(x.target) ?? x.target);
      if (endrer.length) console.log(`\n${dim("Endrer:")} ${endrer.join(", ")}`);
      const cap = num(flags.tegn, 8000);
      console.log(`\n${wrap(doc.text.slice(0, cap), "")}`);
      if (doc.text.length > cap) console.log(dim(`\n[… ${doc.text.length} tegn totalt, bruk --tegn N]`));
      console.log(dim(`\nhttps://lovdata.no/dokument/${doc.id}`));
    });
  },

  fa(args, flags) {
    const corpus = requireIndex();
    const { total, hits } = corpus.searchCases({
      query: args.join(" "),
      kind: flags.type,
      session: flags.sesjon,
      limit: num(flags.limit, 10),
    });
    out(flags, { total, hits }, () => {
      if (!total) return console.log(dim("Ingen treff. Søket dekker bare sakstitler — prøv ett ord."));
      console.log(dim(`${total} saker`));
      for (const h of hits) {
        console.log(`\n${bold(h.reference || h.id)} ${dim(h.kind ?? "")}`);
        console.log(wrap(h.short_title || h.title));
        console.log(dim(`  sakId ${h.id} · ${h.session}${h.committee ? ` · ${h.committee}` : ""}`));
      }
    });
  },

  async sak(args, flags) {
    const { fetchCase, fetchPublication, publicationId } = await import("./stortinget.js");
    const sak = await fetchCase(args[0]);
    let text;
    if (flags.tekst) {
      for (const ref of (sak.reference ?? "").split(",").map((r) => r.trim())) {
        const pid = publicationId(ref, sak.session);
        if (!pid) continue;
        try {
          const pub = await fetchPublication(pid);
          if (pub.text) {
            text = { ref, ...pub };
            break;
          }
        } catch {
          // Ikke alle henvisninger finnes i eksporten; prøv neste.
        }
      }
    }
    out(flags, { sak, text }, () => {
      console.log(bold(sak.reference ?? sak.id));
      console.log(wrap(sak.shortTitle || sak.title, ""));
      console.log(`\n${dim("Sesjon: ")} ${sak.session}   ${dim("Komité:")} ${sak.committee ?? "-"}`);
      if (sak.topics?.length) console.log(`${dim("Emner:  ")} ${sak.topics.join(", ")}`);
      if (sak.steps?.length) console.log(`${dim("Saksgang:")} ${sak.steps.join(" -> ")}`);
      if (sak.documents?.length) {
        console.log(`\n${dim("Dokumenter:")}`);
        for (const d of sak.documents) console.log(`  ${d.tekst}\n  ${dim(d.url)}`);
      }
      if (text) {
        const cap = num(flags.tegn, 6000);
        console.log(`\n${bold(`Tekst fra ${text.ref}`)} ${dim(`(${text.text.length} tegn)`)}`);
        console.log(wrap(text.text.slice(0, cap), ""));
        if (text.text.length > cap) console.log(dim("\n[… avkortet, bruk --tegn N]"));
      } else if (flags.tekst) {
        console.log(dim("\nFant ingen dokumenttekst i Stortingets eksport — se lenkene over."));
      }
      console.log(dim(`\n${sak.url}`));
    });
  },

  async emd(args, flags) {
    const { searchCaselaw } = await import("./hudoc.js");
    // «alle» må bli null, ikke undefined — undefined faller tilbake på Norge.
    const stat = flags.stat === "alle" ? null : flags.stat;
    const r = await searchCaselaw({
      text: args.join(" ") || undefined,
      caseName: typeof flags.sak === "string" ? flags.sak : undefined,
      respondent: stat === undefined ? "NOR" : stat,
      article: flags.art,
      importance: flags.viktighet ? Number(flags.viktighet) : undefined,
      limit: num(flags.limit, 10),
    });
    out(flags, r, () => {
      console.log(dim(`${r.total} avgjørelser`));
      for (const h of r.hits) {
        console.log(`\n${bold(h.sak)}`);
        console.log(
          dim(`  ${h.dato} · ${h.instans} · ${h.stat} · nr. ${h.klagenummer}${h.viktighet ? ` · ${h.viktighet}` : ""}`),
        );
        if (h.krenkelse) console.log(`  ${c(31, "Krenkelse")} av art. ${h.krenkelse.join(", ")}`);
        if (h.ikkeKrenkelse) console.log(`  ${c(32, "Ingen krenkelse")} av art. ${h.ikkeKrenkelse.join(", ")}`);
        console.log(dim(`  itemid ${h.itemid}`));
      }
    });
  },

  async dom(args, flags) {
    const { getCaselaw } = await import("./hudoc.js");
    const doc = await getCaselaw(args[0]);
    let text = doc.text;
    let from = 0;
    if (typeof flags.del === "string") {
      const needle = new RegExp(flags.del.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const m = needle.exec(text.slice(200));
      if (!m) {
        console.error(`lovdata: fant ikke «${flags.del}» i dommen.`);
        process.exit(1);
      }
      from = m.index + 200;
      text = text.slice(from);
    }
    const cap = num(flags.tegn, 8000);
    out(flags, { ...doc, from }, () => {
      console.log(wrap(text.slice(0, cap), ""));
      if (text.length > cap) console.log(dim(`\n[… ${doc.text.length} tegn totalt, bruk --tegn N eller --del]`));
      console.log(dim(`\n${doc.url}`));
    });
  },

  async ombud(args, flags) {
    const { searchOpinions } = await import("./sivilombudet.js");
    const r = await searchOpinions({ query: args.join(" "), limit: num(flags.limit, 10) });
    out(flags, r, () => {
      console.log(dim(`${r.total} uttalelser`));
      for (const h of r.hits) {
        console.log(`\n${bold(h.tittel)}`);
        if (h.sammendrag) console.log(wrap(h.sammendrag));
        console.log(dim(`  ${h.dato} · id ${h.id}`));
      }
    });
  },

  async uttalelse(args, flags) {
    const { getOpinion } = await import("./sivilombudet.js");
    const o = await getOpinion(Number(args[0]), { maxChars: num(flags.tegn, 20000) });
    out(flags, o, () => {
      console.log(bold(o.tittel));
      console.log(dim(`${o.dato} · ${o.totaltAntallTegn} tegn`));
      console.log(`\n${wrap(o.tekst, "")}`);
      console.log(dim(`\n${o.url}`));
    });
  },

  status(_args, flags) {
    const ltProblem = lovtidendProblem();
    const lt = ltProblem ? undefined : new Lovtidend().status();
    const problem = indexProblem();
    if (problem) return console.log(`${problem} Kjør «lovdata sync».`);
    const corpus = new Corpus();
    const s = corpus.status();
    const fa = corpus.casesStatus();
    const days = s.syncedAt ? (Date.now() - Date.parse(s.syncedAt)) / 86400000 : undefined;
    out(flags, { ...s, forarbeider: fa, lovtidend: lt ?? { problem: ltProblem } }, () => {
      console.log(bold("Lovdata-indeks") + dim(` ${dbPath()}`));
      console.log(
        `  hentet      ${s.syncedAt?.slice(0, 16).replace("T", " ")} ${dim(days === undefined ? "" : `(${days.toFixed(1)} døgn)`)}`,
      );
      console.log(`  dokumenter  ${s.documents}`);
      console.log(`  paragrafer  ${s.articles}`);
      for (const [k, v] of Object.entries(s.byType)) console.log(`    ${k.padEnd(16)} ${v}`);
      console.log(`  forarbeider ${fa.cases} saker ${dim(`${fa.fraSesjon} -> ${fa.tilSesjon}`)}`);
      console.log(
        `  lovtidend   ${lt ? `${lt.count} kunngjøringer ${dim(lt.years)}` : dim(ltProblem)}`,
      );
      if (lt && !lt.history) console.log(dim("              bare inneværende år — «lovdata sync --historikk» henter 2001 og framover"));
      if (days > 7) console.log(dim("\n  Indeksen er over en uke gammel — «lovdata sync» henter ferske data."));
    });
  },

  async sync(_args, flags) {
    const { sync, syncStortinget, syncLovtidend } = await import("./corpus.js");
    await sync({ log: (m) => console.log(m) });
    await syncStortinget({ log: (m) => console.log(m) });
    try {
      await syncLovtidend({ log: (m) => console.log(m), history: flags.historikk ? true : undefined });
    } catch (err) {
      // Lovtidend har sin egen fil; lovindeksen er ferdig og uskadd.
      console.error(`lovdata: Lovtidend ble ikke oppdatert: ${err.message}`);
    }
  },
};

const ALIASES = {
  søk: "sok",
  s: "sok",
  lovtidend: "lt",
  kunngjoring: "kg",
  kunngjøring: "kg",
  paragraf: "p",
  forarbeid: "fa",
  forarbeider: "fa",
  hjelp: "help",
  "-h": "help",
  "--help": "help",
};

const [rawCmd, ...rest] = process.argv.slice(2);
const cmd = ALIASES[rawCmd] ?? rawCmd;

if (!cmd || cmd === "help") {
  console.log(HELP);
  process.exit(cmd ? 0 : 1);
}
if (!commands[cmd]) {
  console.error(`lovdata: ukjent kommando «${rawCmd}». Kjør «lovdata hjelp».`);
  process.exit(1);
}

const { flags, args } = parseArgs(rest);
try {
  await commands[cmd](args, flags);
} catch (err) {
  console.error(`lovdata: ${err.message}`);
  process.exit(1);
}
