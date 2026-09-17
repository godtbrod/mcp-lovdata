/**
 * Norsk Lovtidend avd. I — kunngjøringene av nye lover, forskrifter og
 * endringer i dem. Filene har samme maskingenererte HTML som de konsoliderte
 * tekstene, men et annet hode:
 *
 *   dd.refid                lov/2023-12-15-88          det andre dokumenter lenker til
 *   dd.dateOfPublication    2023-12-15 12:50           kunngjort (eldre: bare dato)
 *   dd.dateInForce          2024-07-01 | Kongen bestemmer | fritekst
 *   dd.changesToDocuments   <li>lov/2005-06-17-62</li> hvilke dokumenter som endres
 *   dd.miscInformation      Prop. 130 L (2022–2023), Innst. … — eller hjemmel
 *
 * Fra 2023 er selve endringene også merket på paragrafnivå:
 *
 *   <article class="change" data-change-part="lov/2005-06-17-62/§15-6/ledd/3">
 *
 * Eldre kunngjøringer har bare instruksjonen i klartekst — «§ 15-6 tredje ledd
 * skal lyde:» — under en innledning som «I lov 17. juni 2005 nr. 62 … gjøres
 * følgende endringer:». Den er så regelmessig at paragrafene kan leses ut av
 * teksten; se changedParts.
 */
import { decodeEntities, stripTags } from "./parse.js";

function field(head, key) {
  const m = head.match(new RegExp(`<dd class="${key}">([\\s\\S]*?)</dd>`, "i"));
  return m ? m[1] : undefined;
}

const text = (head, key) => {
  const raw = field(head, key);
  return raw === undefined ? undefined : stripTags(raw) || undefined;
};

/** Listefelt som departement og rettsområde står som <li>-elementer. */
const items = (head, key) => {
  const raw = field(head, key);
  if (raw === undefined) return [];
  const li = [...raw.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => stripTags(m[1])).filter(Boolean);
  return li.length ? li : [stripTags(raw)].filter(Boolean);
};

const ISO = /\b(\d{4}-\d{2}-\d{2})\b/;

/**
 * Les én kunngjøring. Teksten er hele dokumentkroppen uten markup; den er det
 * som søkes i, og det lovtidend_get viser.
 */
export function parseGazette(html) {
  const headEnd = html.indexOf("</header>");
  const head = headEnd === -1 ? html : html.slice(0, headEnd);
  const bodyStart = html.indexOf("<main");
  const body = bodyStart !== -1 ? html.slice(bodyStart) : headEnd !== -1 ? html.slice(headEnd) : html;

  const id = text(head, "dokid");
  const refid = text(head, "refid");
  const published = text(head, "dateOfPublication");
  const inForce = text(head, "dateInForce");
  const changes = items(head, "changesToDocuments");
  const publishedDate = published?.match(ISO)?.[1];
  return {
    id,
    refid,
    // «LTI/lov/…» og «LTI/forskrift/…» er de eneste formene i arkivet.
    type: id?.split("/")[1],
    legacyId: text(head, "legacyID"),
    title: text(head, "title") ?? stripTags(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? ""),
    shortTitle: text(head, "titleShort"),
    ministry: items(head, "ministry").join("; ") || undefined,
    agency: items(head, "subunit").join("; ") || undefined,
    published,
    publishedDate,
    year: Number((publishedDate ?? refid?.match(/\/(\d{4})-/)?.[1] ?? "").slice(0, 4)) || undefined,
    inForce,
    // Fritekst som «Kongen bestemmer» har ingen dato; da er feltet tomt og
    // inForce forklarer hvorfor.
    inForceDate: inForce?.match(ISO)?.[1],
    journalNumber: text(head, "journalNumber"),
    misc: text(head, "miscInformation"),
    legalAreas: items(head, "legalArea").join("; ") || undefined,
    basedOn: items(head, "basedOn"),
    changes,
    parts: changedParts(body, changes),
    text: stripTags(body),
  };
}

/**
 * Alle former for én og samme henvisning ned til refid-formen Lovtidend
 * lenker med: «NL/lov/2005-06-17-62», «LOV-2005-06-17-62» og
 * «lov/2005-06-17-62» er den samme loven. Delegeringsvedtak og instrukser
 * (DEL/, INS/) er forskrifter i denne sammenhengen.
 */
