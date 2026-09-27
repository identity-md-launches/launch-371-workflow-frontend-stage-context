import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { canonical } from "../src/config.ts";
const root = new URL("../../", import.meta.url);
const d = JSON.parse(await readFile(new URL("dist/imd-deployment.json", root)));
const handoff = JSON.parse(
  await readFile(new URL("../config/deployment-handoff.json", import.meta.url)),
);
const net = JSON.parse(
  await readFile(new URL("../config/network-handoff.json", import.meta.url)),
);
for (const key of ["launchId", "chainId", "sourceCommit", "attestationHash"])
  assert.deepEqual(d[key], handoff[key]);
assert.deepEqual(d.network, net.network);
assert.deepEqual(d.walletAddChain, net.walletAddChain);
assert.deepEqual(d.pool, handoff.manifest.pool);
assert.deepEqual(
  d.contracts.map(({ name, address, abiHash }) => ({ name, address, abiHash })),
  handoff.contracts.map(({ name, address, abiHash }) => ({
    name,
    address,
    abiHash,
  })),
);
const files = (
  await readdir(new URL("dist/", root), {
    recursive: true,
    withFileTypes: true,
  })
)
  .filter((f) => f.isFile())
  .map((f) =>
    relative(fileURLToPath(new URL("dist/", root)), join(f.parentPath, f.name)),
  )
  .filter((f) => f !== "imd-deployment.json")
  .sort();
assert.deepEqual(d.assets.map((a) => a.path).sort(), files);
let total = 0;
for (const asset of d.assets) {
  assert.ok(
    !asset.path.startsWith("/") &&
      !asset.path.includes("..") &&
      !asset.path.includes("://"),
  );
  const bytes = await readFile(new URL(`dist/${asset.path}`, root));
  total += bytes.length;
  assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
  assert.ok(bytes.length <= 8388608);
}
for (const c of d.contracts) {
  const abi = JSON.parse(await readFile(new URL(`dist/${c.abiPath}`, root)));
  assert.ok(Array.isArray(abi));
  assert.equal(keccak256(toBytes(canonical(abi))).slice(2), c.abiHash);
}
assert.ok(d.assets.length <= 128);
assert.ok(total < 32 * 1024 * 1024);
const html = await readFile(new URL("dist/index.html", root), "utf8");
assert.ok(html.includes("./assets/"));
assert.ok(!html.includes('src="/assets/'));
console.log(
  `PASS: ${files.length} assets, ${total} bytes; all hashes, pinned contract set, network, pool, ABI bindings, and relative entrypoint checked.`,
);
