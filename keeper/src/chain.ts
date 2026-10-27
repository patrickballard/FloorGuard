// ABIs from Foundry's out/, addresses from deployments/<chainId>.json: the same sources the web app
// uses (app/scripts/sync-contracts.mjs), read at start-up instead of being copied.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Abi,
  type AbiFunction,
  type Address,
  type PublicClient,
  createPublicClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  zeroAddress,
} from "viem";
import { ConfigError, type Config } from "./config.ts";
import { TARGET_CONTRACTS, type TargetContract } from "./types.ts";

/** ABI key -> Foundry artifact name. */
export const ARTIFACTS = {
  predictionMarket: "PredictionMarket",
  points: "Points",
  vaultRaffle: "VaultRaffle",
  lottery: "Lottery",
  ticketRaffle: "TicketRaffle",
  games: "Games",
  vault: "Vault",
  buybackEngine: "BuybackEngine",
  treasury: "Treasury",
  marketplace: "Marketplace",
  floorOracle: "IFloorGuard.sol/IFloorOracle",
  ownable: "Ownable2Step",
  vrfAdapter: "ChainlinkVRFRandomness",
} as const;
export type AbiKey = keyof typeof ARTIFACTS;
export type Abis = Record<AbiKey, Abi>;

export function loadAbis(outDir: string): Abis {
  const abis = {} as Abis;
  for (const [key, name] of Object.entries(ARTIFACTS) as [AbiKey, string][]) {
    const file = name.includes("/") ? join(outDir, `${name}.json`) : join(outDir, `${name}.sol`, `${name}.json`);
    if (!existsSync(file)) {
      throw new ConfigError(`no Foundry artifact at ${file}. Run \`forge build\` in the repo root first.`);
    }
    const artifact = JSON.parse(readFileSync(file, "utf8")) as { abi?: Abi };
    if (!Array.isArray(artifact.abi)) throw new ConfigError(`${file}: artifact has no abi`);
    abis[key] = artifact.abi;
  }
  return abis;
}

/** Every custom error of every loaded contract, so a revert from a nested call can be named. */
export function collectErrors(abis: Abis): Abi {
  const seen = new Map<string, Abi[number]>();
  for (const abi of Object.values(abis)) {
    for (const item of abi) {
      if (item.type === "error") seen.set(`${item.name}(${item.inputs.map((i) => i.type).join(",")})`, item);
    }
  }
  return [...seen.values()];
}

const REQUIRED_KEYS = [
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
  "randomness",
  "gamesRandomness",
  "ticketRaffleRandomness",
  "lotteryRandomness",
  "owner",
] as const;
type RequiredKey = (typeof REQUIRED_KEYS)[number];

export type Deployment = Record<RequiredKey, Address> & {
  timelock: Address | null;
  demoCollection: Address | null;
  /** The Vault's unlock-draw provider; deployments made before the moving lock have none. */
  vaultRandomness: Address | null;
};

export function parseDeployment(json: unknown, label = "deployment"): Deployment {
  const raw = json as Record<string, unknown>;
  const out = {} as Record<string, Address | null>;
  for (const key of REQUIRED_KEYS) {
    const value = raw?.[key];
    if (typeof value !== "string" || !isAddress(value, { strict: false })) {
      throw new ConfigError(`${label}: missing or invalid address for "${key}"`);
    }
    out[key] = getAddress(value);
  }
  for (const key of ["timelock", "demoCollection", "vaultRandomness"] as const) {
    const value = raw[key];
    if (value === undefined || value === zeroAddress) {
      out[key] = null;
    } else if (typeof value !== "string" || !isAddress(value, { strict: false })) {
      throw new ConfigError(`${label}: invalid "${key}"`);
    } else {
      out[key] = getAddress(value);
    }
  }
  const deployment = out as Deployment;
  const targets = TARGET_CONTRACTS.map((c) => deployment[c].toLowerCase());
  if (new Set(targets).size !== targets.length) {
    throw new ConfigError(`${label}: two keeper targets share an address`);
  }
  return deployment;
}

export function loadDeployment(file: string): Deployment {
  if (!existsSync(file)) throw new ConfigError(`deployment file ${file} does not exist`);
  return parseDeployment(JSON.parse(readFileSync(file, "utf8")), file);
}