export function toRefid(value) {
  const v = (value ?? "").trim().replace(/#\w+$/, "");
  if (/^(lov|forskrift)\/\d{4}-\d{2}-\d{2}/i.test(v)) return v.toLowerCase();
  const dokid = v.match(/^(?:NL|SF|LTI|DEL|INS|STV)\/(lov|forskrift)\/(.+)$/i);
  if (dokid) return `${dokid[1].toLowerCase()}/${dokid[2]}`;
  const legacy = v.match(/^(LOV|FOR)-(\d{4}-\d{2}-\d{2}(?:-\d+)?)$/i);
  if (legacy) return `${legacy[1].toUpperCase() === "LOV" ? "lov" : "forskrift"}/${legacy[2]}`;
  return undefined;
}

/**
 * Sorter paragrafnavn slik en jurist leser dem: § 2 før § 14-9, og § 14-8
 * før § 14-8a. Ren tekstsortering ga «§1-8, §13-2, §14-12 … §2-2».
 */
export function compareArticles(a, b) {
  const parts = (s) => [...String(s ?? "").matchAll(/(\d+)|([a-zæøå]+)/gi)].map((m) => (m[1] ? Number(m[1]) : m[2]));
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    if (typeof x[i] !== typeof y[i]) return typeof x[i] === "number" ? -1 : 1;
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** «lov/2005-06-17-62» → «LOV-2005-06-17-62», koden de konsoliderte tekstene har. */
export function toLegacyId(refid) {
  const m = /^(lov|forskrift)\/(.+)$/.exec(refid ?? "");
  return m ? `${m[1] === "lov" ? "LOV" : "FOR"}-${m[2]}` : undefined;
}

/**
 * «2024» → 2024-01-01 og 2024-12-31. Perioder skrives som år, måned eller dato,
 * og sammenlignes som tekst mot kunngjøringsdatoen.
 */
export function periodStart(value) {
  const v = (value ?? "").trim();
  if (/^\d{4}$/.test(v)) return `${v}-01-01`;
  if (/^\d{4}-\d{2}$/.test(v)) return `${v}-01`;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}

export function periodEnd(value) {
  const v = (value ?? "").trim();
  if (/^\d{4}$/.test(v)) return `${v}-12-31`;
  if (/^\d{4}-\d{2}$/.test(v)) {
    // Siste dag i måneden: dag 0 i neste måned.
    const [y, m] = v.split("-").map(Number);
    return `${v}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}

// ------------------------------------------------------------ Endringer

const MONTHS = {
  januar: "01", februar: "02", mars: "03", april: "04", mai: "05", juni: "06",
  juli: "07", august: "08", september: "09", oktober: "10", november: "11", desember: "12",
};

/**
 * «§ 15-6», «§ 7 a», «§ 2A-3» → «§15-6», «§7a», «§2A-3» — slik de konsoliderte
 * tekstene navngir paragrafene, så de to kan slås sammen.
 */
export function normalizeArticle(name) {
  return `§${name.replace(/^§+/, "").replace(/\s+/g, "")}`;
}

/** Paragrafnumrene i en instruksjon. «§§ 25a og 25b oppheves.» gir begge. */
export function articlesIn(sentence) {
  const number = String.raw`\d+(?:\s?[a-zA-Z](?![\p{L}\d]))?(?:-\d+(?:\s?[a-z](?![\p{L}\d]))?)?`;
  const out = [];
  for (const m of sentence.matchAll(new RegExp(String.raw`§§?\s*(${number}(?:\s*(?:,|og|til)\s*${number})*)`, "gu"))) {
    for (const n of m[1].matchAll(new RegExp(number, "gu"))) out.push(normalizeArticle(n[0]));
  }
  return out;
}

const REF = /\b(lov|forskrift)(?:\s+av)?\s+(\d{1,2})\.\s*([a-zæøå]+)\s+(\d{4})(?:\s+nr\.?\s*(\d+))?/i;

/**
 * «lov 17. juni 2005 nr. 62» → «lov/2005-06-17-62». Noen få eldre lover har
 * ikke nummer, og refid er da bare datoen.
 */
export function refidFrom(sentence) {
  const m = sentence.match(REF);
  const month = m && MONTHS[m[3].toLowerCase()];
  if (!month) return undefined;
  const date = `${m[4]}-${month}-${m[2].padStart(2, "0")}`;
  return { refid: `${m[1].toLowerCase()}/${m[5] ? `${date}-${m[5]}` : date}`, end: m.index + m[0].length };
}

// Bokmål og nynorsk: «skal lyde», «oppheves», «blir oppheva», «blir ny § 8».
const INSTRUCTION = /\b(lyde|lyda|oppheves|oppheva|opphevast|blir\s+(?:nytt?|§)|tilføyes|tilføyast|utgår|endres)\b/i;

/**
 * Hvilke dokumenter og paragrafer kunngjøringen endrer. Merkingen på
 * paragrafnivå (fra 2023) brukes når den finnes; ellers leses instruksjonene.
 *
 * Svaret er en liste { target: "lov/2005-06-17-62", article: "§15-6" | null }.
 * Hvert endret dokument står alltid med article null, så «alle endringer i
 * loven» og «endringer i § X» er samme oppslag.
 */
export function changedParts(body, changes = []) {
  const seen = new Set();
  const out = [];
  const add = (target, article = null) => {
    if (!target) return;
    const key = `${target}|${article}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ target, article });
  };
  for (const target of changes) add(target);

  let marked = false;
  for (const m of body.matchAll(/data-(?:change|add-new|repeal|move)-part="([^"]+)"/g)) {
    marked = true;
    // Flytting skrives «fra;;til», oppheving av flere «a b».
    for (const ref of decodeEntities(m[1]).split(/;;|\s+/)) {
      const hit = ref.match(/^((?:lov|forskrift)\/[^/]+)(?:\/(§[^/]+))?/);
      if (hit) add(hit[1], hit[2] ? normalizeArticle(hit[2]) : null);
    }
  }
  for (const m of body.matchAll(/data-document="([^"]+)"/g)) {
    for (const ref of m[1].split(/\s+/)) if (/^(lov|forskrift)\//.test(ref)) add(ref);
  }
  if (marked) return out;

  // Uten merking: gå gjennom teksten i rekkefølge. «I lov … gjøres følgende
  // endringer» bytter dokument; instruksjonene og de nye paragrafene under
  // hører til det.
  let current = changes.length === 1 ? changes[0] : undefined;
  const known = new Set(changes);
  const blocks = /<(?:article|p) class="(?:defaultP|legalP)"[^>]*>|<article class="futureLegalArticle"[^>]*?data-name="([^"]+)"/g;
  let b;
  while ((b = blocks.exec(body))) {
    if (b[1]) {
      // «Nytt kapittel 5 A skal lyde:» nevner ingen paragraf, men hver ny
      // paragraf i kapitlet står som futureLegalArticle med navnet sitt.
      if (current && b[1].startsWith("§")) add(current, normalizeArticle(decodeEntities(b[1])));
      continue;
    }
    const start = b.index + b[0].length;
    const rest = body.slice(start, start + 1500);
    const stop = rest.search(/<article\b|<ul\b|<ol\b|<\/article>|<\/p>|<table\b/);
    const sentence = stripTags(stop === -1 ? rest : rest.slice(0, stop));
    if (!sentence || sentence.length > 400) continue;

    const ref = refidFrom(sentence);
    if (ref && /endring|endres|gjøres|skal|oppheves|blir/i.test(sentence)) {
      // Et dokument som ikke står i «Endrer»-feltet er som regel bare nevnt,
      // ikke endret — men feltet kan mangle, og da godtas det som står.
      if (known.has(ref.refid) || !known.size) current = ref.refid;
      if (!known.size) add(ref.refid);
    }
    if (!current || !sentence.includes("§") || !INSTRUCTION.test(sentence)) continue;
    // I «I lov … skal § 5 lyde:» er det paragrafene etter dokumentnavnet som gjelder.
    for (const article of articlesIn(ref ? sentence.slice(ref.end) : sentence)) add(current, article);
  }
  return out;
}
