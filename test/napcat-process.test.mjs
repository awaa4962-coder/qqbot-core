import assert from "node:assert/strict";
import { test } from "node:test";

import { hasNapCatProcess } from "../scripts/napcat-process.mjs";

test("NapCat process discovery is scoped to the selected runtime directory", async () => {
  let command = "";
  const found = await hasNapCatProcess({
    runtimeDir: "C:\\qqfriend\\NapCat\\NapCat.v4.18.13.Shell",
    execFileAsync: async (_file, args) => {
      command = args.at(-1);
      return { stdout: "1234\r\n" };
    },
  });

  assert.equal(found, true);
  assert.match(command, /NapCat\.v4\.18\.13\.Shell/);
  assert.match(command, /NapCatWinBootMain\.exe/);
  assert.match(command, /QQ\.exe/);
});

test("NapCat process discovery treats an empty query as not running", async () => {
  assert.equal(await hasNapCatProcess({ runtimeDir: "" }), false);
});
