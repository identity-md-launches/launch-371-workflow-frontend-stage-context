import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeAbiParameters, parseAbiParameters } from "viem";
import {
  amountFromText,
  inputFee,
  minimumOut,
  rateAt,
  slippageFromText,
  swapArguments,
  switchOrAdd,
} from "../src/protocol.ts";

test("fee boundaries match integer Solidity rounding", () => {
  assert.deepEqual([0n, 1n, 500n, 999n, 1000n, 2000n].map(rateAt), [
    5000n,
    4996n,
    2515n,
    35n,
    30n,
    30n,
  ]);
  assert.equal(inputFee(1n, 5000n), 0n);
  assert.equal(inputFee(10001n, 30n), 30n);
  for (let e = 0n; e < 1000n; e++) assert.ok(rateAt(e) >= rateAt(e + 1n));
});
test("exact decimal input rejects rounding, scientific notation, nonpositive and overflow", () => {
  assert.equal(amountFromText("0.000001", 6), 1n);
  for (const value of ["1e5", "-2", "0", "01", "NaN", "0.0000001", "1.", " 1"])
    assert.throws(() => amountFromText(value, 6));
  assert.throws(() => amountFromText((2n ** 127n).toString(), 0));
  assert.equal(slippageFromText("0.01"), 1n);
  for (const value of ["0", "5.01", "0.001", "NaN", "-1"])
    assert.throws(() => slippageFromText(value));
  assert.equal(minimumOut(10001n, 50n), 9950n);
});
test("both swap directions encode exact input, settlement cap and minimum output", () => {
  const key = {
    currency0: "0x0000000000000000000000000000000000000000" as const,
    currency1: "0x0000000000000000000000000000000000000011" as const,
    fee: 3000,
    tickSpacing: 60,
    hooks: "0x00000000000000000000000000000000000010cc" as const,
  };
  for (const buy of [true, false]) {
    const result = swapArguments(key, buy, 123n, 80n, 1000n);
    assert.equal(result.value, buy ? 123n : 0n);
    assert.equal(result.args[0], "0x10");
    assert.equal(result.args[2], 1000n);
    const [actions, params] = decodeAbiParameters(
      parseAbiParameters("bytes, bytes[]"),
      result.args[1][0],
    );
    assert.equal(actions, "0x060c0f");
    const [swap] = decodeAbiParameters(
      parseAbiParameters(
        "((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)",
      ),
      params[0],
    );
    assert.equal(swap.zeroForOne, buy);
    assert.equal(swap.amountIn, 123n);
    assert.equal(swap.amountOutMinimum, 80n);
    assert.equal(swap.hookData, "0x");
    assert.deepEqual(
      decodeAbiParameters(parseAbiParameters("address, uint256"), params[1]),
      [buy ? key.currency0 : key.currency1, 123n],
    );
    assert.deepEqual(
      decodeAbiParameters(parseAbiParameters("address, uint256"), params[2]),
      [buy ? key.currency1 : key.currency0, 80n],
    );
  }
});
test("unknown chain offers exact add-chain parameters then retries switch", async () => {
  const calls: unknown[] = [];
  let first = true;
  const chain = { chainId: "0xaa36a7", chainName: "Sepolia" };
  await switchOrAdd(
    {
      request: async (args) => {
        calls.push(args);
        if (first) {
          first = false;
          throw { code: 4902 };
        }
      },
    },
    "0xaa36a7",
    chain,
  );
  assert.deepEqual(calls, [
    { method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] },
    { method: "wallet_addEthereumChain", params: [chain] },
    { method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] },
  ]);
});
test("wallet rejection does not trigger add-chain or another request", async () => {
  let count = 0;
  await assert.rejects(
    switchOrAdd(
      {
        request: async () => {
          count++;
          throw { code: 4001 };
        },
      },
      "0xaa36a7",
      {},
    ),
  );
  assert.equal(count, 1);
});
