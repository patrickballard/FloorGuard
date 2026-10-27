import { parseEther } from "viem";
import { describe, expect, it } from "vitest";
import {
  type CollectionInput,
  type OwnerInput,
  type ProviderInput,
  type Waiting,
  assessCollection,
  assessGames,
  assessOwners,
  assessProviders,
  assessVrf,
  collectionFigures,
  describeCollection,
  expectedProviders,
  gamesFigures,
  ratio,
  vrfFigures,
} from "../src/tasks/monitor.ts";
import type { Deployment } from "../src/chain.ts";
import { A, DAY, HOUR } from "./helpers.ts";

const NOW = 1_800_000_000n;
const e = parseEther;
const codes = (findings: { level: string; code: string }[]) => findings.map((f) => `${f.level}:${f.code}`);

describe("monitor: collections", () => {
  const input = (over: Partial<CollectionInput> = {}): CollectionInput => ({
    collection: A(1),
    now: NOW,
    budget: e("5"),
    curvePrice: e("1"),
    currentBid: e("1"),
    basePrice: e("0.9"),
    maxPrice: e("1.5"),
    growthBpsPerDay: 1_000n,
    stepDownBps: 500n,
    active: true,
    fillable: true,
    fillCooldown: 3_600n,
    lastFillAt: NOW - 2n * DAY,
    minBid: e("0.09"),
    salesFloor: null,
    pushFloor: null,
    ...over,
  });

  it("derives the figures the economics review asks for", () => {
    const f = collectionFigures(input());
    expect(f.budgetWei).toBe(e("5"));
    expect(f.curvePriceWei).toBe(e("1"));
    expect(f.currentBidWei).toBe(e("1"));
    expect(f.budgetLimited).toBe(false);
    expect(f.budgetInBids).toBe(5);
    expect(f.secondsSinceLastFill).toBe(2n * DAY);
    expect(f.maxPriceOverBase).toBeCloseTo(1.6666, 3);
    expect(f.curveAtMaxPrice).toBe(false);
    expect(describeCollection(f)).toContain("budget = 5.00 bids");
  });

  it("flags a budget more than three bids deep: the curve is too slow", () => {
    expect(codes(assessCollection(collectionFigures(input()), 3))).toEqual(["warn:budget_idle"]);
    expect(codes(assessCollection(collectionFigures(input({ budget: e("3") })), 3))).toEqual([]);
  });

  it("recognises a budget-limited bid", () => {
    const f = collectionFigures(input({ budget: e("0.4"), currentBid: e("0.4") }));
    expect(f.budgetLimited).toBe(true);
    expect(f.budgetInBids).toBe(0.4);
    expect(codes(assessCollection(f, 3))).toEqual(["info:budget_limited"]);
  });

  it("recognises a bid the engine would refuse because it is under minBidOf", () => {
    const f = collectionFigures(input({ budget: e("0.05"), currentBid: e("0.05") }));
    expect(f.bidBelowMinimum).toBe(true);
    expect(codes(assessCollection(f, 3))).toEqual(["info:bid_below_minimum"]);
    // a deployment without minBidOf has no such state
    expect(collectionFigures(input({ budget: e("0.05"), currentBid: e("0.05"), minBid: null })).bidBelowMinimum).toBe(false);
  });

  it("warns when the curve has reached maxPrice", () => {
    const f = collectionFigures(input({ budget: e("2"), curvePrice: e("1.5"), currentBid: e("1.5") }));
    expect(f.curveAtMaxPrice).toBe(true);
    expect(codes(assessCollection(f, 3))).toEqual(["warn:curve_at_max_price"]);
  });

  it("compares the bid and maxPrice with an oracle floor when there is one", () => {
    const f = collectionFigures(input({ budget: e("2"), pushFloor: e("0.8"), salesFloor: e("2") }));
    expect(f.maxPriceOverFloor).toBe(1.875); // the push oracle is preferred
    expect(f.bidOverFloor).toBe(1.25);
    expect(codes(assessCollection(f, 3))).toEqual(["warn:bid_above_floor"]);
    expect(collectionFigures(input()).bidOverFloor).toBeNull();
  });

  it("says never filled, and only notes an inactive bid", () => {
    const f = collectionFigures(input({ lastFillAt: 0n, active: false, currentBid: 0n }));
    expect(f.secondsSinceLastFill).toBeNull();
    expect(describeCollection(f)).toContain("never filled");
    expect(codes(assessCollection(f, 3))).toEqual(["info:bid_inactive"]);
  });

  it("ratio handles zero", () => {
    expect(ratio(1n, 0n)).toBeNull();
    expect(ratio(1n, 3n)).toBe(0.3333);
  });
});

