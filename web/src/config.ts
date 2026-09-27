import {
  createPublicClient,
  defineChain,
  fallback,
  http,
  keccak256,
  toBytes,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
export type Deployment = {
  version: 1;
  launchId: string;
  chainId: number;
  sourceCommit: string;
  attestationHash: string;
  contracts: {
    name: string;
    address: Address;
    abiHash: string;
    abiPath: string;
  }[];
  assets: { path: string; sha256: string }[];
  pool: {
    fee: number;
    tickSpacing: number;
    pairedCurrency: Address;
    initialPrice: string;
  };
  deploymentBlock: number;
  network: {
    chainId: number;
    name: string;
    testnet: boolean;
    rpcUrls: string[];
    explorer: string;
    nativeCurrency: { name: string; symbol: string; decimals: number };
    faucets: string[];
    uniswapV4: Record<
      | "poolManager"
      | "universalRouter"
      | "quoter"
      | "stateView"
      | "positionManager"
      | "permit2",
      Address
    >;
  };
  walletAddChain: {
    chainId: Hex;
    chainName: string;
    rpcUrls: string[];
    nativeCurrency: { name: string; symbol: string; decimals: number };
    blockExplorerUrls: string[];
  };
};
const relativePath = (path: string) =>
  /^[a-zA-Z0-9_./-]+$/.test(path) &&
  !path.startsWith("/") &&
  !path.split("/").includes("..");
export async function loadDeployment() {
  const response = await fetch("./imd-deployment.json", { cache: "no-cache" });
  if (!response.ok)
    throw new Error(
      "Deployment configuration could not load. Reload this page.",
    );
  const deployment = (await response.json()) as Deployment;
  if (
    deployment.version !== 1 ||
    deployment.chainId !== deployment.network.chainId ||
    Number(deployment.walletAddChain.chainId) !== deployment.chainId ||
    deployment.contracts.length !== 2 ||
    deployment.pool.pairedCurrency !==
      "0x0000000000000000000000000000000000000000"
  )
    throw new Error(
      "Deployment configuration is inconsistent. Transactions are unavailable.",
    );
  const abis: Record<string, Abi> = {};
  for (const contract of deployment.contracts) {
    if (!relativePath(contract.abiPath)) throw new Error("Invalid ABI path.");
    const response = await fetch(`./${contract.abiPath}`);
    if (!response.ok)
      throw new Error(
        `Could not load the ${contract.name} interface. Reload this page.`,
      );
    const abi = await response.json();
    if (
      !Array.isArray(abi) ||
      keccak256(toBytes(canonical(abi))).slice(2) !== contract.abiHash
    )
      throw new Error(
        `${contract.name} ABI verification failed. Transactions are unavailable.`,
      );
    abis[contract.name] = abi;
  }
  const contract = (name: string) => {
    const found = deployment.contracts.find((item) => item.name === name);
    if (!found || !abis[name]) throw new Error(`Missing ${name} deployment.`);
    return { ...found, abi: abis[name] };
  };
  const chain = defineChain({
    id: deployment.chainId,
    name: deployment.network.name,
    nativeCurrency: deployment.network.nativeCurrency,
    rpcUrls: { default: { http: deployment.network.rpcUrls } },
    blockExplorers: {
      default: { name: "Explorer", url: deployment.network.explorer },
    },
    testnet: deployment.network.testnet,
  });
  const transport = () =>
    fallback(
      deployment.network.rpcUrls.map((url) =>
        http(url, { timeout: 9000, retryCount: 1 }),
      ),
      { rank: false },
    );
  return {
    deployment,
    chain,
    hook: contract("AntiSniperDecayHook"),
    token: contract("SNIP"),
    publicClient: createPublicClient({ chain, transport: transport() }),
    wagmi: createConfig({
      chains: [chain],
      connectors: [injected()],
      multiInjectedProviderDiscovery: true,
      transports: { [chain.id]: transport() },
    }),
  };
}
export type Runtime = Awaited<ReturnType<typeof loadDeployment>>;
