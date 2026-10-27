// Configuration from environment variables, optionally on top of a small JSON file with the same keys.
// The private key is turned into a signer here and the raw key is never stored on the returned object.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, type Hex, type LocalAccount, getAddress, isAddress, isHex, parseEther, parseGwei } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decryptKeystore } from "./keystore.ts";
import { TASK_NAMES, type TaskName } from "./types.ts";

export const KEEPER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = resolve(KEEPER_DIR, "..");

export interface Config {
  rpcUrl: string;
  chainId: number;
  deploymentFile: string;
  outDir: string;
  cacheFile: string | null;
  tasks: Record<TaskName, boolean>;
  /** True when asked for, and always when no key is configured. */
  dryRun: boolean;
  dryRunReason: string | null;
  /** The signer. Null in dry-run without a key. */
  account: LocalAccount | null;
  /** The `from` of simulations when there is no signer. */
  simulateFrom: Address;

  maxFeePerGasWei: bigint;
  maxPriorityFeePerGasWei: bigint;
  maxSpendPerRunWei: bigint;
  maxSpendPerDayWei: bigint;
  maxGasPerTx: bigint;
  gasLimitMarginBps: bigint;
  maxActionsPerRun: number;
  txTimeoutSeconds: number;
  maxReplacements: number;

  pollSeconds: number;
  fastPollSeconds: number;
  logRange: bigint;
  startBlock: bigint;
  readConcurrency: number;

  flushIntervalSeconds: bigint;
  flushLeadSeconds: bigint;
  flushMaxBatch: number;
  flushGasPerAccount: bigint;
  flushMinPending: bigint;
  flushOnlyWithOpenRaffle: boolean;
  requireFlushedBeforeDraw: boolean;

  lotteryAbort: boolean;
  ticketRaffleAbort: boolean;
  /** Never request a draw this close to the moment after which `draw`/`close` opens refunds instead. */
  abortGuardSeconds: bigint;
  vaultStartAuction: boolean;
  vaultRestartAuction: boolean;
  /** How long an auction is left at its reserve before the keeper restarts it. */
  vaultRestartDwellSeconds: bigint;

  /** A market waiting this long for a settlement price is a warning instead of a note. */
  predictionStuckWarnSeconds: bigint;

  collections: Address[];
  expectedOwner: Address | null;
  /** Overrides for the randomness provider each consumer is expected to use. */
  expectedRandomness: Partial<Record<"vault" | "vaultRaffle" | "games" | "ticketRaffle" | "lottery", Address>>;
  vrfWarnSeconds: bigint;
  budgetInBidsWarn: number;
  lowBalanceWei: bigint;

  logFormat: "json" | "text" | "both";
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

const SECRET_KEYS = ["KEEPER_PRIVATE_KEY", "KEEPER_KEYSTORE_PASSWORD"] as const;

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new ConfigError(`${key}: expected true or false`);
}

function int(env: Env, key: string, fallback: number, min = 0): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min) throw new ConfigError(`${key}: expected an integer >= ${min}`);
  return Number(raw);
}

