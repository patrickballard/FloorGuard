import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PublicClient, parseAbi, parseEther, parseGwei } from "viem";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Cache, fingerprintOf, utcDay } from "../src/cache.ts";
import { errorText, isRevert, mapLimit, namedOutputs, parseDeployment, range } from "../src/chain.ts";
import { ConfigError, describeConfig, loadConfig, mergeConfigFile, redactUrl } from "../src/config.ts";
import { firstOpen } from "../src/context.ts";
import { decryptKeystore, encryptKeystore } from "../src/keystore.ts";
import { jsonSafe, makeLogger, renderSummary } from "../src/logger.ts";
import { blockRanges, getLogsChunked, scanFrom } from "../src/logs.ts";
import { EXIT, exitCodeOf, nextDelaySeconds } from "../src/runner.ts";
import type { RunReport, TaskReport } from "../src/types.ts";
import { A } from "./helpers.ts";

// anvil's well-known development key #1 and its address
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const BASE = { KEEPER_RPC_URL: "http://127.0.0.1:8547", KEEPER_CHAIN_ID: "31337" };

const dir = mkdtempSync(join(tmpdir(), "floorguard-keeper-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("configuration", () => {
  it("runs in dry-run, and says why, when no key is configured", () => {
    const config = loadConfig({ ...BASE });
    expect(config.dryRun).toBe(true);
    expect(config.account).toBeNull();
    expect(config.dryRunReason).toMatch(/no private key/);
  });

  it("reads the key from the environment, with or without 0x", () => {
    for (const key of [KEY, KEY.slice(2)]) {
      const config = loadConfig({ ...BASE, KEEPER_PRIVATE_KEY: key });
      expect(config.account!.address).toBe(ADDRESS);
      expect(config.dryRun).toBe(false);
      expect(config.dryRunReason).toBeNull();
    }
  });

  it("stays in dry-run with a key when asked to", () => {
    const config = loadConfig({ ...BASE, KEEPER_PRIVATE_KEY: KEY, KEEPER_DRY_RUN: "true" });
    expect(config.dryRun).toBe(true);
    expect(config.dryRunReason).toMatch(/KEEPER_DRY_RUN/);
    expect(config.simulateFrom).toBe(ADDRESS);
  });

  it("never puts the key in the configuration, its description or an error", () => {
    const env: Record<string, string | undefined> = { ...BASE, KEEPER_PRIVATE_KEY: KEY };
    const config = loadConfig(env, { scrub: true });
    const needle = KEY.slice(2).toLowerCase();
    expect(JSON.stringify(describeConfig(config), jsonSafe).toLowerCase()).not.toContain(needle);
    expect(JSON.stringify(config, jsonSafe).toLowerCase()).not.toContain(needle);
    expect(describeConfig(config).keeper).toBe(ADDRESS);
    // with scrub, the variable is gone from the environment it was read from
    expect(env.KEEPER_PRIVATE_KEY).toBeUndefined();

    for (const bad of [KEY + "00", KEY.slice(0, 40), "0x" + "zz".repeat(32), "0x" + "00".repeat(32)]) {
      let message = "";
      try {
        loadConfig({ ...BASE, KEEPER_PRIVATE_KEY: bad });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(bad.slice(2, 20));
    }
  });

  it("reads the key from an encrypted keystore", () => {
    const file = join(dir, "keeper.keystore.json");
    writeFileSync(file, encryptKeystore(KEY, "correct horse"));
    expect(readFileSync(file, "utf8")).not.toContain(KEY.slice(2));
    expect(decryptKeystore(readFileSync(file, "utf8"), "correct horse")).toBe(KEY);
    expect(() => decryptKeystore(readFileSync(file, "utf8"), "wrong")).toThrow(/wrong password/);

    expect(loadConfig({ ...BASE, KEEPER_KEYSTORE: file, KEEPER_KEYSTORE_PASSWORD: "correct horse" }).account!.address).toBe(ADDRESS);
    const passwordFile = join(dir, "password.txt");
    writeFileSync(passwordFile, "correct horse\n");
    expect(loadConfig({ ...BASE, KEEPER_KEYSTORE: file, KEEPER_KEYSTORE_PASSWORD_FILE: passwordFile }).account!.address).toBe(ADDRESS);
    expect(() => loadConfig({ ...BASE, KEEPER_KEYSTORE: file })).toThrow(/KEEPER_KEYSTORE_PASSWORD/);
    expect(() => loadConfig({ ...BASE, KEEPER_KEYSTORE: file, KEEPER_KEYSTORE_PASSWORD: "x", KEEPER_PRIVATE_KEY: KEY })).toThrow(/not both/);
  });

  it("decrypts a pbkdf2 keystore too (the Web3 Secret Storage test vector)", () => {
    const vector = {
      version: 3,
      crypto: {
        cipher: "aes-128-ctr",
        cipherparams: { iv: "6087dab2f9fdbbfaddc31a909735c1e6" },
        ciphertext: "5318b4d5bcd28de64ee5559e671353e16f075ecae9f99c7a79a38af5f869aa46",
        kdf: "pbkdf2",
        kdfparams: { c: 262144, dklen: 32, prf: "hmac-sha256", salt: "ae3cd4e7013836a3df6bd7241b12db061dbe2c6785853cce422d148a624ce0bd" },
        mac: "517ead924a9d0dc3124507e3393d175ce3ff7c1e96529c6c555ce9e51205e9b2",
      },
    };
    expect(decryptKeystore(JSON.stringify(vector), "testpassword")).toBe("0x7a28b5ba57c53603b0b07b56bba752f7784bf506fa95edc395f5cf6c7514fe9d");
  });

  it("has a switch for every task, all on by default", () => {
    const all = loadConfig({ ...BASE });
    expect(Object.values(all.tasks).every(Boolean)).toBe(true);
    expect(Object.keys(all.tasks)).toEqual(["prediction", "points", "vaultRaffle", "lottery", "ticketRaffle", "games", "vault", "monitor"]);
    const some = loadConfig({ ...BASE, KEEPER_TASK_VAULT_RAFFLE: "off", KEEPER_TASK_TICKET_RAFFLE: "0", KEEPER_TASK_GAMES: "false" });
    expect(some.tasks).toMatchObject({ vaultRaffle: false, ticketRaffle: false, games: false, prediction: true, monitor: true });
  });

  it("keeps the dangerous options off unless asked", () => {
    const config = loadConfig({ ...BASE });
    expect(config).toMatchObject({ lotteryAbort: false, ticketRaffleAbort: false, vaultStartAuction: false, vaultRestartAuction: false });
    expect(loadConfig({ ...BASE, KEEPER_LOTTERY_ABORT: "true" }).lotteryAbort).toBe(true);
  });

  it("parses limits and amounts", () => {
    const config = loadConfig({
      ...BASE,
      KEEPER_MAX_FEE_GWEI: "12.5",
      KEEPER_MAX_SPEND_PER_RUN_ETH: "0.01",
      KEEPER_MAX_SPEND_PER_DAY_ETH: "0.1",
      KEEPER_POLL_SECONDS: "30",
      KEEPER_LOG_RANGE: "500",
      KEEPER_START_BLOCK: "123456",
      KEEPER_FLUSH_MAX_BATCH: "20",
      KEEPER_COLLECTIONS: `${A(1)}, ${A(2)}`,
    });
    expect(config.maxFeePerGasWei).toBe(parseGwei("12.5"));
    expect(config.maxSpendPerRunWei).toBe(parseEther("0.01"));
    expect(config.maxSpendPerDayWei).toBe(parseEther("0.1"));
    expect(config.pollSeconds).toBe(30);
    expect(config.logRange).toBe(500n);
    expect(config.startBlock).toBe(123_456n);
    expect(config.flushMaxBatch).toBe(20);
    expect(config.collections).toHaveLength(2);
    expect(config.deploymentFile).toMatch(/deployments\/31337\.json$/);
  });

  it("reads an expected randomness provider for each consumer, the Vault included", () => {
    const config = loadConfig({ ...BASE, KEEPER_EXPECTED_RANDOMNESS_VAULT: A(18), KEEPER_EXPECTED_RANDOMNESS_GAMES: A(16) });
    expect(config.expectedRandomness).toEqual({ vault: A(18), games: A(16) });
    expect(loadConfig({ ...BASE }).expectedRandomness).toEqual({});
  });

  it("rejects what it cannot use", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ KEEPER_RPC_URL: "http://x" })).toThrow(/KEEPER_CHAIN_ID/);
    expect(() => loadConfig({ ...BASE, KEEPER_RPC_URL: "ws://x" })).toThrow(/http/);
    expect(() => loadConfig({ ...BASE, KEEPER_DRY_RUN: "maybe" })).toThrow(/true or false/);
    expect(() => loadConfig({ ...BASE, KEEPER_MAX_FEE_GWEI: "-1" })).toThrow(/decimal/);
    expect(() => loadConfig({ ...BASE, KEEPER_POLL_SECONDS: "0" })).toThrow(/integer/);
    expect(() => loadConfig({ ...BASE, KEEPER_COLLECTIONS: "0x1234" })).toThrow(/not an address/);
    expect(() => loadConfig({ ...BASE, KEEPER_LOG_FORMAT: "xml" })).toThrow(/json, text or both/);
  });

  it("reads a JSON config file under the environment, and refuses secrets in it", () => {
    const file = join(dir, "keeper.json");
    writeFileSync(file, JSON.stringify({ KEEPER_RPC_URL: "http://from-file:1", KEEPER_CHAIN_ID: 5, KEEPER_POLL_SECONDS: 15 }));
    const config = loadConfig({ KEEPER_CONFIG: file, KEEPER_CHAIN_ID: "31337" });
    expect(config.rpcUrl).toBe("http://from-file:1");
    expect(config.chainId).toBe(31337); // the environment wins
    expect(config.pollSeconds).toBe(15);

    writeFileSync(file, JSON.stringify({ KEEPER_PRIVATE_KEY: KEY }));
    expect(() => mergeConfigFile({ KEEPER_CONFIG: file })).toThrow(/must not be in a config file/);
    writeFileSync(file, JSON.stringify({ RPC: "x" }));
    expect(() => mergeConfigFile({ KEEPER_CONFIG: file })).toThrow(/unknown key/);
  });

  it("does not print the secret part of an RPC URL", () => {
    expect(redactUrl("https://mainnet.example.io/v3/0123456789abcdef")).toBe("https://mainnet.example.io/…");
    expect(redactUrl("https://rpc.example.org?apikey=abc")).toBe("https://rpc.example.org/…");
    expect(redactUrl("http://127.0.0.1:8547")).toBe("http://127.0.0.1:8547");
    expect(describeConfig(loadConfig({ ...BASE, KEEPER_RPC_URL: "https://x.io/v3/SECRET" })).rpcUrl).not.toContain("SECRET");
    expect(errorText(new Error("HTTP request failed.\nURL: https://x.io/v3/SECRET"))).toBe("HTTP request failed.");
    expect(errorText({ shortMessage: "failed at https://x.io/v3/SECRET now" })).toBe("failed at <url> now");
  });
});