describe("monitor: games", () => {
  const input = { bankroll: e("40"), reserved: e("10"), openWagers: e("1"), balance: e("51"), minBet: e("0.001"), maxWagerBps: 100n, maxExposureBps: 100n, maxTotalExposureBps: 2_000n };

  it("derives bankroll, reserved share and the largest wager", () => {
    const f = gamesFigures(input);
    expect(f.reservedShareBps).toBe(2_000n); // 10 of 50
    expect(f.largestWagerWei).toBe(e("0.4"));
    expect(f.largestExposureWei).toBe(e("0.4"));
    expect(codes(assessGames(f))).toEqual(["warn:games_reserve_near_cap"]);
  });

  it("is quiet for a healthy bankroll", () => {
    expect(assessGames(gamesFigures({ ...input, reserved: e("1"), balance: e("42") }))).toEqual([]);
  });

  it("warns when no bet can be placed", () => {
    const f = gamesFigures({ ...input, bankroll: e("0.05"), reserved: 0n, openWagers: 0n, balance: e("0.05") });
    expect(codes(assessGames(f))).toEqual(["warn:games_no_bets_possible"]);
    expect(gamesFigures({ ...input, bankroll: 0n, reserved: 0n }).reservedShareBps).toBe(0n);
  });

  it("raises an error when the contract holds less than it accounts for", () => {
    expect(codes(assessGames(gamesFigures({ ...input, reserved: e("1"), balance: e("41.5") })))).toEqual(["error:games_insolvent"]);
    // without openWagers tracking only bankroll and reserve are compared
    expect(assessGames(gamesFigures({ ...input, reserved: e("1"), openWagers: null, balance: e("41.5") }))).toEqual([]);
  });
});

