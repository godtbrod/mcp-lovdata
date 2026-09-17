import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function withClient(fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "src/index.js")],
    stderr: "pipe",
    // SDK-en gir barneprosessen et vasket miljø uten LOVDATA_DB, og da ville
    // testene lest brukerens egen indeks i stedet for den i testmappa.
    env: { ...process.env },
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

export const textOf = (res) => res.content.map((c) => c.text).join("\n");
