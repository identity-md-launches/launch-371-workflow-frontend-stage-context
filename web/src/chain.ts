import { getAbiItem, type AbiEvent, type Address, type Hex } from "viem";
import type { Runtime } from "./config";
import {
  managerAbi,
  permit2Abi,
  poolId,
  stateViewAbi,
  type PoolKey,
} from "./protocol";

export function makePool(runtime: Runtime): PoolKey {
  return {
    currency0: runtime.deployment.pool.pairedCurrency,
    currency1: runtime.token.address,
    fee: runtime.deployment.pool.fee,
    tickSpacing: runtime.deployment.pool.tickSpacing,
    hooks: runtime.hook.address,
  };
}
export async function verifyContracts(runtime: Runtime) {
  const { publicClient: client, deployment } = runtime;
  if ((await client.getChainId()) !== deployment.chainId)
    throw new Error(
      "Public RPC returned the wrong network. Transactions are disabled.",
    );
  const entries = [
    ...deployment.contracts,
    ...Object.entries(deployment.network.uniswapV4).map(([name, address]) => ({
      name,
      address,
    })),
  ];
  await Promise.all(
    entries.map(async ({ name, address }) => {
      const code = await client.getCode({ address });
      if (!code || code === "0x")
        throw new Error(
          `No deployed code at ${name}. Transactions are disabled.`,
        );
    }),
  );
  const manager = (await client.readContract({
    address: runtime.hook.address,
    abi: runtime.hook.abi,
    functionName: "poolManager",
  })) as Address;
  if (
    manager.toLowerCase() !==
    deployment.network.uniswapV4.poolManager.toLowerCase()
  )
    throw new Error("Hook PoolManager differs from the network configuration.");
  return true;
}
export async function readState(runtime: Runtime, account?: Address) {
  const { publicClient: client, deployment: d, hook, token } = runtime;
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const id = poolId(makePool(runtime));
  const hookView = (functionName: string, args?: readonly unknown[]) =>
    client.readContract({
      address: hook.address,
      abi: hook.abi,
      functionName,
      args,
      blockNumber,
    });
  const tokenView = (functionName: string, args?: readonly unknown[]) =>
    client.readContract({
      address: token.address,
      abi: token.abi,
      functionName,
      args,
      blockNumber,
    });
  const results = await Promise.all([
    hookView("currentRate", [id]),
    hookView("startBlock", [id]),
    hookView("blocksLeft", [id]),
    hookView("initialized", [id]),
    client.readContract({
      address: d.network.uniswapV4.stateView,
      abi: stateViewAbi,
      functionName: "getSlot0",
      args: [id],
      blockNumber,
    }),
    tokenView("decimals"),
    tokenView("symbol"),
    client.readContract({
      address: d.network.uniswapV4.poolManager,
      abi: managerAbi,
      functionName: "balanceOf",
      args: [hook.address, 0n],
      blockNumber,
    }),
    client.readContract({
      address: d.network.uniswapV4.poolManager,
      abi: managerAbi,
      functionName: "balanceOf",
      args: [hook.address, BigInt(token.address)],
      blockNumber,
    }),
    account ? client.getBalance({ address: account, blockNumber }) : 0n,
    account ? tokenView("balanceOf", [account]) : 0n,
    account
      ? tokenView("allowance", [account, d.network.uniswapV4.permit2])
      : 0n,
    account
      ? client.readContract({
          address: d.network.uniswapV4.permit2,
          abi: permit2Abi,
          functionName: "allowance",
          args: [account, token.address, d.network.uniswapV4.universalRouter],
          blockNumber,
        })
      : [0n, 0, 0],
    hookView("DEAD"),
  ]);
  const [
    rate,
    start,
    left,
    initialized,
    slot,
    decimals,
    symbol,
    ethClaims,
    tokenClaims,
    ethBalance,
    tokenBalance,
    allowance,
    permit,
    dead,
  ] = results as [
    bigint,
    bigint,
    bigint,
    boolean,
    readonly [bigint, number, number, number],
    number,
    string,
    bigint,
    bigint,
    bigint,
    bigint,
    bigint,
    readonly [bigint, number, number],
    Address,
  ];
  if (decimals < 0 || decimals > 36 || !Number.isInteger(decimals))
    throw new Error(
      "Unsupported token decimals. Transactions are unavailable.",
    );
  return {
    blockNumber,
    rate,
    start,
    left,
    initialized,
    sqrtPriceX96: slot[0],
    lpFee: slot[3],
    protocolFee: slot[2],
    decimals,
    symbol,
    ethClaims,
    tokenClaims,
    ethBalance,
    tokenBalance,
    allowance,
    permit,
    dead,
    account,
    fetchedAt: Date.now(),
  };
}
export type PoolState = Awaited<ReturnType<typeof readState>>;
export type FeeEvent = {
  txHash: Hex;
  block: bigint;
  rate?: bigint;
  currency: Address;
  fee: bigint;
  index: number;
  kind: string;
};
export async function readEvents(runtime: Runtime) {
  const { publicClient: client, deployment, hook } = runtime;
  const toBlock = await client.getBlockNumber({ cacheTime: 0 });
  const start = BigInt(deployment.deploymentBlock);
  const fromBlock = toBlock - start > 1999n ? toBlock - 1999n : start;
  const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
  for (let from = fromBlock; from <= toBlock; from += 500n)
    ranges.push({
      fromBlock: from,
      toBlock: from + 499n < toBlock ? from + 499n : toBlock,
    });
  const charged = getAbiItem({ abi: hook.abi, name: "FeeCharged" }) as AbiEvent;
  const burned = getAbiItem({ abi: hook.abi, name: "FeesBurned" }) as AbiEvent;
  const chunks = await Promise.all(
    ranges.map(async (range) => {
      const [charges, burns] = await Promise.all([
        client.getLogs({
          address: hook.address,
          event: charged,
          args: { poolId: poolId(makePool(runtime)) },
          ...range,
          strict: true,
        }),
        client.getLogs({
          address: hook.address,
          event: burned,
          ...range,
          strict: true,
        }),
      ]);
      const fees: FeeEvent[] = charges.map((log) => {
        const args = log.args as unknown as {
          blockNumber: bigint;
          rate: bigint;
          currency: Address;
          fee: bigint;
        };
        return {
          txHash: log.transactionHash!,
          block: args.blockNumber,
          rate: args.rate,
          currency: args.currency,
          fee: args.fee,
          index: log.logIndex!,
          kind: "Fee charged",
        };
      });
      const redemptions: FeeEvent[] = burns.flatMap((log) => {
        const args = log.args as unknown as {
          currency: Address;
          amount: bigint;
        };
        if (
          ![
            runtime.token.address.toLowerCase(),
            deployment.pool.pairedCurrency.toLowerCase(),
          ].includes(args.currency.toLowerCase())
        )
          return [];
        return [
          {
            txHash: log.transactionHash!,
            block: log.blockNumber!,
            currency: args.currency,
            fee: args.amount,
            index: log.logIndex!,
            kind: "Fees burned",
          },
        ];
      });
      return [...fees, ...redemptions];
    }),
  );
  const events = chunks
    .flat()
    .sort((a, b) =>
      a.block === b.block ? b.index - a.index : a.block > b.block ? -1 : 1,
    )
    .slice(0, 12);
  return { events, fromBlock, toBlock };
}