describe("monitor: randomness", () => {
  const waiting: Waiting[] = [
    { kind: "bet", id: 4n, since: NOW - 30n },
    { kind: "bet", id: 5n, since: NOW - 2n * HOUR },
    { kind: "lottery", id: 1n, since: NOW - 700n },
  ];

  it("counts what is waiting and for how long", () => {
    const f = vrfFigures(waiting, NOW);
    expect(f.total).toBe(3);
    expect(f.waiting).toEqual([
      { kind: "vaultRaffle", count: 0, oldestSeconds: null },
      { kind: "lottery", count: 1, oldestSeconds: 700n },
      { kind: "ticketRaffle", count: 0, oldestSeconds: null },
      { kind: "bet", count: 2, oldestSeconds: 2n * HOUR },
    ]);
  });

  it("warns about anything waiting longer than the threshold", () => {
    const findings = assessVrf(waiting, NOW, 600n);
    expect(codes(findings)).toEqual(["warn:randomness_late", "warn:randomness_late"]);
    expect(findings.map((f) => f.data!.id)).toEqual([5n, 1n]);
  });

  const provider = (over: Partial<ProviderInput> = {}): ProviderInput => ({
    consumer: "games",
    consumerAddress: A(10),
    expected: A(20),
    actual: A(20),
    adapterConsumer: A(10),
    adapterCoordinator: A(30),
    ...over,
  });

  it("accepts the expected provider", () => {
    expect(assessProviders([provider()], 1)).toEqual([]);
  });

  it("raises an error when randomness() is not the expected provider", () => {
    expect(codes(assessProviders([provider({ actual: A(21) })], 1))).toEqual(["error:randomness_provider_changed"]);
    expect(codes(assessProviders([provider({ actual: A(21) })], 31337))).toEqual(["error:randomness_provider_changed"]);
  });

  it("on a public chain, raises an error for a provider that is not the VRF adapter of that consumer", () => {
    const mock = provider({ adapterConsumer: null, adapterCoordinator: null });
    expect(codes(assessProviders([mock], 1))).toEqual(["error:randomness_provider_not_vrf"]);
    expect(assessProviders([mock], 31337)).toEqual([]); // the mock is expected on a local chain
    expect(codes(assessProviders([provider({ adapterConsumer: A(11) })], 8453))).toEqual(["error:randomness_provider_wrong_consumer"]);
  });

  describe("which providers are checked", () => {
    const deployment = {
      vault: A(4),
      vaultRaffle: A(7),
      games: A(8),
      ticketRaffle: A(9),
      lottery: A(10),
      randomness: A(14),
      gamesRandomness: A(15),
      ticketRaffleRandomness: A(16),
      lotteryRandomness: A(17),
      vaultRandomness: A(18),
    } as unknown as Deployment;
    const of = (list: ReturnType<typeof expectedProviders>) => Object.fromEntries(list.map((p) => [p.consumer, p]));

    it("checks the Vault against vaultRandomness from the deployment file, next to the other consumers", () => {
      const checked = of(expectedProviders(deployment, {}));
      expect(Object.keys(checked)).toEqual(["vault", "vaultRaffle", "games", "ticketRaffle", "lottery"]);
      expect(checked.vault).toEqual({ consumer: "vault", consumerAddress: A(4), expected: A(18) });
      expect(checked.vaultRaffle!.expected).toBe(A(14));
    });

    it("lets KEEPER_EXPECTED_RANDOMNESS_VAULT override the deployment file", () => {
      expect(of(expectedProviders(deployment, { vault: A(40) })).vault!.expected).toBe(A(40));
    });

    it("leaves the Vault out for a deployment made before it had its own provider", () => {
      const before = { ...deployment, vaultRandomness: null } as Deployment;
      expect(of(expectedProviders(before, {})).vault).toBeUndefined();
      expect(of(expectedProviders(before, { vault: A(40) })).vault!.expected).toBe(A(40));
    });

    it("raises an error when the Vault's provider is not the expected one", () => {
      const vault = provider({ consumer: "vault", consumerAddress: A(4), expected: A(18), actual: A(14), adapterConsumer: A(7) });
      expect(codes(assessProviders([vault], 8453))).toEqual(["error:randomness_provider_changed"]);
    });
  });
});

describe("monitor: ownership", () => {
  const owner = (over: Partial<OwnerInput> = {}): OwnerInput => ({ contract: "vault", owner: A(1), pendingOwner: A(0), previous: null, ...over });

  it("is quiet when every owner is the expected one", () => {
    expect(assessOwners([owner(), owner({ contract: "games", previous: A(1) })], A(1), A(9))).toEqual([]);
  });

  it("raises an error when an owner is not the expected one", () => {
    expect(codes(assessOwners([owner({ owner: A(2) })], A(1), null))).toEqual(["error:owner_unexpected"]);
  });

  it("raises an error when an owner changed since the last run, even to the expected one", () => {
    const findings = assessOwners([owner({ owner: A(2), previous: A(1) })], A(1), null);
    expect(codes(findings)).toEqual(["error:owner_changed"]);
    expect(findings[0]!.message).toContain(A(1));
    expect(codes(assessOwners([owner({ owner: A(1), previous: A(2) })], A(1), null))).toEqual(["error:owner_changed"]);
  });

  it("only warns while a two-step handover to the expected owner is not accepted yet", () => {
    expect(codes(assessOwners([owner({ owner: A(5), pendingOwner: A(1) })], A(1), null))).toEqual(["warn:ownership_handover_pending"]);
  });

  it("warns about a transfer started to anyone else", () => {
    expect(codes(assessOwners([owner({ pendingOwner: A(7) })], A(1), null))).toEqual(["warn:ownership_transfer_started"]);
  });

  it("warns when the keeper's own key is an owner", () => {
    expect(codes(assessOwners([owner()], A(1), A(1)))).toEqual(["warn:keeper_is_owner"]);
  });

  it("skips contracts that have no owner()", () => {
    expect(assessOwners([owner({ owner: null, pendingOwner: null })], A(1), null)).toEqual([]);
  });
});
