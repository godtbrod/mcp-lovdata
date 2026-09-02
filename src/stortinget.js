/**
 * Forarbeider fra Stortingets åpne API (data.stortinget.no, versjon 1.6).
 * Ingen autentisering.
 *
 * API-et har ingen fritekstsøk, bare uttrekk per sesjon. Sakslistene er små
 * (~1,6 MB per sesjon) og gamle sesjoner endrer seg ikke, så de indekseres
 * lokalt sammen med lovtekstene. Selve dokumentteksten hentes live.
 */

const BASE = "https://data.stortinget.no/eksport";

class StortingetError extends Error {}

/**
 * Datoene kommer som «/Date(1787522400000+0200)/», der tidspunktet er lokal
 * midnatt i Norge. Uten å legge til offsetet havner man på dagen før:
 * 2026-08-23T22:00:00Z er 24. august i Oslo, ikke 23.
 */
export function parseDate(value) {
  const m = /^\/Date\((-?\d+)(?:([+-])(\d{2})(\d{2}))?\)/.exec(value ?? "");
  if (!m) return undefined;
  const offsetMs = m[2] ? (m[2] === "-" ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4])) * 60_000 : 0;
  const d = new Date(Number(m[1]) + offsetMs);
  return Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1900 ? undefined : d.toISOString().slice(0, 10);
}

/**
 * Dokumenttypen leses ut av henvisningen framfor det numeriske type-feltet.
 * Henvisningen er det juristen faktisk siterer, og den er selvforklarende.
 */
export function documentKind(henvisning) {
  // Default-parameteren fanger bare undefined; henvisning er null i eldre saker.
  const h = (henvisning ?? "").trim();
  if (/^Prop\.\s*\d+\s*L/i.test(h)) return "Lovproposisjon";
  if (/^Prop\./i.test(h)) return "Proposisjon";
  if (/^Meld\.\s*St\./i.test(h)) return "Stortingsmelding";
  if (/^Dokument\s*8:/i.test(h)) return "Representantforslag";
  if (/^Dokument\s*\d/i.test(h)) return "Dokumentserien";
  if (/^Innst\./i.test(h)) return "Innstilling";
  return undefined;
}

async function get(path, params = {}, { raw = false, timeoutMs = 90_000 } = {}) {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  if (!raw) url.searchParams.set("format", "json");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": "mcp-lovdata" }, signal: controller.signal });
    if (!res.ok) throw new StortingetError(`Stortinget svarte HTTP ${res.status} for ${path}`);
    if (raw) return res.text();
    const data = await res.json();
    if (data?.feilkode) throw new StortingetError(`Stortinget: ${data.feilmelding}`);
    return data;
  } catch (err) {
    if (err instanceof StortingetError) throw err;
    if (err?.name === "AbortError") throw new StortingetError(`Stortinget svarte ikke innen ${timeoutMs} ms.`);
    throw new StortingetError(`Stortinget: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Alle sesjoner, nyeste først. Sesjoner fram i tid finnes og har ingen saker. */
export async function fetchSessions() {
  const data = await get("sesjoner");
  return (data.sesjoner_liste ?? [])
    .map((s) => ({ id: s.id, fra: parseDate(s.fra), til: parseDate(s.til) }))
    .filter((s) => s.id);
}

/** Sakene i én sesjon, i den formen de lagres lokalt. */
export async function fetchCases(sessionId) {
  const data = await get("saker", { sesjonid: sessionId });
  return (data.saker_liste ?? []).map((s) => ({
    id: String(s.id),
    session: sessionId,
    title: (s.tittel ?? "").replace(/\?/g, "'").trim(),
    shortTitle: (s.korttittel ?? "").replace(/\?/g, "'").trim(),
    reference: s.henvisning ?? "",
    kind: documentKind(s.henvisning),
    committee: s.komite?.navn ?? null,
    topics: (s.emne_liste ?? []).map((e) => e.navn).filter(Boolean).join("; ") || null,
    updated: parseDate(s.sist_oppdatert_dato) ?? null,
  }));
}

/** Detaljer om én sak, inkludert emner, saksgang og lenker til dokumentene. */
export async function fetchCase(caseId) {
  const s = await get("sak", { sakid: caseId });
  return {
    id: String(s.id),
    session: s.sak_sesjon,
    title: (s.tittel ?? "").replace(/\?/g, "'"),
    shortTitle: (s.korttittel ?? "").replace(/\?/g, "'"),
    reference: s.henvisning,
    kind: documentKind(s.henvisning),
    committee: s.komite?.navn,
    finished: s.ferdigbehandlet,
    topics: (s.emne_liste ?? []).map((e) => e.navn).filter(Boolean),
    keywords: (s.stikkord_liste ?? []).map((k) => k.navn ?? k).filter(Boolean),
    decision: s.vedtakstekst ?? undefined,
    recommendation: s.innstillingstekst ?? undefined,
    steps: (s.saksgang?.saksgang_steg_liste ?? []).map((t) => t.navn).filter(Boolean),
    documents: (s.publikasjon_referanse_liste ?? []).map((p) => ({
      tekst: p.lenke_tekst,
      url: p.lenke_url,
      eksportId: p.eksport_id ?? undefined,
    })),
    url: `https://www.stortinget.no/no/Saker-og-publikasjoner/Saker/Sak/?p=${s.id}`,
  };
}

/**
 * Fulltekst i en publikasjon. Stortinget leverer strukturert XML der
 * elementnavnene bærer meningen; vi flater den ut til lesbar tekst.
 */
export async function fetchPublication(publicationId) {
  const xml = await get("publikasjon", { publikasjonid: publicationId }, { raw: true });
  const text = xml
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<\/(Kapittel|A|Tittel|Doktit|Ingress|Navn|Seksjon|Avsnitt|Liste|Punkt|Tabell|Rad)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { publicationId, text, url: `https://www.stortinget.no/no/Saker-og-publikasjoner/Publikasjoner/` };
}

/** Publikasjons-IDer følger et fast mønster: inns-202526-449s for Innst. 449 S. */
export function publicationId(reference, session) {
  const m = /^(Innst\.|Prop\.|Meld\.\s*St\.|Dokument\s*8:)\s*(\d+)\s*([A-ZÆØÅ]*)/i.exec(reference ?? "");
  if (!m) return undefined;
  const prefix = { "innst.": "inns", "prop.": "prop", "meld. st.": "stmeld", "dokument 8:": "dok8" }[
    m[1].toLowerCase().replace(/\s+/g, " ")
  ];
  if (!prefix) return undefined;
  const compact = (session ?? "").replace(/^(\d{4})-(\d{2})(\d{2})?$/, (_, a, b, c) => a + (c ?? b));
  if (!compact) return undefined;
  return `${prefix}-${compact}-${m[2].padStart(3, "0")}${(m[3] || "").toLowerCase()}`;
}