describe("deployment file", () => {
  const full = Object.fromEntries(
    ["treasury", "marketplace", "buybackEngine", "vault", "predictionMarket", "points", "vaultRaffle", "games", "ticketRaffle", "lottery", "ipLicenseManager", "salesFloorOracle", "pushFloorOracle", "randomness", "gamesRandomness", "ticketRaffleRandomness", "lotteryRandomness", "owner"].map(
      (key, i) => [key, A(i + 1)],
    ),
  );

  it("accepts what script/Deploy.s.sol writes", () => {
    const d = parseDeployment({ ...full, timelock: A(0), demoCollection: A(99) });
    expect(d.vault).toBe(A(4));
    expect(d.timelock).toBeNull();
    expect(d.demoCollection).toBe(A(99));
    expect(parseDeployment(full).demoCollection).toBeNull();
  });

  it("reads the Vault's randomness provider, and accepts deployments made before it had one", () => {
    expect(parseDeployment({ ...full, vaultRandomness: A(50) }).vaultRandomness).toBe(A(50));
    expect(parseDeployment(full).vaultRandomness).toBeNull();
    expect(parseDeployment({ ...full, vaultRandomness: A(0) }).vaultRandomness).toBeNull();
    expect(() => parseDeployment({ ...full, vaultRandomness: "0x12" })).toThrow(/"vaultRandomness"/);
  });

  it("rejects a missing or malformed address, and two targets at one address", () => {
    const { vault: _vault, ...missing } = full;
    expect(() => parseDeployment(missing)).toThrow(/"vault"/);
    expect(() => parseDeployment({ ...full, games: "0x12" })).toThrow(/"games"/);
    expect(() => parseDeployment({ ...full, games: full.vault })).toThrow(/share an address/);
  });
});