export function targetAddresses(deployment: Deployment): Record<TargetContract, Address> {
  return Object.fromEntries(TARGET_CONTRACTS.map((c) => [c, deployment[c]])) as Record<TargetContract, Address>;
}

export function makeChain(config: Pick<Config, "chainId" | "rpcUrl">) {
  return defineChain({
    id: config.chainId,
    name: `chain-${config.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
}

export function makePublicClient(config: Pick<Config, "chainId" | "rpcUrl">): PublicClient {
  return createPublicClient({
    chain: makeChain(config),
    transport: http(config.rpcUrl, { batch: { batchSize: 100, wait: 5 }, retryCount: 3, timeout: 20_000 }),
    pollingInterval: 1_000,
  }) as PublicClient;
}

/** Reads pinned to one block, so a task decides over a consistent snapshot. */
export class Reader {
  readonly client: PublicClient;
  readonly abis: Abis;
  readonly deployment: Deployment;
  readonly blockNumber: bigint;
  readonly concurrency: number;

  constructor(client: PublicClient, abis: Abis, deployment: Deployment, blockNumber: bigint, concurrency = 25) {
    this.client = client;
    this.abis = abis;
    this.deployment = deployment;
    this.blockNumber = blockNumber;
    this.concurrency = concurrency;
  }

  /** `at` overrides the address, for contracts that are not in the deployment file under `abi`. */
  read<T>(abi: AbiKey, functionName: string, args: readonly unknown[] = [], at?: Address): Promise<T> {
    const address = at ?? (this.deployment as unknown as Record<string, Address>)[abi];
    if (!address) throw new Error(`no address for ${abi}`);
    return this.client.readContract({
      address,
      abi: this.abis[abi],
      functionName,
      args: args as unknown[],
      blockNumber: this.blockNumber,
    }) as Promise<T>;
  }

  /** Like `read`, but undefined instead of an exception when the call reverts. */
  async tryRead<T>(abi: AbiKey, functionName: string, args: readonly unknown[] = [], at?: Address): Promise<T | undefined> {
    try {
      return await this.read<T>(abi, functionName, args, at);
    } catch (error) {
      if (isRevert(error)) return undefined;
      throw error;
    }
  }

  /** A public struct getter, as an object keyed by the struct's field names. */
  async struct<T>(abi: AbiKey, functionName: string, args: readonly unknown[] = []): Promise<T> {
    const result = await this.read<unknown>(abi, functionName, args);
    return namedOutputs(this.abis[abi], functionName, result) as T;
  }

  map<I, O>(items: readonly I[], fn: (item: I) => Promise<O>): Promise<O[]> {
    return mapLimit(items, this.concurrency, fn);
  }
}

export function namedOutputs(abi: Abi, functionName: string, result: unknown): Record<string, unknown> {
  const item = abi.find((i): i is AbiFunction => i.type === "function" && i.name === functionName);
  if (!item) throw new Error(`no function ${functionName} in ABI`);
  const values = item.outputs.length === 1 ? [result] : (result as unknown[]);
  const out: Record<string, unknown> = {};
  item.outputs.forEach((output, i) => {
    out[output.name || String(i)] = values[i];
  });
  return out;
}

export async function mapLimit<I, O>(items: readonly I[], limit: number, fn: (item: I) => Promise<O>): Promise<O[]> {
  const out = new Array<O>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as I);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const REVERT_ERRORS = ["ContractFunctionRevertedError", "ContractFunctionZeroDataError", "ExecutionRevertedError"];

/** Whether an error is the EVM reverting, as opposed to the RPC being unreachable or rate-limited. */
export function isRevert(error: unknown): boolean {
  for (let e = error as { name?: string; cause?: unknown } | undefined, depth = 0; e && depth < 10; depth++) {
    if (typeof e.name === "string" && REVERT_ERRORS.includes(e.name)) return true;
    e = e.cause as typeof e;
  }
  return false;
}

/** A short description of an error that is safe to log: viem's long form includes the RPC URL. */
export function errorText(error: unknown): string {
  const e = error as { shortMessage?: string; message?: string };
  const text = e?.shortMessage ?? e?.message ?? String(error);
  return (text.split("\n")[0] ?? "").replace(/https?:\/\/\S+/g, "<url>").slice(0, 300);
}

export function range(from: bigint, toInclusive: bigint): bigint[] {
  const out: bigint[] = [];
  for (let i = from; i <= toInclusive; i++) out.push(i);
  return out;
}
