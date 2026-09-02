# mcp-lovdata

MCP-server for **norske lover og sentrale forskrifter** fra Lovdatas åpne datasett.
Korpuset lastes ned, parses og indekseres lokalt i SQLite med FTS5, slik at søk går
på millisekunder uten nettverk.

## Hvorfor lokal indeks

Lovdata har ikke et gratis spørrings-API. Det som er åpent er to bulk-arkiver som
legges ut på nytt hver natt:

- `gjeldende-lover.tar.bz2` — 758 lover
- `gjeldende-sentrale-forskrifter.tar.bz2` — 5 114 forskrifter, delegeringer,
  instrukser og stortingsvedtak

Til sammen 27 MB komprimert. Alt annet — rettspraksis, forarbeider, historiske
versjoner, lokale forskrifter — ligger bak betaling i Lovdata Pro. Dataene her er
lisensiert under **NLOD 2.0** og kan fritt brukes til alle formål.

Filene er XHTML med semantiske klassenavn, ikke et maskinformat. `src/parse.js` leser
metadata, kapittelstruktur, paragrafer og endringshistorikk ut av dem.

## Verktøy

| Verktøy | Hva det gjør |
| --- | --- |
| `search` | Fulltekstsøk i alle paragrafer, med utdrag. Kan avgrenses til én lov, én type eller ett departement. |
| `get_document` | Slår opp en lov på vanlig navn, dokid eller LOV-kode. Metadata, hjemmel og innholdsfortegnelse. |
| `get_article` | Én paragraf ordrett, med endringshistorikk. Bruk denne før du siterer. |
| `list_documents` | Bla etter type, departement eller endringsdato. |
| `status` | Når indeksen sist ble bygget, og hvor mye den inneholder. |
| `sync` | Henter ferske datapakker og bygger indeksen om. |
| `caselaw_search` | Søker i EMD-praksis via Europarådets åpne HUDOC-base. |
| `caselaw_get` | Henter én EMD-dom i fulltekst, med mulighet for å hoppe til en seksjon. |
| `preparatory_search` | Søker i Stortingets saker fra 1986 — forarbeidene. |
| `preparatory_get` | Saksgang, vedtak og dokumenttekst for én stortingssak. |
| `ombudsman_search` | Søker i Sivilombudets uttalelser. |
| `ombudsman_get` | Henter én uttalelse i fulltekst. |

## Rettspraksis

Norsk rettspraksis finnes ikke i noen fri, maskinlesbar kilde. Lovdata Pro tar betalt
for Høyesterett og lagmannsrettene, og domstol.no sperrer `/api` i robots.txt.

Det som derimot er åpent, er Den europeiske menneskerettsdomstolen gjennom Europarådets
HUDOC-base — og den er ikke et sidespor: menneskerettsloven § 2 gjør EMK til norsk lov,
og § 3 gir den forrang ved motstrid med annen lovgivning. Basen har 906 avgjørelser mot
Norge, med fulltekst, artikkelhenvisninger og konklusjon.

`caselaw_search` går live mot HUDOC — ingen lokal indeks, ingen autentisering. Vær
oppmerksom på to feller i deres spørresyntaks:

- **`sort` er obligatorisk.** Uten den svarer HUDOC med en 404-side i HTML.
- **Ukjente sorteringsfelt gir stille null treff**, ikke en feilmelding. `rank` er ett
  av dem, så relevanssortering finnes ikke — bruk `caseName` for å finne én bestemt sak.

## Forarbeider

Stortingets API (`data.stortinget.no`, versjon 1.6) er åpent og uten autentisering,
men har **ingen fritekstsøk** — bare uttrekk per sesjon. Sakslistene er små og gamle
sesjoner endrer seg aldri, så de indekseres lokalt sammen med lovtekstene: 24 870 saker
fra 1986-87 til i dag. Bare de to nyeste sesjonene hentes på nytt ved hver sync.

Søket dekker sakstitler, henvisninger og emneord — ikke dokumentteksten. Selve teksten
i innstillinger og proposisjoner hentes live på forespørsel.

To ting API-et krever at man vet:

- **Datoene er lokal midnatt** i formatet `/Date(1787522400000+0200)/`. Uten å legge til
  offsetet havner man konsekvent på dagen før.
- **Samme sak ligger i to sesjoner** — den den ble fremmet i og den den ble behandlet i,
  med samme id. Nøkkelen må være sak pluss sesjon, ellers forsvinner 1 100 saker.

## Forvaltningspraksis

Sivilombudets uttalelser via WordPress' åpne REST-API: 1 965 saker med fulltekst og
fungerende serversøk. Ikke bindende som en dom, men forvaltningen retter seg etter dem,
og de er en etablert rettskilde i forvaltningsretten.

## Det som ikke er med

**EFTA-domstolen** ble undersøkt og forkastet. REST-API-et deres gir bare saksnummer
(«E-12/26») uten parter, tema eller sammendrag, og sakssidene rendres med JavaScript.
Det finnes ingen maskinlesbar inngang til innholdet.

## Installasjon

```bash
npm install
npm run sync          # ~3 minutter, laster ned 27 MB
```

Registrer serveren i Claude Code:

```bash
claude mcp add --scope user lovdata -- node ~/Work/mcp-lovdata/src/index.js
```

Indeksen havner i `~/.local/share/mcp-lovdata/lovdata.db` (~150 MB). Overstyr med
`LOVDATA_DB`, eller flytt hele mappa med `XDG_DATA_HOME`.

## Slik er det bygget

- **Ingen avhengigheter utover MCP-SDK-en.** SQLite kommer fra `node:sqlite`, som har
  FTS5 innebygd fra Node 22. Utpakkingen bruker systemets `tar`.
- **Arkivene pakkes ut i `/tmp`, ikke i hjemmemappa.** Tusenvis av små filer er det
  dyreste man kan skrive til en mekanisk disk; det som blir liggende igjen er én fil.
- **`remove_diacritics 0` i tokenizeren.** Æ, ø og å er egne bokstaver på norsk, ikke
  aksenter over a og o.
- **Bindeord fjernes fra søket.** FTS5 krever at alle ord finnes, så «oppsigelse i
  prøvetiden» mistet ellers treff bare fordi «i» ikke sto i paragrafen. Fraser i
  anførselstegn røres ikke.
- **Rangering.** Paragrafsøk vekter paragrafnavn og overskrift over brødtekst.
  Navneoppslag løfter treff der navnet står i tittelens parentes — det er der
  kortnavnet står, som i «Lov om arbeidsmiljø … (arbeidsmiljøloven)» — og foretrekker
  lov framfor delegeringsvedtak med samme ord i tittelen.

## Grenser

- **Bare gjeldende rett.** Ingen opphevede lover, ingen historiske versjoner, ingen
  rettsavgjørelser eller forarbeider.
- **Bare sentrale forskrifter.** Lokale og kommunale forskrifter er ikke med.
- **Indeksen er et øyeblikksbilde.** Lovdata legger ut nye pakker hver natt; `status`
  viser alderen, `sync` henter på nytt.
- **Dette er ikke juridisk rådgivning.** Verktøyet finner og siterer lovtekst.

## Utvikling

```bash
npm test              # enhetstester for parser og søkesyntaks, ingen nettverk
npm start             # kjør serveren på stdio
```

## Kilder

- [Om Lovdatas API-tjeneste](https://api.lovdata.no/om-api-tjenesten/)
- [NLOD 2.0](https://data.norge.no/nlod/no/2.0)

## Lisens

MIT for koden. Lovtekstene er NLOD 2.0 fra Stiftelsen Lovdata.
