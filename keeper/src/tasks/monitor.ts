// Monitoring. Sends nothing. Prints the figures docs/ECONOMICS-REVIEW.md (end of section 1.6) says a
// deployer must watch, plus the state of the games bankroll, randomness and ownership.
import { type Address, formatEther, getAddress, isAddressEqual, zeroAddress } from "viem";
import type { Deployment } from "../chain.ts";
import { type Ctx, type Head, readerAt } from "../context.ts";
import { duration, eth } from "../logger.ts";
import { eventsOf, getLogsChunked, scanFrom } from "../logs.ts";
import type { Finding, TaskReport } from "../types.ts";
import { fetchOpenBets } from "./games.ts";
import { LOT, fetchLotteryRounds } from "./lottery.ts";
import { TR, fetchTicketRaffles } from "./ticketRaffle.ts";
import { VR, fetchVaultRaffles } from "./vaultRaffle.ts";

const BPS = 10_000n;
const warn = (code: string, message: string, data?: Record<string, unknown>): Finding => ({ task: "monitor", level: "warn", code, message, data });
const error = (code: string, message: string, data?: Record<string, unknown>): Finding => ({ task: "monitor", level: "error", code, message, data });
const info = (code: string, message: string, data?: Record<string, unknown>): Finding => ({ task: "monitor", level: "info", code, message, data });

/** a / b as a number with four decimals; null when b is zero. */
export function ratio(a: bigint, b: bigint): number | null {
  if (b === 0n) return null;
  return Number((a * 10_000n) / b) / 10_000;
}

// ---------------------------------------------------------------- collections

export interface CollectionInput {
  collection: Address;
  now: bigint;
  budget: bigint;
  curvePrice: bigint;
  currentBid: bigint;
  basePrice: bigint;
  maxPrice: bigint;
  growthBpsPerDay: bigint;
  stepDownBps: bigint;
  active: boolean;
  fillable: boolean;
  fillCooldown: bigint;
  lastFillAt: bigint;
  /** `minBidOf`: the engine refuses to buy below it. Null on a deployment without it. */
  minBid: bigint | null;
  /** Floor from the sales oracle and the push oracle, where they have one. */
  salesFloor: bigint | null;
  pushFloor: bigint | null;
}

export interface CollectionFigures {
  collection: Address;
  active: boolean;
  budgetWei: bigint;
  curvePriceWei: bigint;
  currentBidWei: bigint;
  /** The budget, not the curve, sets the bid: the engine cannot pay what the curve asks. */
  budgetLimited: boolean;
  /** Budget in units of the bid the engine would pay if the budget did not limit it. Above 3: curve too slow. */
  budgetInBids: number | null;
  secondsSinceLastFill: bigint | null;
  fillable: boolean;
  basePriceWei: bigint;
  maxPriceWei: bigint;
  maxPriceOverBase: number | null;
  curveAtMaxPrice: boolean;
  growthBpsPerDay: bigint;
  stepDownBps: bigint;
  fillCooldownSeconds: bigint;
  minBidWei: bigint | null;
  /** The bid the budget can pay is under `minBidOf`: nobody can sell until the budget grows. */
  bidBelowMinimum: boolean;
  salesFloorWei: bigint | null;
  pushFloorWei: bigint | null;
  maxPriceOverFloor: number | null;
  bidOverFloor: number | null;
}

export function collectionFigures(c: CollectionInput): CollectionFigures {
  const floor = c.pushFloor ?? c.salesFloor;
  return {
    collection: c.collection,
    active: c.active,
    budgetWei: c.budget,
    curvePriceWei: c.curvePrice,
    currentBidWei: c.currentBid,
    budgetLimited: c.active && c.budget < c.curvePrice,
    budgetInBids: ratio(c.budget, c.curvePrice),
    secondsSinceLastFill: c.lastFillAt === 0n ? null : c.now - c.lastFillAt,
    fillable: c.fillable,
    basePriceWei: c.basePrice,
    maxPriceWei: c.maxPrice,
    maxPriceOverBase: ratio(c.maxPrice, c.basePrice),
    curveAtMaxPrice: c.active && c.maxPrice !== 0n && c.curvePrice >= c.maxPrice,
    growthBpsPerDay: c.growthBpsPerDay,
    stepDownBps: c.stepDownBps,
    fillCooldownSeconds: c.fillCooldown,
    minBidWei: c.minBid,
    bidBelowMinimum: c.active && c.minBid !== null && c.currentBid < c.minBid,
    salesFloorWei: c.salesFloor,
    pushFloorWei: c.pushFloor,
    maxPriceOverFloor: floor === null ? null : ratio(c.maxPrice, floor),
    bidOverFloor: floor === null ? null : ratio(c.currentBid, floor),
  };
}

