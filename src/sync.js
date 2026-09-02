#!/usr/bin/env node
import { sync, syncStortinget } from "./corpus.js";
import { dbPath } from "./db.js";

const result = await sync({ log: (m) => console.log(m) });
const forarbeider = await syncStortinget({ log: (m) => console.log(m) });
console.log(`indeks: ${dbPath()}`);
if (forarbeider.cases) console.log(`forarbeider indeksert: ${forarbeider.cases} stortingssaker`);
if (result.skipped) console.log(`hoppet over ${result.skipped} filer som ikke lot seg lese`);
