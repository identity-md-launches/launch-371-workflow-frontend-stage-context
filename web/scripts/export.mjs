import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { keccak256, toBytes } from "viem";
import { canonical } from "../src/config.ts";
const root = new URL("../../", import.meta.url);
const handoff = JSON.parse(
  await readFile(new URL("../config/deployment-handoff.json", import.meta.url)),
);
const net = JSON.parse(
  await readFile(new URL("../config/network-handoff.json", import.meta.url)),
);
if (
  handoff.chainId !== net.network.chainId ||
  handoff.chainId !== Number(net.walletAddChain.chainId)
)
  throw new Error("Network mismatch");
await mkdir(new URL("dist/abi/", root), { recursive: true });
const contracts = [];
for (const item of handoff.contracts) {
  const path = `docs/abi/${item.name}.json`;
  const pinned = execFileSync(
    "git",
    ["show", `${handoff.sourceCommit}:${path}`],
    { cwd: root },
  );
  const local = await readFile(new URL(path, root));
  if (!local.equals(pinned))
    throw new Error(`ABI differs from pinned source: ${path}`);
  const abi = JSON.parse(pinned);
  if (
    !Array.isArray(abi) ||
    keccak256(toBytes(canonical(abi))).slice(2) !== item.abiHash
  )
    throw new Error(`ABI hash mismatch: ${item.name}`);
  const abiPath = `abi/${item.name}.json`;
  await writeFile(new URL(`dist/${abiPath}`, root), pinned);
  contracts.push({
    name: item.name,
    address: item.address,
    abiHash: item.abiHash,
    abiPath,
  });
  console.log(`Verified pinned ${item.name} ABI: ${item.abiHash}`);
}
async function walk(dir, prefix = "") {
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error("Symlinks are not exportable");
    const path = prefix + item.name;
    if (item.isDirectory())
      files.push(...(await walk(new URL(`${item.name}/`, dir), `${path}/`)));
    else if (path !== "imd-deployment.json") {
      const bytes = await readFile(new URL(item.name, dir));
      if (bytes.length > 8388608) throw new Error(`Oversize asset: ${path}`);
      files.push({
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
const assets = await walk(new URL("dist/", root));
if (assets.length > 128) throw new Error("Too many assets");
const manifest = {
  version: 1,
  launchId: handoff.launchId,
  chainId: handoff.chainId,
  sourceCommit: handoff.sourceCommit,
  attestationHash: handoff.attestationHash,
  contracts,
  assets,
  network: net.network,
  walletAddChain: net.walletAddChain,
  pool: handoff.manifest.pool,
  deploymentBlock: Math.min(...handoff.contracts.map((c) => c.blockNumber)),
};
await writeFile(
  new URL("dist/imd-deployment.json", root),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(`Manifest written after export: ${assets.length} assets.`);
