/**
 * Lovdatas «XML»-filer er egentlig XHTML med semantiske klassenavn. Strukturen er
 * maskingenerert og helt regelmessig, så den lar seg lese uten et fullt DOM.
 *
 *   <dl class="data-document-key-info">   metadata som dt/dd-par
 *   <section class="section" data-name= id=>   kapittel, med <h2>
 *   <article class="legalArticle" data-name="§12" data-lovdata-URL=>  paragraf
 *     <h3 class="legalArticleHeader"><span class="legalArticleValue">§ 12</span>
 *     <article class="legalP" id="...-ledd-1">   enkeltledd
 *     <article class="changesToParent">          endringshistorikk
 */

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "",
  aring: "å", oslash: "ø", aelig: "æ", Aring: "Å", Oslash: "Ø", AElig: "Æ",
  laquo: "«", raquo: "»", ndash: "–", mdash: "—", hellip: "…", sect: "§",
};

export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, code) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code] ?? whole;
  });
}

/** Fjern markup og få igjen lesbar tekst med normaliserte mellomrom. */
export function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<\/(p|div|li|article|section|h[1-6]|tr)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Finn ytterste elementer av en gitt type, med riktig nøsting.
 * Lovdata nøster article i article, så et ikke-grådig regex holder ikke.
 */
export function outerElements(html, tag, className) {
  const open = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  const both = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, "gi");
  const wanted = new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`);
  const out = [];
  let m;
  open.lastIndex = 0;
  while ((m = open.exec(html))) {
    if (!wanted.test(m[0])) continue;
    // Tell oss fram til den matchende sluttaggen.
    both.lastIndex = m.index + m[0].length;
    let depth = 1;
    let inner;
    while (depth > 0 && (inner = both.exec(html))) {
      depth += inner[0][1] === "/" ? -1 : 1;
    }
    const end = depth === 0 ? both.lastIndex : html.length;
    out.push({ startTag: m[0], html: html.slice(m.index + m[0].length, end - `</${tag}>`.length), index: m.index });
    open.lastIndex = end;
  }
  return out;
}

const attr = (tag, name) => tag.match(new RegExp(`${name}="([^"]*)"`, "i"))?.[1];

function metadataField(head, key) {
  const m = head.match(new RegExp(`<dd class="${key}">([\\s\\S]*?)</dd>`, "i"));
  return m ? stripTags(m[1]) : undefined;
}

function metadataLinks(head, key) {
  const m = head.match(new RegExp(`<dd class="${key}">([\\s\\S]*?)</dd>`, "i"));
  if (!m) return [];
  // Lenkene er HTML-kodet: «§» står som &sect; i href-attributtet.
  return [...m[1].matchAll(/href="([^"]+)"/g)].map((x) => decodeEntities(x[1]));
}

/** Dokumenttype utledes av mappa i arkivet og av dokid-prefikset. */
export function documentType(sourcePath) {
  const dir = sourcePath.split("/").at(-2);
  return { nl: "lov", sf: "forskrift", del: "delegering", ins: "instruks", stv: "stortingsvedtak" }[dir] ?? "ukjent";
}

/**
 * Les ett dokument. Returnerer metadata pluss en flat liste paragrafer,
 * hver med kapitteltilhørighet, tekst og endringshistorikk.
 */
export function parseDocument(html, sourcePath) {
  const headEnd = html.indexOf("</header>");
  const head = headEnd === -1 ? html : html.slice(0, headEnd);
  const body = headEnd === -1 ? html : html.slice(headEnd);

  const dokid = metadataField(head, "dokid");
  // Grunnloven finnes både på bokmål og nynorsk med samme dokid. Uten et eget
  // suffiks overskriver den ene den andre, og paragrafene havner i samme
  // dokument på to språk.
  const language = /-nn\.xml$/.test(sourcePath) ? "nn" : "nb";
  const doc = {
    id: language === "nn" && dokid ? `${dokid}#nn` : dokid,
    type: documentType(sourcePath),
    legacyId: metadataField(head, "legacyID"),
    title: metadataField(head, "title") ?? stripTags(head.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? ""),
    shortTitle: metadataField(head, "titleShort"),
    ministry: metadataField(head, "ministry"),
    legalAreas: metadataField(head, "legalArea"),
    dateInForce: metadataField(head, "dateInForce"),
    lastChangeInForce: metadataField(head, "lastChangeInForce"),
    lastChangedBy: metadataField(head, "lastChangedBy"),
    lastUpdated: metadataField(head, "lastupdated"),
    publishedIn: metadataField(head, "publishedIn"),
    appliesTo: metadataField(head, "appliesTo"),
    basedOn: metadataLinks(head, "basedOn"),
    language,
    sourceFile: sourcePath.split("/").slice(-2).join("/"),
    url: dokid ? `https://lovdata.no/dokument/${dokid}` : undefined,
    articles: [],
  };

  // Kapitler først, slik at hver paragraf vet hvor den hører hjemme.
  const chapters = outerElements(body, "section", "section").map((s) => ({
    name: attr(s.startTag, "data-name"),
    id: attr(s.startTag, "id"),
    heading: stripTags(s.html.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i)?.[1] ?? ""),
    start: s.index,
    end: s.index + s.html.length,
  }));
  const chapterAt = (i) => chapters.filter((c) => i >= c.start && i <= c.end).at(-1);

  for (const art of outerElements(body, "article", "legalArticle")) {
    const name = attr(art.startTag, "data-name");
    // Overskriften står som regel i h3 og inneholder da både nummer og tittel.
    // Noen forskrifter har ingen h3, bare en egen tittel-span.
    const h3 = stripTags(
      art.html.match(/<h3 class="legalArticleHeader"[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? "",
    );
    const articleTitle = stripTags(
      art.html.match(/<span class="legalArticleTitle"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "",
    );
    const heading = h3
      ? articleTitle && !h3.includes(articleTitle)
        ? `${h3} ${articleTitle}`
        : h3
      : articleTitle
        ? `${name ?? ""} ${articleTitle}`.trim()
        : "";
    // Selve lovteksten er ledd-artiklene; endringshistorikken holdes utenfor.
    const withoutChanges = art.html.replace(/<article class="changesToParent"[\s\S]*?<\/article>/gi, "");
    const text = stripTags(withoutChanges.replace(/<h3 class="legalArticleHeader"[\s\S]*?<\/h3>/i, ""));
    const changes = outerElements(art.html, "article", "changesToParent")
      .map((c) => stripTags(c.html))
      .filter(Boolean)
      .join("\n");
    const chapter = chapterAt(art.index);
    doc.articles.push({
      name: name || heading || `#${doc.articles.length + 1}`,
      heading: heading || undefined,
      chapter: chapter?.heading || undefined,
      chapterId: chapter?.id || undefined,
      lovdataUrl: attr(art.startTag, "data-lovdata-URL"),
      text,
      changes: changes || undefined,
    });
  }

  return doc;
}