export function assessCollection(f: CollectionFigures, budgetInBidsWarn: number): Finding[] {
  const out: Finding[] = [];
  const data = { collection: f.collection };
  if (!f.active) {
    out.push(info("bid_inactive", `${f.collection}: the floor bid is not active`, data));
    return out;
  }
  if (f.budgetInBids !== null && f.budgetInBids > budgetInBidsWarn) {
    out.push(warn("budget_idle", `${f.collection}: the budget is ${f.budgetInBids.toFixed(2)} bids deep; above ${budgetInBidsWarn} the curve is too slow for the fee inflow`, data));
  }
  if (f.curveAtMaxPrice) {
    out.push(warn("curve_at_max_price", `${f.collection}: the bid curve has reached maxPrice (${eth(f.maxPriceWei)}); maxPrice is now the only limit on what the engine pays`, data));
  }
  if (f.bidOverFloor !== null && f.bidOverFloor > 1.02) {
    out.push(warn("bid_above_floor", `${f.collection}: the bid is ${f.bidOverFloor.toFixed(3)} times the oracle floor`, data));
  }
  if (f.bidBelowMinimum) {
    out.push(info("bid_below_minimum", `${f.collection}: the bid the budget can pay (${eth(f.currentBidWei)}) is below minBidOf (${eth(f.minBidWei ?? 0n)}); nobody can sell into it until the budget grows`, data));
  } else if (f.budgetLimited) {
    out.push(info("budget_limited", `${f.collection}: the bid is limited by the budget (${eth(f.budgetWei)} against a curve at ${eth(f.curvePriceWei)})`, data));
  }
  return out;
}

// ---------------------------------------------------------------- games

export interface GamesInput {
  bankroll: bigint;
  reserved: bigint;
  /** Wagers of the open bets, which the contract also holds. Null on a deployment that does not track them. */
  openWagers: bigint | null;
  balance: bigint;
  minBet: bigint;
  maxWagerBps: bigint;
  maxExposureBps: bigint;
  maxTotalExposureBps: bigint;
}

export interface GamesFigures {
  bankrollWei: bigint;
  reservedWei: bigint;
  /** Reserved as a share of all house funds, in bps; new bets stop at `reservedCapBps`. */
  reservedShareBps: bigint;
  reservedCapBps: bigint;
  largestWagerWei: bigint;
  largestExposureWei: bigint;
  minBetWei: bigint;
  openWagersWei: bigint | null;
  balanceWei: bigint;
}

export function gamesFigures(g: GamesInput): GamesFigures {
  const funds = g.bankroll + g.reserved;
  return {
    bankrollWei: g.bankroll,
    reservedWei: g.reserved,
    reservedShareBps: funds === 0n ? 0n : (g.reserved * BPS) / funds,
    reservedCapBps: g.maxTotalExposureBps,
    largestWagerWei: (g.bankroll * g.maxWagerBps) / BPS,
    largestExposureWei: (g.bankroll * g.maxExposureBps) / BPS,
    minBetWei: g.minBet,
    openWagersWei: g.openWagers,
    balanceWei: g.balance,
  };
}

export function assessGames(f: GamesFigures): Finding[] {
  const out: Finding[] = [];
  const accounted = f.bankrollWei + f.reservedWei + (f.openWagersWei ?? 0n);
  if (f.balanceWei < accounted) {
    out.push(error("games_insolvent", `Games holds ${eth(f.balanceWei)} but accounts for ${eth(accounted)} of bankroll, reserve and open wagers`));
  }
  if (f.largestWagerWei < f.minBetWei) {
    out.push(warn("games_no_bets_possible", `the largest allowed wager (${eth(f.largestWagerWei)}) is below minBet (${eth(f.minBetWei)}): no bet can be placed`));
  }
  if (f.reservedCapBps !== 0n && f.reservedShareBps * 10n >= f.reservedCapBps * 9n) {
    out.push(warn("games_reserve_near_cap", `open bets reserve ${Number(f.reservedShareBps) / 100}% of house funds; new bets stop at ${Number(f.reservedCapBps) / 100}%`));
  }
  return out;
}

