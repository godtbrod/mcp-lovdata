# mcp-lovdata

MCP-server for **norske lover og sentrale forskrifter** fra Lovdatas åpne datasett.
Korpuset lastes ned, parses og indekseres lokalt i SQLite med FTS5, slik at søk går
på millisekunder uten nettverk.

## Hvorfor lokal indeks

Lovdata har ikke et gratis spørrings-API. Det som er åpent er fire bulk-arkiver som
legges ut på nytt hver natt:

- `gjeldende-lover.tar.bz2` — 758 lover
- `gjeldende-sentrale-forskrifter.tar.bz2` — 5 114 forskrifter, delegeringer,
  instrukser og stortingsvedtak
- `lovtidend-avd1-2026.tar.bz2` — årets kunngjøringer i Norsk Lovtidend avd. I
- `lovtidend-avd1-2001-2025.tar.bz2` — de samme kunngjøringene tilbake til 2001

De to første er 27 MB komprimert, Lovtidend 70 MB til. Alt annet — rettspraksis,
forarbeider, historiske versjoner av lovtekstene, lokale forskrifter — ligger bak
betaling i Lovdata Pro. Dataene her er lisensiert under **NLOD 2.0** og kan fritt
brukes til alle formål.

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
| `lovtidend_search` | Søker i kunngjøringene: hva som ble endret, når, av hvem — ned til paragrafnivå. |
| `lovtidend_get` | Én kunngjøring i fulltekst, med ordlyden på hver endring. |
| `caselaw_search` | Søker i EMD-praksis via Europarådets åpne HUDOC-base. |
| `caselaw_get` | Henter én EMD-dom i fulltekst, med mulighet for å hoppe til en seksjon. |
| `preparatory_search` | Søker i Stortingets saker fra 1986 — forarbeidene. |
| `preparatory_get` | Saksgang, vedtak og dokumenttekst for én stortingssak. |
| `ombudsman_search` | Søker i Sivilombudets uttalelser. |
| `ombudsman_get` | Henter én uttalelse i fulltekst. |

## Endringshistorikk

De konsoliderte tekstene sier hva som gjelder i dag. **Norsk Lovtidend avd. I** sier
hva som ble endret, når, av hvilken endringslov og hvilket departement — 39 000
kunngjøringer fra 2001 til i dag, hver med kunngjøringsdato, ikrafttredelse,
forarbeider og selve ordlyden på endringen.

Det svarer på spørsmål korpuset ellers ikke kan besvare: «hva ble endret i ferieloven
i 2024, og når trådte det i kraft», «hvilken lov endret arbeidsmiljøloven § 15-6»,
«hvilke forskrifter har Landbruks- og matdepartementet kunngjort i år».

**Det er endringene, ikke lovteksten slik den lød på en gitt dato.** Historiske
versjoner av en lov finnes bare i Lovdata Pro.

Hvert dokument sier selv hvilke andre dokumenter det endrer (`changesToDocuments`), og
fra 2023 er hver enkelt endring merket med paragrafen den treffer
(`data-change-part="lov/2005-06-17-62/§15-6/ledd/3"`). Eldre kunngjøringer har bare
instruksjonen i klartekst — «§ 15-6 tredje ledd skal lyde:» — under en innledning som
«I lov 17. juni 2005 nr. 62 … gjøres følgende endringer:». Den formen er så regelmessig
at paragrafene lar seg lese ut av teksten; målt mot Lovdatas egen merking i årgangene
som har begge deler, treffer uttrekket 96 % riktig og finner 88 % av endringene.
Resten er stort sett kapitler som erstattes i sin helhet.

Ikrafttredelsen står ofte som «Kongen bestemmer». Datoen kommer da i en egen kgl.res.
senere, og den finner `lovtidend_get` fram til under `ikraftsattVed`.

**Årets årgang er med i hver sync** — 1,4 MB, rundt et sekund. Historikken tilbake til
2001 er 70 MB og halvannet minutt, og hentes bare på forespørsel (`sync` med
`historikk: true`, eller `lovdata sync --historikk`). Er den først hentet, holdes den
oppdatert av hver vanlige sync, uten nedlasting når Lovdata ikke har endret pakken.

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

## Kommandolinje

De samme kildene finnes som kommandoen `lovdata`. Den importerer modulene direkte —
ingen JSON-RPC-omvei — så lokale søk svarer på under et tiendedels sekund.

```bash
lovdata sok '"organinterne dokumenter"'      # søk i alle paragrafer
lovdata p offentleglova 11                   # én paragraf ordrett
lovdata lov arbeidsmiljøloven                # metadata og innholdsfortegnelse
lovdata lt --endrer ferieloven --fra 2024    # endringer i en lov, med dato
lovdata lt --endrer aml --paragraf 15-6      # hvem endret denne paragrafen
lovdata kg LOV-2023-12-15-88                 # hele kunngjøringen
lovdata fa offentleglova                     # forarbeider
lovdata sak 89888 --tekst                    # stortingssak med dokumenttekst
lovdata emd --art 8 --viktighet 1            # EMD-dommer mot Norge
lovdata dom 001-214433 --del "FOR THESE REASONS"
lovdata ombud innsyn byggesak                # Sivilombudet
lovdata status
```

