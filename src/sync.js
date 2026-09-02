#!/usr/bin/env node
import { sync } from "./corpus.js";
import { dbPath } from "./db.js";

const result = await sync({ log: (m) => console.log(m) });
console.log(`indeks: ${dbPath()}`);
if (result.skipped) console.log(`hoppet over ${result.skipped} filer som ikke lot seg lese`);
