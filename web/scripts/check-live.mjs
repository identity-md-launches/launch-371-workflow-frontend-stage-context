import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPublicClient, custom } from "viem";
import {
  poolId,
  stateViewAbi,
  managerAbi,
  quoterAbi,
} from "../src/protocol.ts";
const run = promisify(execFile);
const d = JSON.parse(
  await readFile(new URL("../../dist/imd-deployment.json", import.meta.url)),
);
const token = d.contracts.find((c) => c.name === "SNIP");
const hook = d.contracts.find((c) => c.name === "AntiSniperDecayHook");
const abi = JSON.parse(
  await readFile(new URL(`../../dist/${hook.abiPath}`, import.meta.url)),
);
const tokenAbi = JSON.parse(
  await readFile(new URL(`../../dist/${token.abiPath}`, import.meta.url)),
);
let requestId = 1;
const failures = [];
let endpoint;
const client = createPublicClient({
  transport: custom(
    {
      async request({ method, params }) {
        for (const url of d.network.rpcUrls) {
          try {
            const { stdout } = await run(
              "curl",
              [
                "--silent",
                "--show-error",
                "--fail",
                "--max-time",
                "18",
                "-H",
                "Content-Type: application/json",
                "--data",
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: requestId++,
                  method,
                  params,
                }),
                url,
              ],
              { maxBuffer: 2 * 1024 * 1024 },
            );
            const result = JSON.parse(stdout);
            if (result.error) {
              const error = new Error(result.error.message);
              error.code = result.error.code;
              error.data = result.error.data;
              throw error;
            }
            endpoint = url;
            return result.result;
          } catch (e) {
            failures.push({
              url,
              method,
              message: e.message.slice(0, 180),
              ...(e.data ? { data: e.data } : {}),
            });
          }
        }
        throw new Error(`All configured public RPCs failed: ${method}`);
      },
    },
    { retryCount: 0 },
  ),
});
const output = {
  checkedAt: new Date().toISOString(),
  sourceCommit: d.sourceCommit,
  scope: "Read-only public RPC checks. No transaction or signature submitted.",
  failures,
};
try {
  output.chainId = await client.getChainId();
  if (output.chainId !== d.chainId) throw new Error("Chain mismatch");
  const block = process.argv[2] ? BigInt(process.argv[2]) : await client.getBlockNumber();
  output.blockNumber = block.toString();
  const contracts = [
    ...d.contracts,
    ...Object.entries(d.network.uniswapV4).map(([name, address]) => ({
      name,
      address,
    })),
  ];
  output.code = [];
  for (const c of contracts) {
    const code = await client.getCode({
      address: c.address,
      blockNumber: block,
    });
    if (!code || code === "0x") throw new Error(`No code: ${c.name}`);
    output.code.push({
      name: c.name,
      address: c.address,
      bytes: (code.length - 2) / 2,
    });
  }
  const key = {
    currency0: d.pool.pairedCurrency,
    currency1: token.address,
    fee: d.pool.fee,
    tickSpacing: d.pool.tickSpacing,
    hooks: hook.address,
  };
  const id = poolId(key);
  output.poolId = id;
  output.views = {};
  for (const functionName of [
    "initialized",
    "currentRate",
    "startBlock",
    "blocksLeft",
    "poolManager",
    "DEAD",
  ])
    output.views[functionName] = await client.readContract({
      address: hook.address,
      abi,
      functionName,
      args: ["poolManager", "DEAD"].includes(functionName) ? [] : [id],
      blockNumber: block,
    });
  output.slot0 = await client.readContract({
    address: d.network.uniswapV4.stateView,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: [id],
    blockNumber: block,
  });
  output.decimals = await client.readContract({
    address: token.address,
    abi: tokenAbi,
    functionName: "decimals",
    blockNumber: block,
  });
  output.claims = {};
  for (const [name, currency] of [
    ["ETH", key.currency0],
    ["SNIP", key.currency1],
  ])
    output.claims[name] = await client.readContract({
      address: d.network.uniswapV4.poolManager,
      abi: managerAbi,
      functionName: "balanceOf",
      args: [hook.address, BigInt(currency)],
      blockNumber: block,
    });
  output.quotes = [];
  for (const [side, amount] of [
    ["buy", 100000000000000n],
    ["sell", 1000000000000000000n],
  ]) {
    try {
      const result = await client.simulateContract({
        address: d.network.uniswapV4.quoter,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            poolKey: key,
            zeroForOne: side === "buy",
            exactAmount: amount,
            hookData: "0x",
          },
        ],
        blockNumber: block,
      });
      output.quotes.push({ side, amount, result: result.result });
    } catch (e) {
      output.quotes.push({ side, amount, error: e.shortMessage ?? e.message });
    }
  }
  output.endpoint = endpoint;
  output.result = "Read checks passed";
} catch (e) {
  output.result = "Read checks incomplete";
  output.error = e.shortMessage ?? e.message;
  process.exitCode = 1;
}
await writeFile(
  new URL("../../docs/evidence/live-read.json", import.meta.url),
  JSON.stringify(
    output,
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    output,
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  ),
);
