import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect, useWalletClient } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, type Address, type Hex } from "viem";
import type { Runtime } from "./config";
import { makePool, readEvents, readState, verifyContracts } from "./chain";
import {
  amountFromText,
  errorMessage,
  inputFee,
  minimumOut,
  permit2Abi,
  quoterAbi,
  rateAt,
  routerAbi,
  slippageFromText,
  swapArguments,
  switchOrAdd,
} from "./protocol";

type Quote = {
  output: bigint;
  minimum: bigint;
  amount: bigint;
  buy: boolean;
  slip: string;
  account: Address;
  block: bigint;
  at: number;
};
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const quantity = (value: bigint, decimals = 18, digits = 7) => {
  const exact = formatUnits(value, decimals);
  const number = Number(exact);
  if (value > 0n && number < 10 ** -digits)
    return `<${(10 ** -digits).toFixed(digits)}`;
  return number.toLocaleString("en-US", { maximumFractionDigits: digits });
};
const percent = (rate: bigint) => `${Number(rate) / 100}%`;

function Curve({ start, block }: { start?: bigint; block?: bigint }) {
  const elapsed =
    start !== undefined && block !== undefined
      ? Number(block - start)
      : undefined;
  const mark =
    elapsed === undefined ? undefined : Math.min(1000, Math.max(0, elapsed));
  const x = (value: number) => 50 + (value / 1000) * 580;
  const y = (value: number) => 205 - (value / 5000) * 165;
  const points = Array.from(
    { length: 101 },
    (_, i) => `${x(i * 10)},${y(Number(rateAt(BigInt(i * 10))))}`,
  ).join(" ");
  return (
    <figure className="curve">
      <svg
        viewBox="0 0 670 255"
        role="img"
        aria-labelledby="curve-title curve-desc"
      >
        <title id="curve-title">Hook fee decay over 1,000 blocks</title>
        <desc id="curve-desc">
          The hook fee starts at 50 percent and falls to 0.3 percent after 1,000
          blocks.{" "}
          {elapsed === undefined
            ? "Waiting for the current block."
            : `Current elapsed block: ${elapsed}. ${elapsed >= 1000 ? "The fee is at its floor; the marker is at the end of the curve." : ""}`}
        </desc>
        {[0, 2500, 5000].map((rate) => (
          <g key={rate}>
            <line
              x1="50"
              x2="630"
              y1={y(rate)}
              y2={y(rate)}
              className="gridline"
            />
            <text x="0" y={y(rate) + 5}>
              {rate / 100}%
            </text>
          </g>
        ))}
        <polygon points={`50,205 ${points} 630,205`} className="curve-area" />
        <polyline points={points} className="curve-line" />
        {[0, 250, 500, 750, 1000].map((b) => (
          <text key={b} x={x(b)} y="238" textAnchor="middle">
            {b.toLocaleString()}
          </text>
        ))}
        {mark !== undefined && (
          <g>
            <line
              x1={x(mark)}
              x2={x(mark)}
              y1="25"
              y2="209"
              className="marker"
            />
            <circle
              cx={x(mark)}
              cy={y(Number(rateAt(BigInt(mark))))}
              r="6"
              className="marker-dot"
            />
            <text
              x={mark > 650 ? x(mark) - 12 : x(mark) + 12}
              y="22"
              textAnchor={mark > 650 ? "end" : "start"}
              className="marker-label"
            >
              Current block {elapsed! >= 1000 ? "→" : ""}
            </text>
          </g>
        )}
      </svg>
      <figcaption>
        <span>Blocks since pool initialization</span>
        <span>Floor at block +1,000</span>
      </figcaption>
    </figure>
  );
}