describe("cache", () => {
  const deployment = { a: A(1) } as unknown as Parameters<typeof fingerprintOf>[0];

  it("persists scans, spend and watermarks, and survives a restart", () => {
    const file = join(dir, "cache.json");
    const first = new Cache(file, 31337, fingerprintOf(deployment));
    first.data.scanned.points = "120";
    first.data.pointsAccounts = [A(5)];
    first.setWatermark("markets", 4n);
    first.addSpend(1_800_000_000, 5n);
    first.addSpend(1_800_000_100, 7n);
    first.save();

    const second = new Cache(file, 31337, fingerprintOf(deployment));
    expect(second.discarded).toBeNull();
    expect(second.scannedTo("points")).toBe(120n);
    expect(second.scannedTo("games")).toBeNull();
    expect(second.data.pointsAccounts).toEqual([A(5)]);
    expect(second.watermark("markets")).toBe(4n);
    expect(second.watermark("holdings")).toBe(1n);
    expect(second.spentOn(1_800_000_200)).toBe(12n);
  });

  it("starts the daily budget again on a new UTC day", () => {
    const cache = new Cache(null, 1, "0x");
    cache.addSpend(1_800_000_000, 5n);
    expect(utcDay(1_800_000_000)).toBe("2027-01-15");
    expect(cache.spentOn(1_800_000_000 + 86_400)).toBe(0n);
    cache.addSpend(1_800_000_000 + 86_400, 2n);
    expect(cache.spentOn(1_800_000_000 + 86_400)).toBe(2n);
  });

  it("ignores a cache written for another chain or deployment, or a corrupt one", () => {
    const file = join(dir, "cache2.json");
    const cache = new Cache(file, 31337, "0xaa");
    cache.data.scanned.points = "9";
    cache.save();
    expect(new Cache(file, 1, "0xaa").discarded).toMatch(/another chain/);
    expect(new Cache(file, 31337, "0xbb").discarded).toMatch(/another deployment/);
    expect(new Cache(file, 31337, "0xbb").scannedTo("points")).toBeNull();
    writeFileSync(file, "{not json");
    expect(new Cache(file, 31337, "0xaa").discarded).toBe("unreadable");
  });

  it("keeps the day's spend when the scans are reset", () => {
    const cache = new Cache(null, 1, "0x");
    cache.data.scanned.points = "9";
    cache.data.openBets = ["1"];
    cache.addSpend(1_800_000_000, 5n);
    cache.reset();
    expect(cache.data.scanned).toEqual({});
    expect(cache.data.openBets).toEqual([]);
    expect(cache.spentOn(1_800_000_000)).toBe(5n);
  });
});

