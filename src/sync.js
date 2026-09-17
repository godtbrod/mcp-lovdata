#!/usr/bin/env node
import { sync, syncLovtidend, syncStortinget } from "./corpus.js";
import { dbPath } from "./db.js";

// --historikk tar med Lovtidend tilbake til 2001. Uten flagget friskes
// historikken opp bare hvis den er hentet før.
const history = process.argv.includes("--historikk") ? true : undefined;

const result = await sync({ log: (m) => console.log(m) });
const forarbeider = await syncStortinget({ log: (m) => console.log(m) });
console.log(`indeks: ${dbPath()}`);
if (forarbeider.cases) console.log(`forarbeider indeksert: ${forarbeider.cases} stortingssaker`);
if (result.skipped) console.log(`hoppet over ${result.skipped} filer som ikke lot seg lese`);

try {
  await syncLovtidend({ log: (m) => console.log(m), history });
} catch (err) {
  // Lovtidend har sin egen fil; lovindeksen over er ferdig og uskadd.
  console.error(`Lovtidend ble ikke oppdatert: ${err.message}`);
  process.exitCode = 1;
}