export function App({ runtime }: { runtime: Runtime }) {
  const { deployment: d, hook, token, publicClient: client } = runtime;
  const account = useAccount();
  const { connectAsync, connectors, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: wallet } = useWalletClient();
  const [buy, setBuy] = useState(true);
  const [amountText, setAmountText] = useState("");
  const [slip, setSlip] = useState("0.5");
  const [quote, setQuote] = useState<Quote>();
  const [pending, setPending] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [hash, setHash] = useState<Hex>();
  const [burnConfirmed, setBurnConfirmed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const active = useRef(false);
  const revision = useRef(0);
  const verification = useQuery({
    queryKey: ["verification", d.sourceCommit],
    queryFn: () => verifyContracts(runtime),
    staleTime: 60000,
    refetchInterval: 60000,
    retry: 1,
  });
  const state = useQuery({
    queryKey: ["pool", account.address],
    queryFn: () => readState(runtime, account.address),
    refetchInterval: 12000,
    retry: 1,
  });
  const events = useQuery({
    queryKey: ["events"],
    queryFn: () => readEvents(runtime),
    refetchInterval: 30000,
    retry: 1,
  });
  const s = state.data;
  const connected = account.isConnected;
  const wrongChain = connected && account.chainId !== d.chainId;
  const fresh = !!s && now - s.fetchedAt < 45000 && !state.isError;
  const ready =
    !!verification.data &&
    !verification.isError &&
    fresh &&
    !!s?.initialized &&
    s.sqrtPriceX96 > 0n;
  const canSign =
    ready &&
    connected &&
    !wrongChain &&
    !!wallet &&
    s?.account === account.address;
  const decimals = buy
    ? d.network.nativeCurrency.decimals
    : (s?.decimals ?? 18);
  const inputSymbol = buy ? "ETH" : (s?.symbol ?? "SNIP");
  const outputSymbol = buy ? (s?.symbol ?? "SNIP") : "ETH";
  let amount = 0n;
  let amountError = "";
  let slipError = "";
  try {
    if (amountText) amount = amountFromText(amountText, decimals);
  } catch (e) {
    amountError = errorMessage(e);
  }
  try {
    slippageFromText(slip);
  } catch (e) {
    slipError = errorMessage(e);
  }
  const balance = s ? (buy ? s.ethBalance : s.tokenBalance) : 0n;
  const insufficient = connected && !!s && amount > balance;
  const quoteValid =
    !!quote &&
    quote.buy === buy &&
    quote.amount === amount &&
    quote.slip === slip &&
    quote.account === account.address &&
    now - quote.at < 45000 &&
    fresh &&
    !!s &&
    s.blockNumber <= quote.block + 3n;
  const needApproval = !buy && !!s && s.allowance < amount;
  const needPermit =
    !buy &&
    !!s &&
    (s.permit[0] < amount || s.permit[1] <= Math.floor(now / 1000) + 90);
  const txLink = (tx: string) => `${d.network.explorer}/tx/${tx}`;
  const addressLink = (address: string) =>
    `${d.network.explorer}/address/${address}`;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    revision.current++;
    setQuote(undefined);
    setError("");
    setStatus("");
    setHash(undefined);
  }, [amountText, buy, slip, account.address, account.chainId]);

  async function run(label: string, fn: () => Promise<void>) {
    if (active.current) return;
    active.current = true;
    setPending(label);
    setError("");
    setStatus("");
    setHash(undefined);
    try {
      await fn();
    } catch (e) {
      setError(
        `${errorMessage(e)}${label.includes("quote") || label.includes("swap") ? " Refresh the quote or try a smaller amount; available liquidity may limit this direction." : ""}`,
      );
    } finally {
      setPending("");
      active.current = false;
    }
  }
  async function assertWallet() {
    if (!canSign || !wallet || !account.address)
      throw new Error(
        "Connect your wallet to the correct network and refresh the pool before continuing.",
      );
    const [chainId, addresses] = await Promise.all([
      wallet.getChainId(),
      wallet.getAddresses(),
    ]);
    if (
      chainId !== d.chainId ||
      addresses[0]?.toLowerCase() !== account.address.toLowerCase()
    )
      throw new Error("Your wallet changed. Reconnect and review the amount.");
    await verifyContracts(runtime);
    return { signer: wallet, address: account.address };
  }
  async function receipt(tx: Hex) {
    setHash(tx);
    setStatus("Transaction submitted. Waiting for confirmation…");
    const receipt = await client.waitForTransactionReceipt({ hash: tx });
    if (receipt.status !== "success")
      throw new Error(
        "Transaction reverted onchain. Refresh the pool and review your amount before retrying.",
      );
    setStatus("Transaction confirmed. Pool data has been refreshed.");
    setQuote(undefined);
    await Promise.all([state.refetch(), events.refetch()]);
  }
  async function quoteSwap() {
    if (
      !ready ||
      !account.address ||
      wrongChain ||
      !amount ||
      amountError ||
      slipError ||
      insufficient
    )
      throw new Error(
        "Connect on Sepolia and enter an amount within your balance, then retry.",
      );
    const currentRevision = revision.current;
    const block = await client.getBlockNumber({ cacheTime: 0 });
    const result = await client.simulateContract({
      address: d.network.uniswapV4.quoter,
      abi: quoterAbi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          poolKey: makePool(runtime),
          zeroForOne: buy,
          exactAmount: amount,
          hookData: "0x",
        },
      ],
      account: account.address,
      blockNumber: block,
    });
    const output = result.result[0];
    const minimum = minimumOut(output, slippageFromText(slip));
    if (minimum === 0n)
      throw new Error(
        "This amount rounds to zero output. Enter a larger amount.",
      );
    if (revision.current !== currentRevision) return;
    setQuote({
      output,
      minimum,
      amount,
      buy,
      slip,
      account: account.address,
      block,
      at: Date.now(),
    });
    setStatus("Quote ready. Review the minimum received before swapping.");
  }
  async function approve(step: "token" | "permit") {
    const { signer, address } = await assertWallet();
    if (buy || !amount || amountError || slipError || insufficient)
      throw new Error("Review the sell amount before approving.");
    const tx =
      step === "token"
        ? {
            address: token.address,
            abi: token.abi,
            functionName: "approve",
            args: [d.network.uniswapV4.permit2, amount],
          }
        : {
            address: d.network.uniswapV4.permit2,
            abi: permit2Abi,
            functionName: "approve",
            args: [
              token.address,
              d.network.uniswapV4.universalRouter,
              amount,
              Math.floor(Date.now() / 1000) + 1800,
            ],
          };
    const simulation = await client.simulateContract({
      ...tx,
      account: address,
    });
    await assertWallet();
    setStatus("Confirm the exact-amount approval in your wallet.");
    await receipt(await signer.writeContract(simulation.request));
  }
  async function swap() {
    const { signer, address } = await assertWallet();
    if (!quoteValid || !quote || needApproval || needPermit || insufficient)
      throw new Error(
        "Refresh your quote and complete any approval steps before swapping.",
      );
    const currentBlock = await client.getBlockNumber({ cacheTime: 0 });
    if (currentBlock > quote.block + 3n || Date.now() - quote.at >= 45000)
      throw new Error("Quote expired. Get a new quote before swapping.");
    const transaction = swapArguments(
      makePool(runtime),
      buy,
      amount,
      quote.minimum,
      BigInt(Math.floor(Date.now() / 1000) + 300),
    );
    const simulation = await client.simulateContract({
      address: d.network.uniswapV4.universalRouter,
      abi: routerAbi,
      functionName: "execute",
      ...transaction,
      account: address,
    });
    await assertWallet();
    if (Date.now() - quote.at >= 45000)
      throw new Error("Quote expired during simulation. Get a new quote.");
    setStatus(
      `Confirm ${quantity(amount, decimals)} ${inputSymbol} for at least ${quantity(quote.minimum, buy ? s!.decimals : 18)} ${outputSymbol} in your wallet.`,
    );
    await receipt(await signer.writeContract(simulation.request));
  }
  async function burn(currency: Address) {
    const { signer, address } = await assertWallet();
    if (!burnConfirmed)
      throw new Error(
        "Confirm that fees will be sent permanently to the dead address.",
      );
    const simulation = await client.simulateContract({
      address: hook.address,
      abi: hook.abi,
      functionName: "burnFees",
      args: [currency],
      account: address,
    });
    await assertWallet();
    setStatus(
      "Confirm fee burning in your wallet. You pay only the network gas fee.",
    );
    await receipt(await signer.writeContract(simulation.request));
    setBurnConfirmed(false);
  }
  async function connect() {
    if (
      !connectors.length ||
      (typeof window !== "undefined" &&
        !("ethereum" in window) &&
        connectors.every((c) => c.id === "injected"))
    )
      throw new Error(
        "No browser wallet found. Open this page in a wallet browser or install a browser wallet, then reload.",
      );
    await connectAsync({
      connector:
        connectors.find((c) => c.type === "injected" && c.id !== "injected") ??
        connectors[0],
    });
    setStatus("Wallet connected.");
  }
  async function switchNetwork() {
    const provider = await account.connector?.getProvider();
    if (!provider) throw new Error("Reconnect your wallet to switch networks.");
    await switchOrAdd(
      provider as Parameters<typeof switchOrAdd>[0],
      d.walletAddChain.chainId,
      d.walletAddChain,
    );
    await state.refetch();
  }
  const price = s?.sqrtPriceX96
    ? (Number(s.sqrtPriceX96) / 2 ** 96) ** 2 * 10 ** (18 - s.decimals)
    : undefined;
  const staleLabel = state.isError
    ? "RPC unavailable · data may be stale"
    : fresh
      ? `Updated at block ${s!.blockNumber.toLocaleString()}`
      : state.isPending
        ? "Reading Sepolia…"
        : "Data is stale · refresh to continue";
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="header wrap">
        <a href="#main" className="brand" aria-label="Snipeproof home">
          <span className="brand-icon" aria-hidden="true">
            S
          </span>
          <span>
            Snipeproof<span className="brand-sub">Launch observatory</span>
          </span>
        </a>
        <div className="header-actions">
          <span className="network-badge">
            <span aria-hidden="true">◉</span> {d.network.name} testnet
          </span>
          {connected ? (
            <>
              <span className="wallet-address" title={account.address}>
                {short(account.address!)}
              </span>
              <button
                className="small"
                onClick={() => disconnect()}
                disabled={!!pending}
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              className="small"
              disabled={connecting || !!pending}
              onClick={() => run("Connecting wallet…", connect)}
            >
              {connecting ? "Connecting…" : "Connect wallet"}
            </button>
          )}
        </div>
      </header>
      <main id="main" className="wrap">
        <section className="intro">
          <div>
            <p className="eyebrow">SNIP / ETH · Uniswap v4</p>
            <h1>
              A fairer start.
              <br />
              <span>A fee that fades.</span>
            </h1>
            <p className="intro-copy">
              Watch the launch fee fall from 50% to 0.3% over 1,000 blocks.
              Every hook fee is destined for the dead address.
            </p>
          </div>
          <div className="intro-note">
            <span className="tiny-label">Built into the contract</span>
            <p>
              No owner.
              <br />
              No fee switches.
              <br />
              One visible curve.
            </p>
            <span className="mono tiny-label">01 / Launch mechanics</span>
          </div>
        </section>
        <div className="live-strip">
          <span>
            <span
              className={`status-dot ${fresh ? "live" : ""}`}
              aria-hidden="true"
            />
            {staleLabel}
          </span>
          <button
            className="text-button"
            disabled={state.isFetching || !!pending}
            onClick={() => {
              void state.refetch();
              void verification.refetch();
              void events.refetch();
            }}
          >
            {state.isFetching ? "Refreshing…" : "Refresh data ↻"}
          </button>
        </div>
        {(verification.isError || state.isError) && (
          <p className="notice error" role="alert">
            {errorMessage(verification.error ?? state.error)} Use Refresh data
            to retry. Actions stay disabled until checks pass.
          </p>
        )}
        {wrongChain && (
          <div className="notice">
            <p>
              Your wallet is on another network. Switch to {d.network.name} to
              continue.
            </p>
            <button
              disabled={!!pending}
              onClick={() => run("Switching network…", switchNetwork)}
            >
              Switch to {d.network.name}
            </button>
          </div>
        )}
        {s && !s.initialized && (
          <p className="notice">
            This pool is not initialized. Swaps are unavailable.
          </p>
        )}
        <div className="workspace">
          <section className="observatory" aria-labelledby="fee-heading">
            <div className="section-heading">
              <h2 id="fee-heading">The launch fee</h2>
              <span className="tag">
                {s
                  ? s.left === 0n
                    ? "Floor reached"
                    : "Decaying"
                  : "Awaiting data"}
              </span>
            </div>
            <div className="metrics">
              <div>
                <p className="metric-label">Current hook fee</p>
                <div className="hero-number">{s ? percent(s.rate) : "—"}</div>
                <p className="muted">Charged on the swap input</p>
              </div>
              <div className="secondary-metric">
                <p className="metric-label">Blocks until 0.3%</p>
                <div className="metric-number">
                  {s ? s.left.toLocaleString() : "—"}
                </div>
                <p className="muted">
                  {s?.left === 0n
                    ? "The minimum fee is active"
                    : "Based on blocks, not a timer"}
                </p>
              </div>
            </div>
            <Curve
              start={s?.initialized ? s.start : undefined}
              block={s?.initialized ? s.blockNumber : undefined}
            />
            <div className="curve-key">
              <span>
                <i aria-hidden="true" /> Hook fee
              </span>
              <span>50% → 0.3%</span>
            </div>
            <div className="price-row">
              <div>
                <span className="tiny-label">Pool spot price</span>
                <p className="price">
                  {price
                    ? `${price.toLocaleString("en-US", { maximumFractionDigits: 2 })} SNIP`
                    : "—"}{" "}
                  <span>/ ETH</span>
                </p>
              </div>
              <div className="price-aside">
                StateView read
                <br />
                {s
                  ? `${(s.lpFee / 10000).toFixed(2)}% pool LP fee`
                  : "LP fee loading"}
              </div>
            </div>
            <p className="footnote">
              The hook fee and pool LP fee are separate. The spot price excludes
              fees and price impact; use a quote for an execution estimate.
            </p>
          </section>
          <section className="swap-card" aria-labelledby="swap-heading">
            <div className="section-heading">
              <h2 id="swap-heading">Swap SNIP</h2>
              <span className="tiny-label">Test tokens only</span>
            </div>
            <div className="segmented" aria-label="Swap direction">
              <button
                aria-pressed={buy}
                disabled={!!pending}
                onClick={() => {
                  setBuy(true);
                  setAmountText("");
                }}
              >
                Buy SNIP
              </button>
              <button
                aria-pressed={!buy}
                disabled={!!pending}
                onClick={() => {
                  setBuy(false);
                  setAmountText("");
                }}
              >
                Sell SNIP
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run("Getting quote…", quoteSwap);
              }}
            >
              <div className="amount-field">
                <label htmlFor="amount">You pay</label>
                <div className="amount-row">
                  <input
                    id="amount"
                    name="amount"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.00"
                    value={amountText}
                    onChange={(e) => setAmountText(e.target.value)}
                    disabled={!!pending}
                    aria-invalid={!!amountError || insufficient}
                    aria-describedby="amount-help"
                  />
                  <span className="currency">
                    <span aria-hidden="true">{buy ? "Ξ" : "S"}</span>
                    {inputSymbol}
                  </span>
                </div>
                <p className="balance">
                  Balance:{" "}
                  {connected && s
                    ? `${quantity(balance, decimals)} ${inputSymbol}`
                    : "Connect wallet"}
                </p>
              </div>
              <p
                className={`field-help ${amountError || insufficient ? "error-text" : ""}`}
                id="amount-help"
              >
                {amountError ||
                  (insufficient
                    ? `Amount exceeds your ${inputSymbol} balance.`
                    : buy
                      ? "Keep some ETH available for network gas."
                      : "Sell from your SNIP balance. Approvals are separate steps.")}
              </p>
              <div className="receive-field">
                <span className="tiny-label">Estimated receive</span>
                <p>
                  {quoteValid
                    ? quantity(quote!.output, buy ? s!.decimals : 18)
                    : "—"}{" "}
                  <span>{outputSymbol}</span>
                </p>
              </div>
              <div className="slippage-row">
                <label htmlFor="slippage">Slippage tolerance</label>
                <div>
                  <input
                    id="slippage"
                    name="slippage"
                    inputMode="decimal"
                    value={slip}
                    disabled={!!pending}
                    onChange={(e) => setSlip(e.target.value)}
                    aria-invalid={!!slipError}
                    aria-describedby="slip-help"
                  />
                  <span>%</span>
                </div>
              </div>
              <p id="slip-help" className="field-help error-text">
                {slipError}
              </p>
              <dl className="swap-details">
                <div>
                  <dt>Hook fee {s ? `(${percent(s.rate)})` : ""}</dt>
                  <dd
                    title={
                      s
                        ? formatUnits(inputFee(amount, s.rate), decimals)
                        : undefined
                    }
                  >
                    {s && amount
                      ? `${quantity(inputFee(amount, s.rate), decimals)} ${inputSymbol}`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Minimum received</dt>
                  <dd>
                    {quoteValid
                      ? `${quantity(quote!.minimum, buy ? s!.decimals : 18)} ${outputSymbol}`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Quote status</dt>
                  <dd>
                    {quoteValid
                      ? `Valid · block ${quote!.block}`
                      : quote
                        ? "Expired · refresh quote"
                        : "Not requested"}
                  </dd>
                </div>
              </dl>
              {!connected ? (
                <button
                  type="button"
                  className="primary"
                  disabled={!!pending}
                  onClick={() => run("Connecting wallet…", connect)}
                >
                  Connect wallet to swap <span aria-hidden="true">↗</span>
                </button>
              ) : (
                <button
                  type="submit"
                  className={!quoteValid ? "primary" : "secondary full"}
                  disabled={
                    !canSign ||
                    !amount ||
                    !!amountError ||
                    !!slipError ||
                    insufficient ||
                    !!pending
                  }
                >
                  {pending === "Getting quote…"
                    ? pending
                    : quote
                      ? "Refresh quote"
                      : "Get quote"}
                </button>
              )}
              {connected && !buy && amount > 0n && (
                <div className="approval-steps">
                  <p className="tiny-label">
                    Sell approvals · exact amount only
                  </p>
                  <button
                    type="button"
                    disabled={
                      !canSign ||
                      !needApproval ||
                      insufficient ||
                      !!amountError ||
                      !!pending
                    }
                    onClick={() =>
                      run("Approving SNIP…", () => approve("token"))
                    }
                  >
                    {needApproval
                      ? "1. Approve SNIP for Permit2"
                      : "1. SNIP approval ready ✓"}
                  </button>
                  <button
                    type="button"
                    disabled={
                      !canSign ||
                      needApproval ||
                      !needPermit ||
                      insufficient ||
                      !!amountError ||
                      !!pending
                    }
                    onClick={() =>
                      run("Approving router…", () => approve("permit"))
                    }
                  >
                    {needPermit
                      ? "2. Approve router for 30 minutes"
                      : "2. Router approval ready ✓"}
                  </button>
                </div>
              )}
              {connected && (
                <button
                  type="button"
                  className={quoteValid ? "primary" : "secondary full"}
                  disabled={
                    !canSign ||
                    !quoteValid ||
                    needApproval ||
                    needPermit ||
                    insufficient ||
                    !!pending
                  }
                  onClick={() => run("Simulating swap…", swap)}
                >
                  {pending === "Simulating swap…"
                    ? pending
                    : `${buy ? "Buy" : "Sell"} SNIP`}
                </button>
              )}
              <p className="swap-note">
                Quote includes the hook and pool fees. The final fee follows the
                block your swap lands in. Network gas is extra.
              </p>
            </form>
          </section>
        </div>
        <div className="transaction-feedback">
          <p role="status" aria-live="polite">
            {pending && <strong>{pending} </strong>}
            {status}
          </p>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          {hash && (
            <a href={txLink(hash)} target="_blank" rel="noreferrer">
              View transaction {short(hash)} ↗
            </a>
          )}
        </div>
        <section className="activity" aria-labelledby="activity-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Onchain activity</p>
              <h2 id="activity-heading">Fees, in the open.</h2>
            </div>
            <span className="tiny-label">
              {events.data
                ? `Blocks ${events.data.fromBlock.toLocaleString()}–${events.data.toBlock.toLocaleString()}`
                : "Recent 2,000 blocks"}
            </span>
          </div>
          <div className="activity-grid">
            <div className="events">
              <div className="section-heading">
                <h3>Recent hook events</h3>
                <span className="tag">Latest 12</span>
              </div>
              {events.isError ? (
                <p className="empty">
                  Events could not load. Refresh data to retry; this is not an
                  empty history.
                </p>
              ) : events.isPending ? (
                <p className="empty">Reading hook events…</p>
              ) : !events.data?.events.length ? (
                <p className="empty">
                  No hook events in this block window. A confirmed swap or fee
                  burn will appear here.
                </p>
              ) : (
                <ul className="event-list">
                  {events.data.events.map((event) => (
                    <li key={`${event.txHash}-${event.index}`}>
                      <div>
                        <span className="event-kind">{event.kind}</span>
                        <a
                          href={txLink(event.txHash)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Block {event.block.toLocaleString()} ↗
                        </a>
                      </div>
                      <span>
                        {quantity(
                          event.fee,
                          event.currency.toLowerCase() ===
                            token.address.toLowerCase()
                            ? (s?.decimals ?? 18)
                            : 18,
                        )}{" "}
                        {event.currency.toLowerCase() ===
                        token.address.toLowerCase()
                          ? "SNIP"
                          : "ETH"}
                      </span>
                      <span>
                        {event.rate === undefined
                          ? "To dEaD"
                          : percent(event.rate)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="footnote">
                Fee charges cover this pool; fee burns cover the hook’s currency
                claims across pools. Older activity is on the{" "}
                <a
                  href={addressLink(hook.address)}
                  target="_blank"
                  rel="noreferrer"
                >
                  hook explorer ↗
                </a>
                .
              </p>
            </div>
            <div className="burn-panel">
              <h3>Send accrued fees to dEaD</h3>
              <p className="muted">
                Anyone can release the hook’s fee claims. They go permanently to
                the dead address; you pay network gas.
              </p>
              <dl className="claim-values">
                <div>
                  <dt>ETH claims</dt>
                  <dd>{s ? quantity(s.ethClaims) : "—"}</dd>
                </div>
                <div>
                  <dt>SNIP claims</dt>
                  <dd>{s ? quantity(s.tokenClaims, s.decimals) : "—"}</dd>
                </div>
              </dl>
              <p className="footnote">
                Claims include all pools using this hook, grouped by currency.
              </p>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={burnConfirmed}
                  onChange={(e) => setBurnConfirmed(e.target.checked)}
                  disabled={!!pending}
                />
                I understand these fees cannot be recovered.
              </label>
              <div className="burn-buttons">
                <button
                  disabled={
                    !canSign || !burnConfirmed || !s?.ethClaims || !!pending
                  }
                  onClick={() =>
                    run("Burning ETH fees…", () => burn(d.pool.pairedCurrency))
                  }
                >
                  Burn ETH fees
                </button>
                <button
                  disabled={
                    !canSign || !burnConfirmed || !s?.tokenClaims || !!pending
                  }
                  onClick={() =>
                    run("Burning SNIP fees…", () => burn(token.address))
                  }
                >
                  Burn SNIP fees
                </button>
              </div>
              {!connected && (
                <p className="footnote">Connect your wallet to burn fees.</p>
              )}
              {s && (
                <a
                  className="footnote"
                  href={addressLink(s.dead)}
                  target="_blank"
                  rel="noreferrer"
                >
                  View fee destination ↗
                </a>
              )}
            </div>
          </div>
        </section>
        <details className="deployment">
          <summary>
            Deployment & pool details <span>Verify the contracts ↗</span>
          </summary>
          <div className="deployment-grid">
            {d.contracts.map((c) => (
              <div key={c.name}>
                <h3>{c.name}</h3>
                <a
                  className="mono"
                  href={addressLink(c.address)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {c.address} ↗
                </a>
                <p className="footnote">
                  ABI hash <span className="mono">{c.abiHash}</span>
                </p>
              </div>
            ))}
            <div>
              <h3>Uniswap routing</h3>
              <p>Universal Router · exact input</p>
              <a
                className="mono"
                href={addressLink(d.network.uniswapV4.universalRouter)}
                target="_blank"
                rel="noreferrer"
              >
                {d.network.uniswapV4.universalRouter} ↗
              </a>
              <p className="footnote">
                {verification.data && !verification.isError
                  ? "Configured contracts have code; RPC chain and hook manager checked."
                  : "Waiting for deployment checks."}
              </p>
            </div>
            <div>
              <h3>Attested source</h3>
              <p className="mono">{d.sourceCommit}</p>
              <p className="footnote">
                Launch {d.launchId}
                <br />
                Chain {d.chainId} · Pool fee {d.pool.fee} pips · Tick spacing{" "}
                {d.pool.tickSpacing}
                <br />
                Pool initialized {s ? `at block ${s.start}` : "—"}
              </p>
              <a href="./imd-deployment.json">Read deployment manifest ↗</a>
            </div>
          </div>
        </details>
        <footer>
          <span className="brand-name">Snipeproof</span>
          <p>
            Sepolia experiment. Test tokens have no intended monetary value.
          </p>
          <a href={d.network.faucets[0]} target="_blank" rel="noreferrer">
            Get test ETH ↗
          </a>
        </footer>
      </main>
    </>
  );
}