describe("logs", () => {
  it("splits a block range into spans of the allowed size", () => {
    expect(blockRanges(10n, 25n, 10n)).toEqual([[10n, 19n], [20n, 25n]]);
    expect(blockRanges(5n, 5n, 1_000n)).toEqual([[5n, 5n]]);
    expect(blockRanges(6n, 5n, 10n)).toEqual([]);
    expect(() => blockRanges(0n, 5n, 0n)).toThrow();
  });

  it("resumes a scan a little before where it stopped, never before the start block", () => {
    expect(scanFrom(null, 100n)).toBe(100n);
    expect(scanFrom(1_000n, 100n)).toBe(937n);
    expect(scanFrom(120n, 100n)).toBe(100n);
  });

  it("queries in ranges and halves the range when the provider refuses", async () => {
    const asked: [bigint, bigint][] = [];
    const client = {
      getLogs: vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        asked.push([fromBlock, toBlock]);
        if (toBlock - fromBlock + 1n > 25n) throw new Error("query returned more than 10000 results");
        return [{ blockNumber: fromBlock }];
      }),
    } as unknown as PublicClient;
    const logs = await getLogsChunked(client, { address: A(1), events: [], fromBlock: 0n, toBlock: 99n, maxRange: 100n });
    expect(asked).toEqual([[0n, 99n], [0n, 49n], [0n, 24n], [25n, 49n], [50n, 74n], [75n, 99n]]);
    expect(logs).toHaveLength(4);
  });

  it("gives up only when a single block is refused", async () => {
    const client = { getLogs: vi.fn(async () => Promise.reject(new Error("down"))) } as unknown as PublicClient;
    await expect(getLogsChunked(client, { address: A(1), events: [], fromBlock: 0n, toBlock: 7n, maxRange: 4n })).rejects.toThrow("down");
  });
});