// ---------------------------------------------------------------- randomness

export interface Waiting {
  kind: "vaultRaffle" | "lottery" | "ticketRaffle" | "bet";
  id: bigint;
  since: bigint;
}

export interface VrfFigures {
  waiting: { kind: Waiting["kind"]; count: number; oldestSeconds: bigint | null }[];
  total: number;
}

export function vrfFigures(waiting: Waiting[], now: bigint): VrfFigures {
  const kinds: Waiting["kind"][] = ["vaultRaffle", "lottery", "ticketRaffle", "bet"];
  return {
    total: waiting.length,
    waiting: kinds.map((kind) => {
      const of = waiting.filter((w) => w.kind === kind);
      const oldest = of.reduce<bigint | null>((min, w) => (min === null || w.since < min ? w.since : min), null);
      return { kind, count: of.length, oldestSeconds: oldest === null ? null : now - oldest };
    }),
  };
}

export function assessVrf(waiting: Waiting[], now: bigint, warnSeconds: bigint): Finding[] {
  return waiting
    .filter((w) => now - w.since >= warnSeconds)
    .map((w) =>
      warn("randomness_late", `${w.kind} ${w.id} has waited ${duration(now - w.since)} for randomness`, {
        kind: w.kind,
        id: w.id,
        waitedSeconds: now - w.since,
      }),
    );
}

export interface ProviderInput {
  consumer: "vault" | "vaultRaffle" | "games" | "ticketRaffle" | "lottery";
  consumerAddress: Address;
  expected: Address;
  actual: Address;
  /** `consumer()` and `coordinator()` of the provider, if it answers like the Chainlink adapter. */
  adapterConsumer: Address | null;
  adapterCoordinator: Address | null;
}

export function assessProviders(providers: ProviderInput[], chainId: number): Finding[] {
  const out: Finding[] = [];
  for (const p of providers) {
    const data = { consumer: p.consumer, expected: p.expected, actual: p.actual };
    if (!isAddressEqual(p.actual, p.expected)) {
      out.push(error("randomness_provider_changed", `${p.consumer}.randomness() is ${p.actual}, expected ${p.expected}`, data));
      continue;
    }
    if (chainId === 31337) continue; // a local chain uses the mock on purpose
    if (p.adapterConsumer === null || p.adapterCoordinator === null) {
      out.push(error("randomness_provider_not_vrf", `${p.consumer}.randomness() ${p.actual} does not answer like the Chainlink VRF adapter; with a mock, whoever calls it picks the number`, data));
    } else if (!isAddressEqual(p.adapterConsumer, p.consumerAddress)) {
      out.push(error("randomness_provider_wrong_consumer", `the VRF adapter of ${p.consumer} serves ${p.adapterConsumer}, not ${p.consumerAddress}`, data));
    }
  }
  return out;
}

// ---------------------------------------------------------------- ownership

export interface OwnerInput {
  contract: string;
  owner: Address | null;
  pendingOwner: Address | null;
  /** The owner seen on the previous run, if the cache has one. */
  previous: Address | null;
}

