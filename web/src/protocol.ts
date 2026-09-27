import {
  encodeAbiParameters,
  keccak256,
  parseAbi,
  parseAbiParameters,
  parseUnits,
  type Address,
} from "viem";

// Minimal published protocol interfaces. Deployed application ABIs are loaded from the manifest.
export const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
export const managerAbi = parseAbi([
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
]);
export const permit2Abi = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);
export const routerAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
  "error ExecutionFailed(uint256 commandIndex, bytes message)",
]);
export const quoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
export const poolKeyParameters = parseAbiParameters(
  "(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)",
);
export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};
export function poolId(key: PoolKey) {
  return keccak256(encodeAbiParameters(poolKeyParameters, [key]));
}
export function rateAt(elapsed: bigint) {
  return elapsed >= 1000n
    ? 30n
    : 5000n - (4970n * (elapsed < 0n ? 0n : elapsed)) / 1000n;
}
export function inputFee(amount: bigint, rate: bigint) {
  return (amount * rate) / 10000n;
}
export function amountFromText(text: string, decimals: number) {
  if (
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) ||
    (text.split(".")[1]?.length ?? 0) > decimals
  )
    throw new Error(
      `Enter a positive amount with at most ${decimals} decimal places.`,
    );
  const amount = parseUnits(text, decimals);
  if (amount <= 0n || amount > (1n << 127n) - 1n)
    throw new Error(
      "Enter an amount greater than zero within the supported swap limit.",
    );
  return amount;
}
export function slippageFromText(text: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(text))
    throw new Error(
      "Enter slippage from 0.01% to 5%, with at most two decimal places.",
    );
  const bps = Number(text) * 100;
  if (bps < 1 || bps > 500) throw new Error("Enter slippage from 0.01% to 5%.");
  return BigInt(Math.round(bps));
}
export function minimumOut(output: bigint, bps: bigint) {
  return (output * (10000n - bps)) / 10000n;
}
export function swapArguments(
  key: PoolKey,
  buy: boolean,
  amount: bigint,
  minimum: bigint,
  deadline: bigint,
) {
  const input = buy ? key.currency0 : key.currency1;
  const output = buy ? key.currency1 : key.currency0;
  const params = [
    encodeAbiParameters(
      parseAbiParameters(
        "((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)",
      ),
      [
        {
          poolKey: key,
          zeroForOne: buy,
          amountIn: amount,
          amountOutMinimum: minimum,
          hookData: "0x",
        },
      ],
    ),
    encodeAbiParameters(parseAbiParameters("address, uint256"), [
      input,
      amount,
    ]),
    encodeAbiParameters(parseAbiParameters("address, uint256"), [
      output,
      minimum,
    ]),
  ];
  return {
    args: [
      "0x10",
      [
        encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [
          "0x060c0f",
          params,
        ]),
      ],
      deadline,
    ] as const,
    value: buy ? amount : 0n,
  };
}
export function errorMessage(error: unknown): string {
  const e = error as {
    code?: number;
    shortMessage?: string;
    message?: string;
    cause?: unknown;
  };
  if (
    e.code === 4001 ||
    /user rejected|user denied/i.test(e.shortMessage ?? e.message ?? "")
  )
    return "Request declined in your wallet. Nothing else was submitted; try again when ready.";
  return (
    e.shortMessage ??
    e.message ??
    "Request failed. Check your connection and try again."
  ).slice(0, 600);
}
export async function switchOrAdd(
  provider: {
    request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  },
  chainId: `0x${string}`,
  addChain: unknown,
) {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }],
    });
  } catch (error) {
    const e = error as {
      code?: number;
      message?: string;
      data?: { originalError?: { code?: number } };
      cause?: { code?: number };
    };
    if (
      e.code !== 4902 &&
      e.data?.originalError?.code !== 4902 &&
      e.cause?.code !== 4902 &&
      !/unknown chain|unrecognized chain|not added/i.test(e.message ?? "")
    )
      throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [addChain],
    });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }],
    });
  }
}
