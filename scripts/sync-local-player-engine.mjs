import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const source = new URL("../../pakakumi-fully-local-player/src/", import.meta.url);
const targets = [
  new URL("../src/utils/local-player/", import.meta.url),
  new URL("../../pakakumi-local-bot/src/utils/local-player/", import.meta.url),
];
const files = ["types.ts", ...["adaptive", "config", "core", "engine", "runner"].map(name => `strategy/${name}.ts`)];
const check = process.argv.includes("--check");

for (const file of files) {
  const input = await readFile(new URL(file, source), "utf8");
  const content = `// Generated from pakakumi-fully-local-player/src/${file} by sync-local-player-engine.mjs.\n${input.replace(/\r\n/g, "\n")}`;
  for (const target of targets) {
    const output = new URL(file, target);
    if (check) {
      const actual = await readFile(output, "utf8");
      if (actual.replace(/\r\n/g, "\n") !== content) throw new Error(`Out of date: ${fileURLToPath(output)}`);
    } else {
      await mkdir(dirname(fileURLToPath(output)), { recursive: true });
      await writeFile(output, content);
    }
  }
}
