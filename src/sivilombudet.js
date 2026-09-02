/**
 * Uttalelser fra Sivilombudet, via WordPress' åpne REST-API.
 * Ingen autentisering, og robots.txt tillater alt.
 *
 * Sivilombudet er ikke en domstol, men uttalelsene er tung forvaltningspraksis:
 * de tolker forvaltningsloven, offentleglova og forvaltningens saksbehandling,
 * og de følges i praksis. 1965 uttalelser, med fulltekst.
 */

import { stripTags } from "./parse.js";

const BASE = "https://www.sivilombudet.no/wp-json/wp/v2";

class OmbudError extends Error {}

async function get(path, params = {}, { timeoutMs = 60_000 } = {}) {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": "mcp-lovdata" }, signal: controller.signal });
    if (res.status === 400) throw new OmbudError("Sivilombudet avviste forespørselen — sjekk parametrene.");
    if (!res.ok) throw new OmbudError(`Sivilombudet svarte HTTP ${res.status}`);
    return { body: await res.json(), total: Number(res.headers.get("x-wp-total")) || undefined };
  } catch (err) {
    if (err instanceof OmbudError) throw err;
    if (err?.name === "AbortError") throw new OmbudError(`Sivilombudet svarte ikke innen ${timeoutMs} ms.`);
    throw new OmbudError(`Sivilombudet: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

const summarize = (html, limit) => {
  const text = stripTags(html ?? "");
  return limit && text.length > limit ? `${text.slice(0, limit)}…` : text;
};

const shape = (post, snippetLength) => ({
  id: post.id,
  tittel: stripTags(post.title?.rendered ?? ""),
  dato: post.date?.slice(0, 10),
  sistEndret: post.modified?.slice(0, 10) !== post.date?.slice(0, 10) ? post.modified?.slice(0, 10) : undefined,
  sammendrag: summarize(post.excerpt?.rendered, snippetLength) || undefined,
  url: post.link,
});

/**
 * Søk i uttalelsene. WordPress' `search` er fulltekst over tittel og innhold,
 * og resultatet er relevanssortert med mindre annet oppgis.
 */
export async function searchOpinions({ query, from, to, type = "uttalelser", limit = 10, offset = 0 }) {
  const { body, total } = await get(type, {
    search: query || undefined,
    after: from ? `${from}T00:00:00` : undefined,
    before: to ? `${to}T23:59:59` : undefined,
    per_page: Math.min(limit, 100),
    offset,
    orderby: query ? "relevance" : "date",
    _fields: "id,date,modified,link,title,excerpt",
  });
  return { total: total ?? body.length, hits: body.map((p) => shape(p, 300)) };
}

/** Hele uttalelsen. De er lange nok til at avkorting er nødvendig. */
export async function getOpinion(id, { type = "uttalelser", maxChars = 30_000 } = {}) {
  const { body } = await get(`${type}/${id}`, { _fields: "id,date,modified,link,title,content" });
  const text = stripTags(body.content?.rendered ?? "");
  const truncated = text.length > maxChars;
  return {
    id: body.id,
    tittel: stripTags(body.title?.rendered ?? ""),
    dato: body.date?.slice(0, 10),
    url: body.link,
    totaltAntallTegn: text.length,
    avkortet: truncated || undefined,
    tekst: truncated ? `${text.slice(0, maxChars)}\n\n[… avkortet, øk maxChars]` : text,
  };
}
