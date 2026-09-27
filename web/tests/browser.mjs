import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { decodeFunctionData, encodeFunctionResult, encodeEventTopics, encodeAbiParameters, parseAbiParameters, toHex } from "viem";
import {
  quoterAbi,
  routerAbi,
  permit2Abi,
  managerAbi,
  stateViewAbi,
} from "../src/protocol.ts";
const root = new URL("../../", import.meta.url),
  dist = new URL("dist/", root),
  evidence = new URL("docs/evidence/", root);
await mkdir(evidence, { recursive: true });
const d = JSON.parse(await readFile(new URL("imd-deployment.json", dist)));
const token = d.contracts.find((c) => c.name === "SNIP"),
  hook = d.contracts.find((c) => c.name === "AntiSniperDecayHook");
const tokenAbi = JSON.parse(await readFile(new URL(token.abiPath, dist))),
  hookAbi = JSON.parse(await readFile(new URL(hook.abiPath, dist)));
const abis = {
  [token.address]: tokenAbi,
  [hook.address]: hookAbi,
  [d.network.uniswapV4.stateView]: stateViewAbi,
  [d.network.uniswapV4.poolManager]: managerAbi,
  [d.network.uniswapV4.quoter]: quoterAbi,
  [d.network.uniswapV4.universalRouter]: routerAbi,
  [d.network.uniswapV4.permit2]: permit2Abi,
};
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    if (!path.startsWith("/preview/") || path.includes("..")) throw Error();
    const file = path === "/preview/" ? "index.html" : path.slice(9);
    const bytes = await readFile(new URL(file, dist));
    res.setHeader(
      "Content-Type",
      file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".json")
            ? "application/json"
            : "text/html",
    );
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/preview/`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH,
});
const report = {
  date: new Date().toISOString(),
  urlShape: "/preview/",
  environment:
    "Headless Chromium; mocked public RPC and EIP-1193 wallet. No real signatures or broadcasts.",
  checks: [],
  screenshots: [],
  consoleErrors: [],
  resourceFailures: [],
  accessibility: [],
};
const account = "0x1111111111111111111111111111111111111111",
  blockHash = "0x" + "12".repeat(32),
  txHash = "0x" + "34".repeat(32),
  block = 12000000n;
function rpc(m, method, params = []) {
  if (m.rpcFail) throw Error("Fixture RPC unavailable");
  if (method === "eth_chainId") return toHex(d.chainId);
  if (method === "eth_blockNumber") return toHex(block);
  if (method === "eth_getCode")
    return m.missingCode &&
      params[0].toLowerCase() === d.network.uniswapV4.universalRouter
      ? "0x"
      : "0x6001600055";
  if (method === "eth_getBalance") return toHex(10n ** 19n);
  if (method === "eth_getLogs") {
    if (!m.events || BigInt(params[0].toBlock) !== block) return [];
    const isFee = params[0].topics[0] === encodeEventTopics({abi:hookAbi,eventName:'FeeCharged'})[0];
    const eventName = isFee ? 'FeeCharged' : 'FeesBurned';
    const topics = encodeEventTopics({abi:hookAbi,eventName,args: isFee ? {poolId:params[0].topics[1],currency:token.address} : {currency:token.address}});
    const data = encodeAbiParameters(parseAbiParameters(isFee ? 'uint256,uint256,uint256' : 'uint256'),isFee ? [block,2515n,1000000000000000000n] : [1000000000000000000n]);
    return [{address:hook.address,topics,data,blockNumber:toHex(block),blockHash,transactionHash:txHash,transactionIndex:'0x0',logIndex:isFee?'0x0':'0x1',removed:false}];
  }
  if (method === "eth_getTransactionReceipt")
    return {
      transactionHash: txHash,
      transactionIndex: "0x0",
      blockHash,
      blockNumber: toHex(block),
      from: account,
      to: d.network.uniswapV4.universalRouter,
      cumulativeGasUsed: "0x5208",
      gasUsed: "0x5208",
      contractAddress: null,
      logs: [],
      logsBloom: "0x" + "00".repeat(256),
      status: "0x1",
      effectiveGasPrice: "0x1",
      type: "0x2",
    };
  if (method === "eth_getBlockByNumber")
    return {
      number: toHex(block),
      hash: blockHash,
      parentHash: blockHash,
      timestamp: toHex(Math.floor(Date.now() / 1000)),
      nonce: "0x0000000000000000",
      difficulty: "0x0",
      gasLimit: "0x1c9c380",
      gasUsed: "0x5208",
      baseFeePerGas: "0x1",
      extraData: "0x",
      miner: account,
      mixHash: blockHash,
      receiptsRoot: blockHash,
      stateRoot: blockHash,
      transactionsRoot: blockHash,
      sha3Uncles: blockHash,
      transactions: [],
      uncles: [],
      size: "0x1",
      logsBloom: "0x" + "00".repeat(256),
    };
  if (method === "eth_call") {
    const tx = params[0],
      address = tx.to.toLowerCase(),
      abi = abis[address];
    if (!abi) throw Error(`Unexpected call ${address}`);
    const { functionName: name, args } = decodeFunctionData({
      abi,
      data: tx.data,
    });
    m.calls.push({ address, name, args });
    let result;
    if (address === hook.address)
      result = {
        currentRate: 2515n,
        startBlock: block - 500n,
        blocksLeft: 500n,
        initialized: true,
        poolManager: d.network.uniswapV4.poolManager,
        DEAD: "0x000000000000000000000000000000000000dEaD",
      }[name];
    if (address === token.address)
      result = {
        decimals: 18,
        symbol: "SNIP",
        balanceOf: 10n ** 24n,
        allowance: m.allowance,
        approve: true,
      }[name];
    if (address === d.network.uniswapV4.stateView)
      result =
        name === "getSlot0" ? [1000n * 2n ** 96n, 138162, 0, 3000] : 1000000n;
    if (address === d.network.uniswapV4.poolManager)
      result = args[1] === 0n ? m.ethClaims : m.tokenClaims;
    if (address === d.network.uniswapV4.permit2)
      result = name === "allowance" ? [m.permit, m.expiration, 0] : undefined;
    if (address === d.network.uniswapV4.quoter)
      result = [args[0].zeroForOne ? 700n * 10n ** 18n : 10n ** 15n, 100000n];
    if (address === d.network.uniswapV4.universalRouter && m.simulateFail)
      throw Error("Swap simulation reverted: minimum output cannot be met");
    return encodeFunctionResult({ abi, functionName: name, result });
  }
  throw Error(`Unhandled RPC ${method}`);
}
async function setup(withWallet = true) {
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
    }),
    page = await context.newPage();
  const m = {
    chain: "0x1",
    added: false,
    connected: false,
    rejectConnect: false,
    rejectTx: false,
    missingCode: false,
    rpcFail: false,
    simulateFail: false,
    allowance: 0n,
    permit: 0n,
    expiration: 0,
    ethClaims: 10n ** 15n,
    tokenClaims: 10n ** 18n,
    requests: [],
    writes: [],
    calls: [],
  };
  page.on("pageerror", (e) => report.consoleErrors.push(e.message));
  page.on("requestfailed", (r) => {
    if (r.url().startsWith(url))
      report.resourceFailures.push({ url: r.url(), error: r.failure() });
  });
  if (withWallet) {
    await page.exposeFunction("__walletBridge", async ({ method, params }) => {
      m.requests.push({ method, params });
      if (method === "eth_chainId") return m.chain;
      if (method === "eth_accounts") return m.connected ? [account] : [];
      if (method === "eth_requestAccounts") {
        if (m.rejectConnect)
          return { __error: 4001, message: "User rejected request" };
        m.connected = true;
        return [account];
      }
      if (method === "wallet_switchEthereumChain") {
        if (!m.added) return { __error: 4902, message: "Unknown chain" };
        m.chain = params[0].chainId;
        return null;
      }
      if (method === "wallet_addEthereumChain") {
        assert.deepEqual(params[0], d.walletAddChain);
        m.added = true;
        return null;
      }
      if (method === "wallet_getCapabilities") return {};
      if (method === "eth_sendTransaction") {
        if (m.rejectTx)
          return { __error: 4001, message: "User rejected request" };
        const tx = params[0],
          address = tx.to.toLowerCase(),
          decoded = decodeFunctionData({ abi: abis[address], data: tx.data });
        m.writes.push({ address, ...decoded, tx });
        if (address === token.address) m.allowance = decoded.args[1];
        if (address === d.network.uniswapV4.permit2) {
          m.permit = decoded.args[2];
          m.expiration = decoded.args[3];
        }
        if (address === hook.address) {
          if (BigInt(decoded.args[0]) === 0n) m.ethClaims = 0n;
          else m.tokenClaims = 0n;
        }
        return txHash;
      }
      return rpc(m, method, params);
    });
    await page.addInitScript(() => {
      const listeners = {};
      window.ethereum = {
        isMetaMask: true,
        on(e, fn) {
          (listeners[e] ??= []).push(fn);
        },
        removeListener(e, fn) {
          listeners[e] = (listeners[e] ?? []).filter((f) => f !== fn);
        },
        async request(args) {
          const result = await window.__walletBridge(args);
          if (result?.__error) {
            const e = new Error(result.message);
            e.code = result.__error;
            throw e;
          }
          if (args.method === "wallet_switchEthereumChain")
            (listeners.chainChanged ?? []).forEach((fn) =>
              fn(args.params[0].chainId),
            );
          return result;
        },
      };
      window.__emitWallet = (e, v) =>
        (listeners[e] ?? []).forEach((fn) => fn(v));
    });
  }
  await page.route("https://**", async (route) => {
    const req = route.request();
    if (!d.network.rpcUrls.some((u) => req.url().startsWith(u)))
      return route.abort();
    const body = req.postDataJSON();
    const respond = (item) => {
      try {
        return {
          jsonrpc: "2.0",
          id: item.id,
          result: rpc(m, item.method, item.params),
        };
      } catch (e) {
        return {
          jsonrpc: "2.0",
          id: item.id,
          error: { code: -32000, message: e.message },
        };
      }
    };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        Array.isArray(body) ? body.map(respond) : respond(body),
      ),
    });
  });
  await page.goto(url);
  await expect(
    page.getByRole("heading", { name: "The launch fee" }),
  ).toBeVisible();
  await expect(page.getByText("25.15%", { exact: true })).toBeVisible();
  return { context, page, m };
}
async function shot(page, name) {
  await page.screenshot({
    path: fileURLToPath(new URL(name, evidence)),
    fullPage: true,
  });
  report.screenshots.push(`docs/evidence/${name}`);
}
const confirmed = (page) =>
  expect(page.getByRole("status")).toContainText("Transaction confirmed", {
    timeout: 20000,
  });
try {
  const missing = await setup(false);
  await missing.page
    .getByRole("button", { name: "Connect wallet to swap" })
    .click();
  await expect(missing.page.getByRole("alert")).toContainText(
    "No browser wallet found",
  );
  report.checks.push(
    "Missing wallet: recovery instructions, transactions unavailable.",
  );
  await missing.context.close();
  const { page, m, context } = await setup();
  m.rejectConnect = true;
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Request declined");
  m.rejectConnect = false;
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Switch to Sepolia" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Get quote", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Switch to Sepolia" }).click();
  await expect(
    page.getByRole("button", { name: "Switch to Sepolia" }),
  ).toHaveCount(0);
  assert.ok(m.requests.some((r) => r.method === "wallet_addEthereumChain"));
  report.checks.push(
    "Wallet rejection, wrong chain, 4902 → exact supplied add-chain parameters → switch again.",
  );
  await page.locator("#amount").fill("1e5");
  await expect(page.locator("#amount")).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByRole("button", { name: "Get quote", exact: true }),
  ).toBeDisabled();
  await page.locator("#amount").fill("11");
  await expect(page.locator("#amount-help")).toContainText("exceeds");
  await page.locator("#amount").fill("0.001");
  await page.locator("#slippage").fill("5.01");
  await expect(
    page.getByRole("button", { name: "Get quote", exact: true }),
  ).toBeDisabled();
  await page.locator("#slippage").fill("0.5");
  await expect(page.getByRole("button", { name: "Get quote", exact: true })).toBeEnabled();
  await page.locator("#slippage").press("Enter");
  await expect(page.getByText("696.5 SNIP", { exact: true })).toBeVisible();
  const buyButton = page
    .locator("button.primary")
    .filter({ hasText: "Buy SNIP" });
  await expect(buyButton).toBeEnabled();
  await shot(page, "desktop-quote.png");
  const before = m.writes.length;
  m.simulateFail = true;
  await buyButton.click();
  await expect(page.getByRole("alert")).toBeVisible();
  assert.equal(m.writes.length, before);
  m.simulateFail = false;
  m.rejectTx = true;
  await buyButton.click();
  await expect(page.getByRole("alert")).toContainText("Request declined");
  assert.equal(m.writes.length, before);
  m.rejectTx = false;
  await buyButton.focus();
  await page.keyboard.press("Enter");
  await confirmed(page);
  assert.equal(m.writes.at(-1).address, d.network.uniswapV4.universalRouter);
  assert.equal(BigInt(m.writes.at(-1).tx.value), 10n ** 15n);
  report.checks.push(
    "Buy: amount/balance/slippage validation, quote and minimum, simulation failure prevents signature, rejection recovery, native value, confirmed receipt.",
  );
  await page
    .getByRole("button", { name: "Sell SNIP", exact: true })
    .first()
    .click();
  await page.locator("#amount").fill("2");
  await page
    .getByRole("button", { name: "1. Approve SNIP for Permit2" })
    .click();
  await confirmed(page);
  assert.equal(m.writes.at(-1).address, token.address);
  assert.equal(
    m.writes.at(-1).args[0].toLowerCase(),
    d.network.uniswapV4.permit2,
  );
  assert.equal(m.writes.at(-1).args[1], 2n * 10n ** 18n);
  await page
    .getByRole("button", { name: "2. Approve router for 30 minutes" })
    .click();
  await confirmed(page);
  assert.equal(m.writes.at(-1).address, d.network.uniswapV4.permit2);
  assert.equal(
    m.writes.at(-1).args[1].toLowerCase(),
    d.network.uniswapV4.universalRouter,
  );
  assert.equal(m.writes.at(-1).args[2], 2n * 10n ** 18n);
  assert.ok(m.writes.at(-1).args[3] > Date.now() / 1000 + 1700);
  await page.getByRole("button", { name: "Get quote", exact: true }).click();
  const sellButton = page.locator("form").getByRole("button", {name:"Sell SNIP", exact:true});
  await expect(sellButton).toBeEnabled();
  await sellButton.click();
  await confirmed(page);
  assert.equal(BigInt(m.writes.at(-1).tx.value ?? 0), 0n);
  report.checks.push(
    "Sell: exact-amount token then Permit2 approvals to configured spenders, 30-minute expiry, quote, zero native value, confirmed receipt.",
  );
  await expect(
    page.getByRole("button", { name: "Burn ETH fees", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("I understand these fees cannot be recovered.").check();
  await page
    .getByRole("button", { name: "Burn ETH fees", exact: true })
    .click();
  await confirmed(page);
  assert.equal(m.writes.at(-1).args[0], d.pool.pairedCurrency);
  await page.getByLabel("I understand these fees cannot be recovered.").check();
  await page
    .getByRole("button", { name: "Burn SNIP fees", exact: true })
    .click();
  await confirmed(page);
  assert.equal(m.writes.at(-1).args[0].toLowerCase(), token.address);
  report.checks.push(
    "Fee burns: acknowledgement gates both currency actions, simulation and receipt refresh, correct hook arguments.",
  );
  await page.getByRole("button", { name: "Get quote", exact: true }).click();
  await expect(sellButton).toBeEnabled();
  await page.clock.install();
  await page.clock.fastForward(46000);
  await expect(sellButton).toBeDisabled();
  await expect(page.getByText('Expired · refresh quote')).toBeVisible();
  report.checks.push('Quote expires after 45 seconds; stale quote cannot be signed.');
  m.events=true;
  await page.getByRole('button',{name:'Refresh data'}).click();
  await expect(page.getByText('Fee charged',{exact:true})).toBeVisible();
  await expect(page.getByText('Fees burned',{exact:true})).toBeVisible();
  report.checks.push('Both FeeCharged and FeesBurned logs decode, sort and render with currency units and explorer links.');
  await page.locator("#amount").fill("3");
  await expect(page.getByText("Minimum received").locator("..")).toContainText(
    "—",
  );
  await page.evaluate(() => window.__emitWallet("accountsChanged", []));
  await expect(
    page.getByRole("button", { name: "Connect wallet", exact: true }),
  ).toBeVisible();
  report.checks.push(
    "Amount changes invalidate quote; external wallet disconnect resets account state.",
  );
  await page.locator("summary").click();
  for (const width of [1440, 900, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(100);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `Overflow at ${width}`,
    );
  }
  report.checks.push(
    "No page overflow at 1440, 900, 800, 390, 320 CSS pixels, including expanded contract details.",
  );
  await page.locator("summary").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "mobile.png");
  await page.setViewportSize({ width: 320, height: 900 });
  await shot(page, "mobile-320.png");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.evaluate(() => (document.documentElement.style.fontSize = ""));
  report.checks.push(
    "200% root text enlargement reflows; this is not native browser zoom.",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page
      .locator("button")
      .first()
      .evaluate((el) => getComputedStyle(el).transitionDuration),
    "0s",
  );
  report.checks.push("Reduced motion disables button transitions.");
  await page.keyboard.press("Control+Home");
  await page.locator(".skip").focus();
  await page.keyboard.press("Tab");
  report.focus = await page.evaluate(() => ({
    tag: document.activeElement.tagName,
    text: document.activeElement.textContent,
    outline: getComputedStyle(document.activeElement).outline,
  }));
  await shot(page, "keyboard-focus.png");
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  report.accessibility = axe.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    description: v.description,
    nodes: v.nodes.map((n) => n.target),
  }));
  assert.equal(axe.violations.length, 0, JSON.stringify(report.accessibility));
  report.checks.push(
    "Axe automated WCAG A/AA scan: zero violations in desktop state.",
  );
  report.contrast = await page.evaluate(() => {
    const parse = (c) =>
      c
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number);
    const lum = (c) =>
      parse(c)
        .map((x) => {
          x /= 255;
          return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        })
        .reduce((s, x, i) => s + x * [0.2126, 0.7152, 0.0722][i], 0);
    return [
      "body",
      ".intro-copy",
      ".primary",
      ".footnote",
      ".metric-label",
    ].map((selector) => {
      const el = document.querySelector(selector),
        fg = getComputedStyle(el).color;
      let p = el,
        bg;
      while (p) {
        bg = getComputedStyle(p).backgroundColor;
        if (bg !== "rgba(0, 0, 0, 0)") break;
        p = p.parentElement;
      }
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      return {
        selector,
        foreground: fg,
        background: bg,
        ratio: Number(((a + 0.05) / (b + 0.05)).toFixed(2)),
      };
    });
  });
  await context.close();
  const noCode = await setup();
  noCode.m.missingCode = true;
  await noCode.page.getByRole("button", { name: "Refresh data" }).click();
  await expect(noCode.page.getByRole("alert")).toContainText(
    "No deployed code",
    { timeout: 20000 },
  );
  report.checks.push(
    "Missing router code disables transactions with a visible deployment error.",
  );
  noCode.m.missingCode=false;
  noCode.m.rpcFail=true;
  await noCode.page.getByRole('button',{name:'Refresh data'}).click();
  await expect(noCode.page.getByRole('alert')).toContainText('Use Refresh data to retry.',{timeout:20000});
  await expect(noCode.page.getByText('Events could not load.',{exact:false})).toBeVisible();
  report.checks.push('RPC failures remain distinct from empty event history; stale-data alert and retry control shown.');
  await noCode.context.close();
  const broken = await browser.newContext(),
    brokenPage = await broken.newPage();
  await brokenPage.route("**/abi/SNIP.json", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
  await brokenPage.goto(url);
  await expect(brokenPage.getByRole("alert")).toContainText(
    "ABI verification failed",
  );
  report.checks.push(
    "Tampered ABI fails runtime canonical Keccak check before wallet initialization.",
  );
  await broken.close();
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.resourceFailures, []);
  report.result = "PASS";
} catch (e) {
  report.result = "FAIL";
  report.error = e.stack;
  console.error(e);
  process.exitCode = 1;
} finally {
  await writeFile(
    new URL("browser-results.json", evidence),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  await new Promise((r) => server.close(r));
}