function big(env: Env, key: string, fallback: bigint): bigint {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${key}: expected a non-negative integer`);
  return BigInt(raw);
}

function amount(env: Env, key: string, fallback: string, parse: (v: string) => bigint): bigint {
  const raw = env[key]?.trim() || fallback;
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new ConfigError(`${key}: expected a decimal number`);
  return parse(raw);
}

function address(env: Env, key: string): Address | null {
  const raw = env[key]?.trim();
  if (!raw) return null;
  if (!isAddress(raw, { strict: false })) throw new ConfigError(`${key}: not an address`);
  return getAddress(raw);
}

function path(raw: string, base: string): string {
  return isAbsolute(raw) ? raw : resolve(base, raw);
}

/** Merge an optional JSON config file under the environment. The file may not contain secrets. */
export function mergeConfigFile(env: Env, base = process.cwd()): Env {
  const file = env.KEEPER_CONFIG?.trim();
  if (!file) return { ...env };
  const full = path(file, base);
  if (!existsSync(full)) throw new ConfigError(`KEEPER_CONFIG: ${full} does not exist`);
  const parsed = JSON.parse(readFileSync(full, "utf8")) as Record<string, unknown>;
  const merged: Env = {};
  for (const [key, value] of Object.entries(parsed)) {
    if ((SECRET_KEYS as readonly string[]).includes(key)) {
      throw new ConfigError(`${key} must not be in a config file; use the environment or a keystore`);
    }
    if (!key.startsWith("KEEPER_")) throw new ConfigError(`config file: unknown key ${key}`);
    merged[key] = String(value);
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function loadAccount(env: Env, base: string): LocalAccount | null {
  const rawKey = env.KEEPER_PRIVATE_KEY?.trim();
  const keystore = env.KEEPER_KEYSTORE?.trim();
  if (rawKey && keystore) throw new ConfigError("set KEEPER_PRIVATE_KEY or KEEPER_KEYSTORE, not both");
  let key: Hex | null = null;
  if (rawKey) {
    const hex = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
    // never echo the value, whatever is wrong with it
    if (!isHex(hex) || hex.length !== 66) throw new ConfigError("KEEPER_PRIVATE_KEY: expected 32 bytes of hex");
    key = hex;
  } else if (keystore) {
    const file = path(keystore, base);
    if (!existsSync(file)) throw new ConfigError(`KEEPER_KEYSTORE: ${file} does not exist`);
    let password = env.KEEPER_KEYSTORE_PASSWORD;
    const passwordFile = env.KEEPER_KEYSTORE_PASSWORD_FILE?.trim();
    if (password === undefined && passwordFile) {
      password = readFileSync(path(passwordFile, base), "utf8").replace(/\r?\n$/, "");
    }
    if (password === undefined) {
      throw new ConfigError("KEEPER_KEYSTORE needs KEEPER_KEYSTORE_PASSWORD or KEEPER_KEYSTORE_PASSWORD_FILE");
    }
    key = decryptKeystore(readFileSync(file, "utf8"), password);
  }
  if (key === null) return null;
  try {
    return privateKeyToAccount(key);
  } catch {
    throw new ConfigError("the configured private key is not a valid secp256k1 key");
  }
}

/**
 * Build the configuration. `env` is not modified, except that with `scrub` the secrets are removed
 * from it once the signer exists, so that nothing later in the process can read or print them.
 */
export function loadConfig(rawEnv: Env = process.env, options: { base?: string; scrub?: boolean } = {}): Config {
  const base = options.base ?? process.cwd();
  const env = mergeConfigFile(rawEnv, base);

  const rpcUrl = env.KEEPER_RPC_URL?.trim();
  if (!rpcUrl) throw new ConfigError("KEEPER_RPC_URL is required");
  if (!/^https?:\/\//.test(rpcUrl)) throw new ConfigError("KEEPER_RPC_URL: expected an http(s) URL");
  const chainId = int(env, "KEEPER_CHAIN_ID", 0);
  if (chainId === 0) throw new ConfigError("KEEPER_CHAIN_ID is required");

  const account = loadAccount(env, base);
  if (options.scrub) for (const key of SECRET_KEYS) delete rawEnv[key];

  const askedDryRun = bool(env, "KEEPER_DRY_RUN", false);
  const dryRun = askedDryRun || account === null;
  const dryRunReason = !dryRun
    ? null
    : account === null
      ? "no private key configured (KEEPER_PRIVATE_KEY or KEEPER_KEYSTORE)"
      : "KEEPER_DRY_RUN is on";

  const tasks = Object.fromEntries(
    TASK_NAMES.map((task) => [task, bool(env, `KEEPER_TASK_${snake(task)}`, true)]),
  ) as Record<TaskName, boolean>;

  const collections = (env.KEEPER_COLLECTIONS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => {
      if (!isAddress(raw, { strict: false })) throw new ConfigError("KEEPER_COLLECTIONS: not an address: " + raw);
      return getAddress(raw);
    });

  const logFormat = (env.KEEPER_LOG_FORMAT?.trim() || "both") as Config["logFormat"];
  if (!["json", "text", "both"].includes(logFormat)) throw new ConfigError("KEEPER_LOG_FORMAT: json, text or both");

  const expectedRandomness: Config["expectedRandomness"] = {};
  for (const [name, key] of [
    ["vault", "KEEPER_EXPECTED_RANDOMNESS_VAULT"],
    ["vaultRaffle", "KEEPER_EXPECTED_RANDOMNESS_VAULT_RAFFLE"],
    ["games", "KEEPER_EXPECTED_RANDOMNESS_GAMES"],
    ["ticketRaffle", "KEEPER_EXPECTED_RANDOMNESS_TICKET_RAFFLE"],
    ["lottery", "KEEPER_EXPECTED_RANDOMNESS_LOTTERY"],
  ] as const) {
    const value = address(env, key);
    if (value) expectedRandomness[name] = value;
  }

  const cacheFile = env.KEEPER_CACHE_FILE?.trim();
  return {
    rpcUrl,
    chainId,
    deploymentFile: path(env.KEEPER_DEPLOYMENT_FILE?.trim() || join(REPO_DIR, "deployments", `${chainId}.json`), base),
    outDir: path(env.KEEPER_OUT_DIR?.trim() || join(REPO_DIR, "out"), base),
    cacheFile: cacheFile ? path(cacheFile, base) : null,
    tasks,
    dryRun,
    dryRunReason,
    account,
    simulateFrom: account?.address ?? address(env, "KEEPER_SIMULATE_FROM") ?? "0x000000000000000000000000000000000000dEaD",

    maxFeePerGasWei: amount(env, "KEEPER_MAX_FEE_GWEI", "30", parseGwei),
    maxPriorityFeePerGasWei: amount(env, "KEEPER_MAX_PRIORITY_FEE_GWEI", "2", parseGwei),
    maxSpendPerRunWei: amount(env, "KEEPER_MAX_SPEND_PER_RUN_ETH", "0.05", parseEther),
    maxSpendPerDayWei: amount(env, "KEEPER_MAX_SPEND_PER_DAY_ETH", "0.2", parseEther),
    maxGasPerTx: big(env, "KEEPER_MAX_GAS_PER_TX", 3_000_000n),
    gasLimitMarginBps: big(env, "KEEPER_GAS_LIMIT_MARGIN_BPS", 3_000n),
    maxActionsPerRun: int(env, "KEEPER_MAX_ACTIONS_PER_RUN", 50, 1),
    txTimeoutSeconds: int(env, "KEEPER_TX_TIMEOUT_SECONDS", 90, 1),
    maxReplacements: int(env, "KEEPER_MAX_REPLACEMENTS", 3),

    pollSeconds: int(env, "KEEPER_POLL_SECONDS", 60, 1),
    fastPollSeconds: int(env, "KEEPER_FAST_POLL_SECONDS", 6, 1),
    logRange: big(env, "KEEPER_LOG_RANGE", 5_000n),
    startBlock: big(env, "KEEPER_START_BLOCK", 0n),
    readConcurrency: int(env, "KEEPER_READ_CONCURRENCY", 25, 1),

    flushIntervalSeconds: big(env, "KEEPER_FLUSH_INTERVAL_SECONDS", 86_400n),
    flushLeadSeconds: big(env, "KEEPER_FLUSH_LEAD_SECONDS", 3_600n),
    flushMaxBatch: int(env, "KEEPER_FLUSH_MAX_BATCH", 100, 1),
    flushGasPerAccount: big(env, "KEEPER_FLUSH_GAS_PER_ACCOUNT", 110_000n),
    flushMinPending: big(env, "KEEPER_FLUSH_MIN_PENDING", 1n),
    flushOnlyWithOpenRaffle: bool(env, "KEEPER_FLUSH_ONLY_WITH_OPEN_RAFFLE", false),
    requireFlushedBeforeDraw: bool(env, "KEEPER_REQUIRE_FLUSHED_BEFORE_DRAW", true),

    lotteryAbort: bool(env, "KEEPER_LOTTERY_ABORT", false),
    ticketRaffleAbort: bool(env, "KEEPER_TICKET_RAFFLE_ABORT", false),
    abortGuardSeconds: big(env, "KEEPER_ABORT_GUARD_SECONDS", 900n),
    vaultStartAuction: bool(env, "KEEPER_VAULT_START_AUCTION", false),
    vaultRestartAuction: bool(env, "KEEPER_VAULT_RESTART_AUCTION", false),
    vaultRestartDwellSeconds: big(env, "KEEPER_VAULT_RESTART_DWELL_SECONDS", 259_200n),

    predictionStuckWarnSeconds: big(env, "KEEPER_PREDICTION_STUCK_WARN_SECONDS", 3_600n),

    collections,
    expectedOwner: address(env, "KEEPER_EXPECTED_OWNER"),
    expectedRandomness,
    vrfWarnSeconds: big(env, "KEEPER_VRF_WARN_SECONDS", 600n),
    budgetInBidsWarn: int(env, "KEEPER_BUDGET_IN_BIDS_WARN", 3),
    lowBalanceWei: amount(env, "KEEPER_LOW_BALANCE_ETH", "0.02", parseEther),

    logFormat,
  };
}

function snake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
}

/** What may be printed about a configuration. The signer is reduced to its address. */
export function describeConfig(config: Config): Record<string, unknown> {
  const { account, rpcUrl, ...rest } = config;
  return {
    ...rest,
    // an RPC URL often carries an API key in its path or query
    rpcUrl: redactUrl(rpcUrl),
    keeper: account?.address ?? null,
  };
}

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.length > 1 || u.search ? "/…" : ""}`;
  } catch {
    return "(invalid url)";
  }
}