export function assessOwners(owners: OwnerInput[], expected: Address, keeper: Address | null): Finding[] {
  const out: Finding[] = [];
  for (const o of owners) {
    if (o.owner === null) continue;
    const data = { contract: o.contract, owner: o.owner, expected, pendingOwner: o.pendingOwner, previous: o.previous };
    if (o.previous !== null && !isAddressEqual(o.previous, o.owner)) {
      out.push(error("owner_changed", `${o.contract}.owner() changed from ${o.previous} to ${o.owner}`, data));
    } else if (!isAddressEqual(o.owner, expected)) {
      if (o.pendingOwner !== null && isAddressEqual(o.pendingOwner, expected)) {
        out.push(warn("ownership_handover_pending", `${o.contract} is still owned by ${o.owner}; ${expected} has not accepted ownership yet`, data));
      } else {
        out.push(error("owner_unexpected", `${o.contract}.owner() is ${o.owner}, expected ${expected}`, data));
      }
    }
    if (o.pendingOwner !== null && !isAddressEqual(o.pendingOwner, zeroAddress) && !isAddressEqual(o.pendingOwner, expected)) {
      out.push(warn("ownership_transfer_started", `${o.contract} has a pending owner ${o.pendingOwner}`, data));
    }
    if (keeper !== null && isAddressEqual(o.owner, keeper)) {
      out.push(warn("keeper_is_owner", `the keeper's key owns ${o.contract}; the keeper needs no owner rights and should use a key that has none`, data));
    }
  }
  return out;
}

// ---------------------------------------------------------------- fetching

interface BidStruct {
  basePrice: bigint;
  maxPrice: bigint;
  growthBpsPerDay: number;
  stepDownBps: number;
  active: boolean;
}

/** Collections that have had a bid configured, from the engine's events, plus any named in the config. */
export async function fetchCollections(ctx: Ctx, head: Head): Promise<Address[]> {
  const known = new Set<Address>([...ctx.cache.data.collections.map((a) => getAddress(a)), ...ctx.config.collections]);
  if (ctx.deployment.demoCollection) known.add(ctx.deployment.demoCollection);
  const from = scanFrom(ctx.cache.scannedTo("collections"), ctx.config.startBlock);
  if (from <= head.number) {
    const logs = await getLogsChunked(ctx.client, {
      address: ctx.deployment.buybackEngine,
      events: eventsOf(ctx.abis.buybackEngine, ["BidConfigured"]),
      fromBlock: from,
      toBlock: head.number,
      maxRange: ctx.config.logRange,
    });
    for (const log of logs) known.add(getAddress(log.args.collection as Address));
  }
  ctx.cache.data.collections = [...known];
  ctx.cache.data.scanned.collections = head.number.toString();
  return [...known].sort();
}

async function fetchCollection(ctx: Ctx, head: Head, collection: Address): Promise<CollectionInput> {
  const r = readerAt(ctx, head);
  const floor = async (oracle: Address) => (await r.tryRead<readonly [bigint, bigint]>("floorOracle", "floorPrice", [collection], oracle))?.[0] ?? null;
  const [budget, curvePrice, currentBid, bid, fillable, fillCooldown, lastFillAt, minBid, salesFloor, pushFloor] = await Promise.all([
    r.read<bigint>("treasury", "budgetOf", [collection]),
    r.read<bigint>("buybackEngine", "curvePrice", [collection]),
    r.read<bigint>("buybackEngine", "currentBid", [collection]),
    r.struct<BidStruct>("buybackEngine", "bids", [collection]),
    r.read<boolean>("buybackEngine", "isFillable", [collection]),
    r.read<bigint>("buybackEngine", "fillCooldownOf", [collection]),
    r.read<bigint>("buybackEngine", "lastFillAt", [collection]),
    hasFunction(ctx.abis.buybackEngine, "minBidOf") ? r.read<bigint>("buybackEngine", "minBidOf", [collection]) : null,
    floor(ctx.deployment.salesFloorOracle),
    floor(ctx.deployment.pushFloorOracle),
  ]);
  return {
    collection,
    now: head.timestamp,
    budget,
    curvePrice,
    currentBid,
    basePrice: bid.basePrice,
    maxPrice: bid.maxPrice,
    growthBpsPerDay: BigInt(bid.growthBpsPerDay),
    stepDownBps: BigInt(bid.stepDownBps),
    active: bid.active,
    fillable,
    fillCooldown,
    lastFillAt,
    minBid,
    salesFloor,
    pushFloor,
  };
}

const hasFunction = (abi: readonly { type: string; name?: string }[], name: string) =>
  abi.some((item) => item.type === "function" && item.name === name);

const OWNED = [
  "treasury",
  "marketplace",
  "buybackEngine",
  "vault",
  "predictionMarket",
  "points",
  "vaultRaffle",
  "games",
  "ticketRaffle",
  "lottery",
  "ipLicenseManager",
  "salesFloorOracle",
  "pushFloorOracle",
] as const;