`--json` gir rå JSON på stdout for videre behandling. `lovdata hjelp` viser alt.

Installer wrapperen:

```bash
ln -sf ~/Work/mcp-lovdata/src/cli.js ~/.local/bin/lovdata
```

## Installasjon

```bash
npm install
npm run sync              # ~3 minutter, laster ned 28 MB
npm run sync -- --historikk   # + Lovtidend 2001–i fjor: 70 MB og halvannet minutt
```

Registrer serveren i Claude Code:

```bash
claude mcp add --scope user lovdata -- node ~/Work/mcp-lovdata/src/index.js
```

Indeksen havner i `~/.local/share/mcp-lovdata/lovdata.db` (~180 MB). Lovtidend ligger
i `lovtidend.db` i samme mappe: 8 MB for årets årgang, 265 MB med hele historikken.
Overstyr med `LOVDATA_DB` og `LOVTIDEND_DB`, eller flytt hele mappa med `XDG_DATA_HOME`.

At Lovtidend er en egen fil er et poeng: lovsynken avslutter med `VACUUM`, som skriver
hele fila på nytt, og en Lovtidend-sync som feiler kan ikke røre lovindeksen.

## Slik er det bygget

- **Ingen avhengigheter utover MCP-SDK-en.** SQLite kommer fra `node:sqlite`, som har
  FTS5 innebygd fra Node 22. Utpakkingen bruker systemets `tar`.
- **Lovtidend-arkivet leses som en strøm.** Historikken er 38 000 filer og 690 MB
  utpakket. Å skrive dem til disk og lese dem inn igjen tok 45 sekunder på Windows;
  å la `bsdtar` skrive arkivet om til ukomprimert tar på stdout og parse tar-hodene
  i Node tok 22, uten å ta plass underveis. På Linux og macOS gjør `bzip2 -dc` samme
  jobb — begge veier ender det i den samme leseren.
- **Lovtidend-teksten lagres komprimert.** 260 MB klartekst blir 86 MB med `deflate`,
  og FTS5-tabellen er `contentless`, så teksten finnes bare ett sted. Prisen er at
  `snippet()` ikke kan brukes; utdragene lages i stedet i JS, med vinduet lagt der
  flest av søkeordene står nær hverandre.
- **Arkivene pakkes ut i `/tmp`, ikke i hjemmemappa.** Tusenvis av små filer er det
  dyreste man kan skrive til en mekanisk disk; det som blir liggende igjen er én fil.
- **`remove_diacritics 0` i tokenizeren.** Æ, ø og å er egne bokstaver på norsk, ikke
  aksenter over a og o.
- **Bindeord fjernes fra søket.** FTS5 krever at alle ord finnes, så «oppsigelse i
  prøvetiden» mistet ellers treff bare fordi «i» ikke sto i paragrafen. Fraser i
  anførselstegn røres ikke.
- **Søkeord matches som prefiks.** `unicode61` har ingen stemming, og norsk bøyer i
  endelsen, så «oppsigelse» og «oppsigelsen» var to ulike tokens — «oppsigelse
  prøvetid» fant ikke aml § 15-6 i det hele tatt, fordi paragrafen skriver bestemt
  form. Ord fra fire tegn søkes derfor som prefiks. Kortere ord holdes eksakte, ellers
  ville «bil» dratt inn «bilag». Anførselstegn rundt ett ord gir eksakt form tilbake.
- **`ANALYZE` etter sync, og `IN` framfor `EXISTS`.** Uten statistikk valgte
  planleggeren indeksen på (kind, target) for å slippe en sortering, og leste seg
  gjennom alle 150 000 endringslenkene på oppslag som skulle tatt mikrosekunder.
  Samme mønster med `EXISTS`: den skannet alle kunngjøringene og slo opp lenkene for
  hver. Med `IN` slås lenkene opp først. 700 ms ble til 1.
- **Rangering.** Paragrafsøk vekter paragrafnavn og overskrift over brødtekst.
  Navneoppslag løfter treff der navnet står i tittelens parentes — det er der
  kortnavnet står, som i «Lov om arbeidsmiljø … (arbeidsmiljøloven)» — og foretrekker
  lov framfor delegeringsvedtak med samme ord i tittelen.

## Grenser

- **Ingen historiske lovtekster.** Lovtidend gir endringene med dato og ordlyd, men
  ikke loven slik den lød en gitt dag. Det, og opphevede lover, finnes bare i
  Lovdata Pro.
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