describe("helpers", () => {
  it("names the outputs of a struct getter", () => {
    const abi = parseAbi(["function raffles(uint256) view returns (address collection, uint40 drawAfter, uint8 status)", "function count() view returns (uint256)"]);
    expect(namedOutputs(abi, "raffles", [A(1), 5, 2])).toEqual({ collection: A(1), drawAfter: 5, status: 2 });
    expect(namedOutputs(abi, "count", 9n)).toEqual({ "0": 9n });
  });

  it("finds the first entry that is not final", () => {
    const items = [1n, 2n, 3n, 4n].map((id) => ({ id, done: id !== 3n }));
    expect(firstOpen(items, (i) => i.done, 1n, 4n)).toBe(3n);
    expect(firstOpen(items.filter((i) => i.done), (i) => i.done, 1n, 4n)).toBe(5n);
    expect(firstOpen([], () => true, 1n, 0n)).toBe(1n);
  });

  it("maps with bounded concurrency, in order", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
    expect(range(3n, 5n)).toEqual([3n, 4n, 5n]);
    expect(range(3n, 2n)).toEqual([]);
  });

  it("tells a revert from an RPC failure", () => {
    expect(isRevert({ name: "ContractFunctionExecutionError", cause: { name: "ContractFunctionRevertedError" } })).toBe(true);
    expect(isRevert({ name: "ContractFunctionExecutionError", cause: { name: "HttpRequestError" } })).toBe(false);
    expect(isRevert(new Error("fetch failed"))).toBe(false);
  });
});

describe("run report", () => {
  const task = (over: Partial<TaskReport> = {}): TaskReport => ({ task: "lottery", results: [], findings: [], wakeAt: [], ...over });
  const finding = (level: "info" | "warn" | "error") => ({ task: "lottery" as const, level, code: "x", message: "m" });
  const report = (tasks: TaskReport[], chainTime = 1_000n): RunReport => ({
    startedAt: "",
    chainId: 1,
    block: 1n,
    chainTime,
    dryRun: true,
    keeper: null,
    tasks,
    spentWei: 0n,
    exitCode: exitCodeOf(tasks),
  });

  it("maps what happened to an exit code a cron job can act on", () => {
    expect(exitCodeOf([task(), task({ findings: [finding("info")] })])).toBe(EXIT.ok);
    expect(exitCodeOf([task({ findings: [finding("warn")] })])).toBe(EXIT.attention);
    expect(exitCodeOf([task({ findings: [finding("warn")] }), task({ findings: [finding("error")] })])).toBe(EXIT.failure);
    expect(exitCodeOf([task({ error: "rpc down" })])).toBe(EXIT.failure);
    expect([EXIT.ok, EXIT.fatal, EXIT.attention, EXIT.failure]).toEqual([0, 1, 2, 3]);
  });

  it("sleeps until the next deadline, at most the poll interval, and polls fast when something is overdue", () => {
    expect(nextDelaySeconds(report([task()]), 60, 6)).toBe(60);
    expect(nextDelaySeconds(report([task({ wakeAt: [1_020n, 5_000n] })]), 60, 6)).toBe(20);
    expect(nextDelaySeconds(report([task({ wakeAt: [1_000n] })]), 60, 6)).toBe(6);
    expect(nextDelaySeconds(report([task({ wakeAt: [900n] })]), 60, 6)).toBe(6);
    expect(nextDelaySeconds(report([task({ wakeAt: [1_002n] })]), 60, 6)).toBe(6);
    expect(nextDelaySeconds(report([task({ wakeAt: [1_002n] })]), 3, 6)).toBe(3);
  });

  it("writes JSON lines with big numbers as strings, and a readable summary", () => {
    const out: string[] = [];
    const err: string[] = [];
    const log = makeLogger("both", (l) => out.push(l), (l) => err.push(l));
    log.event("info", "action", { gasUsed: 123n, nested: { wei: 2n ** 80n } });
    const line = JSON.parse(out[0]!);
    expect(line).toMatchObject({ level: "info", event: "action", gasUsed: "123", nested: { wei: (2n ** 80n).toString() } });

    const r = report([
      task({
        task: "prediction",
        results: [{ action: { task: "prediction", contract: "predictionMarket", functionName: "resolve", args: [3n], reason: "price published" }, status: "dry-run", gasEstimate: 65_000n }],
        findings: [finding("warn")],
      }),
    ]);
    log.summary(renderSummary(r));
    expect(out).toHaveLength(1); // the summary goes to stderr when both are on
    expect(err[0]).toContain("DRY RUN");
    expect(err[0]).toContain("[dry-run] predictionMarket.resolve(3): price published (gas est. 65000)");
    expect(err[0]).toContain("WARN x: m");
    expect(err[0]).toContain("exit 2");

    const jsonOnly: string[] = [];
    makeLogger("json", (l) => jsonOnly.push(l)).summary("hidden");
    expect(jsonOnly).toEqual([]);
    const textOnly: string[] = [];
    const text = makeLogger("text", (l) => textOnly.push(l));
    text.event("info", "hidden");
    text.summary("shown");
    expect(textOnly).toEqual(["shown"]);
  });
});