const CONSUMERS = [
  ["vault", "vaultRandomness"],
  ["vaultRaffle", "randomness"],
  ["games", "gamesRandomness"],
  ["ticketRaffle", "ticketRaffleRandomness"],
  ["lottery", "lotteryRandomness"],
] as const;

/** Each randomness consumer to check and the provider it should use. A consumer with no expected
 * provider (the Vault of a deployment made before it had its own unlock draw) is left out. */
export function expectedProviders(
  deployment: Deployment,
  overrides: Partial<Record<ProviderInput["consumer"], Address>>,
): { consumer: ProviderInput["consumer"]; consumerAddress: Address; expected: Address }[] {
  return CONSUMERS.flatMap(([consumer, key]) => {
    const expected = overrides[consumer] ?? deployment[key];
    return expected ? [{ consumer, consumerAddress: deployment[consumer], expected }] : [];
  });
}

export async function runMonitor(ctx: Ctx, head: Head): Promise<TaskReport> {
  const r = readerAt(ctx, head);
  const { config, deployment, log } = ctx;
  const findings: Finding[] = [];
  const now = head.timestamp;

  // collections
  const collections = await fetchCollections(ctx, head);
  const figures = (await r.map(collections, (c) => fetchCollection(ctx, head, c))).map(collectionFigures);
  for (const f of figures) {
    log.event("info", "monitor.collection", { ...f });
    findings.push(...assessCollection(f, config.budgetInBidsWarn));
  }

  // games
  const [bankroll, reserved, minBet, maxWagerBps, maxExposureBps, maxTotalExposureBps, openWagers, balance] = await Promise.all([
    r.read<bigint>("games", "bankroll"),
    r.read<bigint>("games", "reserved"),
    r.read<bigint>("games", "minBet"),
    r.read<bigint>("games", "maxWagerBps"),
    r.read<bigint>("games", "maxExposureBps"),
    r.read<bigint>("games", "MAX_TOTAL_EXPOSURE_BPS"),
    hasFunction(ctx.abis.games, "openWagers") ? r.read<bigint>("games", "openWagers") : null,
    ctx.client.getBalance({ address: deployment.games, blockNumber: head.number }),
  ]);
  const games = gamesFigures({ bankroll, reserved, openWagers, balance, minBet, maxWagerBps, maxExposureBps, maxTotalExposureBps });
  log.event("info", "monitor.games", { ...games });
  findings.push(...assessGames(games));

  // randomness: what is waiting, and who provides it
  const [vaultRaffles, rounds, ticketRaffles, bets] = await Promise.all([
    fetchVaultRaffles(ctx, head),
    fetchLotteryRounds(ctx, head),
    fetchTicketRaffles(ctx, head, false),
    fetchOpenBets(ctx, head),
  ]);
  const waiting: Waiting[] = [
    ...vaultRaffles.filter((x) => x.status === VR.Drawing).map((x) => ({ kind: "vaultRaffle" as const, id: x.id, since: x.requestedAt })),
    ...rounds.filter((x) => x.status === LOT.Drawing).map((x) => ({ kind: "lottery" as const, id: x.id, since: x.requestedAt })),
    ...ticketRaffles.filter((x) => x.status === TR.Drawing).map((x) => ({ kind: "ticketRaffle" as const, id: x.id, since: x.requestedAt })),
    ...bets.map((x) => ({ kind: "bet" as const, id: x.requestId, since: x.placedAt })),
  ];
  const vrf = vrfFigures(waiting, now);
  log.event("info", "monitor.randomness", { ...vrf });
  findings.push(...assessVrf(waiting, now, config.vrfWarnSeconds));

  const providers = await Promise.all(
    expectedProviders(deployment, config.expectedRandomness).map(async ({ consumer, consumerAddress, expected }): Promise<ProviderInput> => {
      const actual = await r.read<Address>(consumer, "randomness");
      const [adapterConsumer, adapterCoordinator] = await Promise.all([
        r.tryRead<Address>("vrfAdapter", "consumer", [], actual),
        r.tryRead<Address>("vrfAdapter", "coordinator", [], actual),
      ]);
      return {
        consumer,
        consumerAddress,
        expected,
        actual,
        adapterConsumer: adapterConsumer ?? null,
        adapterCoordinator: adapterCoordinator ?? null,
      };
    }),
  );
  log.event("info", "monitor.providers", {
    providers: providers.map((p) => ({ consumer: p.consumer, randomness: p.actual, expected: p.expected, looksLikeVrfAdapter: p.adapterConsumer !== null && p.adapterCoordinator !== null })),
  });
  findings.push(...assessProviders(providers, config.chainId));

  // ownership
  const expectedOwner = config.expectedOwner ?? deployment.owner;
  const owners = await Promise.all(
    OWNED.map(async (contract): Promise<OwnerInput> => {
      const [owner, pendingOwner] = await Promise.all([
        r.tryRead<Address>("ownable", "owner", [], deployment[contract]),
        r.tryRead<Address>("ownable", "pendingOwner", [], deployment[contract]),
      ]);
      const previous = ctx.cache.data.owners[contract] ?? null;
      if (owner) ctx.cache.data.owners[contract] = owner;
      return { contract, owner: owner ?? null, pendingOwner: pendingOwner ?? null, previous };
    }),
  );
  log.event("info", "monitor.owners", { expected: expectedOwner, owners: Object.fromEntries(owners.map((o) => [o.contract, o.owner])) });
  findings.push(...assessOwners(owners, expectedOwner, config.account?.address ?? null));

  // wiring the docs warn about
  const predictionOracle = await r.read<Address>("predictionMarket", "oracle");
  if (isAddressEqual(predictionOracle, deployment.salesFloorOracle)) {
    findings.push(warn("prediction_on_sales_oracle", "the PredictionMarket settles on the SalesFloorOracle, which four wash trades can move (SECURITY.md)"));
  }

  // the keeper itself
  let keeperBalance: bigint | null = null;
  if (config.account) {
    keeperBalance = await ctx.client.getBalance({ address: config.account.address });
    if (keeperBalance < config.lowBalanceWei) {
      findings.push(warn("keeper_balance_low", `the keeper holds ${eth(keeperBalance)}, below ${eth(config.lowBalanceWei)}`));
    }
  }

  return {
    task: "monitor",
    results: [],
    findings,
    wakeAt: [],
    summary: [
      ...figures.map(describeCollection),
      `games: bankroll ${eth(games.bankrollWei)}, reserved ${eth(games.reservedWei)} (${Number(games.reservedShareBps) / 100}% of house funds, cap ${Number(games.reservedCapBps) / 100}%), largest wager ${eth(games.largestWagerWei)}`,
      `randomness: ${vrf.waiting.map((w) => `${w.count} ${w.kind}${w.oldestSeconds === null ? "" : ` (oldest ${duration(w.oldestSeconds)})`}`).join(", ")} waiting`,
      `providers: ${providers.map((p) => `${p.consumer} -> ${p.actual}`).join(", ")}`,
      `owner: expected ${expectedOwner}; ${owners.filter((o) => o.owner !== null && isAddressEqual(o.owner, expectedOwner)).length} of ${owners.length} contracts match`,
    ],
    metrics: {
      collections: figures.length,
      games: { bankrollEth: formatEther(games.bankrollWei), reservedShareBps: games.reservedShareBps, largestWagerEth: formatEther(games.largestWagerWei) },
      waitingForRandomness: vrf.total,
      keeperBalanceWei: keeperBalance,
    },
  };
}

/** One line per collection for the human summary. */
export function describeCollection(f: CollectionFigures): string {
  const since = f.secondsSinceLastFill === null ? "never filled" : `last fill ${duration(f.secondsSinceLastFill)} ago`;
  return (
    `${f.collection}: budget ${eth(f.budgetWei)}, curve ${eth(f.curvePriceWei)}, bid ${eth(f.currentBidWei)}` +
    `${f.budgetLimited ? " (budget-limited)" : ""}, budget = ${f.budgetInBids?.toFixed(2) ?? "n/a"} bids, ${since}, ` +
    `maxPrice ${eth(f.maxPriceWei)} = ${f.maxPriceOverBase?.toFixed(2) ?? "n/a"} x base`
  );
}
