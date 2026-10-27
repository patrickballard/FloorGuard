# FloorGuard keeper

The protocol's documentation says in several places that "someone has to call
this promptly". This bot is that someone. It makes the permissionless
maintenance calls that anyone may make, and nothing else. It needs no owner
rights and should never be given any.

**It has not been run against a public network.** Everything below was checked
on a local anvil chain with the mock randomness provider. The contracts
themselves are unaudited; see [SECURITY.md](../SECURITY.md).

## What it does

Each task has its own switch, runs independently of the others, and simulates
every call before sending it.

| Task | Switch | Calls | When |
|---|---|---|---|
| Prediction markets | `KEEPER_TASK_PREDICTION` | `PredictionMarket.resolve` | A pending market is past `resolveTime` and the oracle has a price with `updatedAt >= resolveTime` that is not older than `maxOracleAge`; or one pool is empty; or the three-day grace period is over. Markets still waiting for a price are reported. |
| Points | `KEEPER_TASK_POINTS` | `Points.flushMany` | Accounts with `pendingOf > 0`, found from `PointsCredited` events: once a day, and again from an hour before any open raffle can be drawn. Never while `freezeCount != 0`. |
| Vault raffles | `KEEPER_TASK_VAULT_RAFFLE` | `VaultRaffle.draw`, `resetDraw`, `claim` | `draw` once `drawAfter` and `nextDrawAt` have passed, no draw is in flight, no known account has pending points and `totalPoints` reaches `minPointsToDraw` (or the raffle's own `minPointsRequired`, where the contract scales it with the prize's cost). `resetDraw` a day after an unanswered request. `claim` for a raffle with a winner once its prize has vested (`claimableAt`, 30 days after the draw by default). |
| Lottery | `KEEPER_TASK_LOTTERY` | `Lottery.draw`, `resetDraw`, `abort` | `draw` rounds that have ended; `resetDraw` after a day without randomness; `abort` is opt-in. |
| Ticket raffles | `KEEPER_TASK_TICKET_RAFFLE` | `TicketRaffle.close`, `settle`, `resetDraw`, `abort` | `close` raffles that have ended or sold out; `settle` raffles with a winner; `resetDraw` after a day without randomness; `abort` is opt-in. |
| Games | `KEEPER_TASK_GAMES` | `Games.refund` | A bet's randomness is late by `Games.REFUND_TIMEOUT` (six hours). Open bets are found from `BetPlaced`, `BetSettled` and `BetRefunded` events and read back. |
| Vault | `KEEPER_TASK_VAULT` | `Vault.sampleFloor`, `requestUnlockRound`, `unlock`, `releaseToPlayers`, `startAuction` | Daily: `sampleFloor` for each watched collection whose sample for the day is missing and whose oracle price is fresh; `requestUnlockRound` once a day when a holding could unlock if picked. `unlock` when `canUnlock` is true. `releaseToPlayers` for players' holdings whose 30-day lock has ended. `startAuction` is opt-in. See [The Vault](#the-vault). |
| Monitoring | `KEEPER_TASK_MONITOR` | none | See [Monitoring](#monitoring). |

Three kinds of call are **opt-in and off by default**:

- `KEEPER_LOTTERY_ABORT`, `KEEPER_TICKET_RAFFLE_ABORT`: turn a round or raffle
  that is stuck past its abort time into refunds. Off, the keeper reports it
  (exit code 2) and leaves the decision to a person. Note that `Lottery.draw`
  and `TicketRaffle.close` themselves open refunds once the abort time has
  passed, so the keeper treats them as an abort from then on, and stops
  requesting draws `KEEPER_ABORT_GUARD_SECONDS` (15 minutes) before that moment:
  a draw simulated before the abort time and mined after it would open refunds
  instead. A raffle or round that ended below its minimum is always closed,
  since refunds are its only possible outcome.
- `KEEPER_VAULT_START_AUCTION`: start the Dutch auction of a holding that
  governance has left unlocked for more than the 30-day window.
- `KEEPER_VAULT_RESTART_AUCTION`: restart an oracle-priced auction that has sat
  at its reserve without a buyer for `KEEPER_VAULT_RESTART_DWELL_SECONDS` (three
  days). The contract allows a restart in the first second the price reaches
  the reserve, which would put it back at 16 times the reserve before anyone
  could buy there; the dwell time is the keeper's own rule.

### The Vault

A holding bought by the engine is locked for at least 90 days (`Vault.MIN_LOCK`).
From then on it takes part in a daily random draw, with a chance that rises
with its age (0.5% a day at 90 days, 5% at a year). A holding the draw picks
unlocks only if the collection's 30-day median floor is at least a multiple
of its purchase price (130% at 90 days, falling to 100% at a year), and only
while the collection's weekly release cap (5% of its holdings, at least one)
has room. Every fifth purchase of a collection (`playersShareBps`, 20%) is set
aside for players instead: it is locked for 30 days and then goes to the vault
raffle, never through the draw. Each pass the keeper:

- **Samples the floor.** For every collection it watches (the engine's
  `BidConfigured` events, `KEEPER_COLLECTIONS`, the demo collection, and every
  collection the Vault still holds), it calls `sampleFloor` when
  `lastSampleSlot(collection) <= block.timestamp / 86400` (no sample for the
  day yet) and the Vault's oracle has a non-zero price no older than
  `maxOracleAge`, with a minute of margin. A collection with no fresh price is
  reported (`floor_not_sampled`, info) and skipped. `medianFloor` needs 15
  samples out of the last 30 days before any holding of the collection can
  unlock, so the samples are taken whether or not a holding is due.
- **Requests the day's draw.** `requestUnlockRound` when the Vault has a
  randomness provider, no request is in flight (or the one in flight has timed
  out), a day has passed since the last request, and at least one holding takes
  part (past its lock, not for players) whose collection has a usable median at
  or above the multiple required at the holding's age and room under the
  release cap. Every request costs a randomness fee, so no draw is requested
  that could not unlock anything; anyone else may still request one. Without a
  provider it warns (`no_randomness`).
- **Unlocks what the draw picked.** `unlock` for every holding whose
  `canUnlock` is true, never more per collection than `releaseAllowance`
  allows. The draw's result can be used for a day after it arrives. A picked
  holding that cannot unlock is reported with the reason
  (`picked_below_floor`, `picked_without_median`, `release_cap_reached`);
  holdings waiting to be picked are counted (`waiting_for_draw`).
- **Releases the players' share.** `releaseToPlayers` for a holding with
  `isPlayersHolding` that is still locked and past its `lockedUntil`. The
  raffle it opens is then drawn and, after vesting, claimed by the vault-raffle
  task.

The keeper never answers the draw itself: the random word comes from the
randomness provider.

## What it does not do

- It never calls an owner function, never sends ETH, never buys, bets, bids,
  claims or withdraws for anyone, and never pushes oracle prices.
- It does not `claim` prediction payouts, `withdraw` winnings or `refund`
  lottery and raffle tickets: those pay `msg.sender`, so only the account owed
  can call them.
- It cannot make a market settle on the *first* price after its settlement
  time, only on the price the oracle holds when its transaction is mined. It
  shortens the wait to a poll interval plus inclusion time. A reporter who
  pushes twice in a row, or pushes and resolves in one transaction, is still
  ahead of it.
- It cannot stop someone else calling `VaultRaffle.draw` in the first block
  after the announce period. It flushes points beforehand; points credited
  between its last flush and that draw wait for the next raffle.
- It does not fulfil randomness and cannot see a random word in advance.

## Run it

Requirements: Node 22.18 or later (TypeScript is run directly, with Node's
type stripping), Foundry's build output in `../out` (`forge build` in the
repository root) and a deployment file `../deployments/<chainId>.json` as
written by `script/Deploy.s.sol`. ABIs and addresses are read from those two
places at start-up, the same sources the web app's `sync-contracts.mjs` uses.

```sh
cd keeper
npm install
cp .env.example .env      # set KEEPER_RPC_URL and KEEPER_CHAIN_ID

npm run monitor           # figures only, sends nothing, needs no key
npm run once              # one pass over every enabled task, then exit
npm run watch             # loop until SIGINT or SIGTERM
npm run once -- --dry-run # simulate and report, send nothing
```

Without a key the keeper runs in dry-run mode and says so on both output
channels. A cron line:

```cron
*/5 * * * * cd /opt/floorguard/keeper && npm run -s once >> keeper.jsonl 2>> keeper.log || echo "keeper exit $?" | mail -s keeper ops@example.org
```

`watch` sleeps for `KEEPER_POLL_SECONDS`, or less when a task has a deadline
before then (a `resolveTime`, a `drawAfter`, a round's end, a late bet). While
a market waits for its settlement price it polls every
`KEEPER_FAST_POLL_SECONDS`, and any event emitted by the prediction market's
oracle wakes it at once. For prompt settlement use `watch`; with cron the delay
is the cron interval.

### Output and exit codes

JSON lines go to stdout, one event per line (`config`, `run_start`, `action`,
`finding`, `monitor.collection`, `monitor.games`, `monitor.randomness`,
`monitor.providers`, `monitor.owners`, `task_done`, `run_done`). Amounts are wei
as decimal strings. A summary for people goes to stderr. `KEEPER_LOG_FORMAT`
selects `json`, `text` or `both`.

| Exit | Meaning |
|---|---|
| 0 | Ran. Nothing to report. |
| 1 | Could not start: bad configuration, RPC unreachable, wrong chain id, no code at the deployment's addresses. |
| 2 | Ran, and something needs a person: a market waiting over an hour for a price, a stuck round, a call that was due but not sent (simulation reverted, budget, gas price), a monitoring warning. |
| 3 | A task or a transaction failed, a transaction is still pending, or monitoring found an error-level condition (an owner or randomness provider that is not the expected one, Games holding less than it accounts for). |

`watch` exits 0 on a signal; its findings are in the log.

### Configuration

Environment variables, optionally from `keeper/.env`, optionally on top of a
JSON file named by `KEEPER_CONFIG` (same keys; secrets are refused there).
[.env.example](.env.example) lists every variable with its default. The ones
that matter most:

| Variable | Default | |
|---|---|---|
| `KEEPER_RPC_URL`, `KEEPER_CHAIN_ID` | required | The chain id is checked against the endpoint. |
| `KEEPER_DEPLOYMENT_FILE` | `../deployments/<chainId>.json` | |
| `KEEPER_START_BLOCK` | 0 | The block the protocol was deployed in. The deployment file does not record it, and points and bets are found from logs, so set it on a real chain. |
| `KEEPER_LOG_RANGE` | 5000 | Largest `eth_getLogs` span. Halved automatically when the provider refuses a range. |
| `KEEPER_CACHE_FILE` | none | Last scanned blocks, the day's spend, the last flush. Everything else is re-derived from the chain on every run. |
| `KEEPER_MAX_FEE_GWEI` | 30 | Nothing is sent while base fee plus tip is above it; no fee bump goes past it. |
| `KEEPER_MAX_SPEND_PER_RUN_ETH` / `_PER_DAY_ETH` | 0.05 / 0.2 | Checked against the worst case (gas limit times fee cap) before each send. |
| `KEEPER_POLL_SECONDS` / `KEEPER_FAST_POLL_SECONDS` | 60 / 6 | Watch mode. |
| `KEEPER_FLUSH_MAX_BATCH`, `KEEPER_FLUSH_GAS_PER_ACCOUNT`, `KEEPER_MAX_GAS_PER_TX` | 100, 110000, 3000000 | Size of a `flushMany` batch. A batch whose estimate is still too high is split in two. |
| `KEEPER_TASK_<NAME>` | true | One switch per task. |

The daily budget is kept in the cache file. Without one it only holds within a
single process, which is enough for `watch` and not for cron: set
`KEEPER_CACHE_FILE` when running from cron.

### The key

The key is read from `KEEPER_PRIVATE_KEY`, or from an encrypted keystore
(`KEEPER_KEYSTORE`, Web3 Secret Storage v3 as written by `cast wallet import`)
with its password in `KEEPER_KEYSTORE_PASSWORD` or
`KEEPER_KEYSTORE_PASSWORD_FILE`. It is turned into a signer at start-up, removed
from the process environment, never stored on the configuration object and
never logged; the RPC URL is logged without its path and query, since those
often carry an API key.

Use a fresh key that owns nothing, and fund it with gas money only. The
monitoring task warns if the keeper's key is the owner of any contract.

## Safe by construction

- **One allowlist.** [src/allowlist.ts](src/allowlist.ts) lists the eighteen
  calls above by contract and full signature. ABIs read from disk are checked
  against it at start-up and refused if a listed function is missing, has other
  arguments or is payable. Every action is encoded through it, and the bytes
  about to be signed are checked once more (`assertSendable`): the target must
  be one of the seven contracts, the selector must be listed for that contract,
  and the value must be zero. `test/allowlist.test.ts` pins the selectors and
  checks that every other function of the seven contracts is refused.
- **No value, ever.** There is no parameter through which a value could be
  passed; the sender writes `value: 0n` itself.
- **Simulation first.** Every send is preceded by an `eth_call` of the exact
  bytes from the keeper's address, then `eth_estimateGas`. A reverting
  simulation is reported with the name of the custom error and nothing is sent.
- **Budgets.** Gas price ceiling, gas limit per transaction, transactions per
  run, spend per run and per day, and a balance check.
- **Nonces and replacement.** Nonces are counted locally from the mined count,
  so a transaction left in the mempool by an earlier run is replaced by whatever
  the current state calls for instead of being queued behind. A transaction not
  mined within `KEEPER_TX_TIMEOUT_SECONDS` is resent on the same nonce with
  12.5% more, at most `KEEPER_MAX_REPLACEMENTS` times and never above the
  ceiling; after that the run stops sending and reports it as pending.
- **Idempotent.** Decisions are pure functions of state read from the chain at
  one block. A restart, a second instance, or someone else making the same call
  first costs at worst one reverted transaction, and usually nothing, because
  the simulation fails first.
- **The chain's clock.** Every deadline is compared with the latest block's
  timestamp, not the machine's.

Run one instance per key. Two keepers with different keys are harmless: the
slower one's simulation reverts.

## Monitoring

`npm run monitor` (or the monitor task in every pass) prints, per collection
with a configured bid, the figures the economics review asks a deployer to
watch (end of section 1.6 of
[ECONOMICS-REVIEW.md](../docs/ECONOMICS-REVIEW.md)), as far as they can be read
from the chain:

- budget, curve price, current bid, whether the bid is limited by the budget,
  whether it is below `minBidOf`;
- the budget in units of the bid (`budget / curvePrice`; above 3 the curve is
  too slow for the inflow);
- time since the last fill, `maxPrice` against the base price, whether the
  curve has reached `maxPrice`;
- the sales-oracle and push-oracle floors where they exist, and the bid and
  `maxPrice` against them.

It does not know the lowest outside ask, the 30-day fee inflow or the seller
concentration of buybacks, so it cannot compute `rho` or `currentBid / lowest
outside ask`; those need off-chain data.

Also:

- **Games**: bankroll, reserved funds and their share of house funds against
  the 20% cap, the largest allowed wager and exposure, and whether the contract
  holds at least what it accounts for.
- **Randomness**: every draw and bet waiting for randomness and for how long;
  `randomness()` of the five consumers (the Vault, the vault raffle, Games,
  ticket raffles and the lottery) against the expected provider; on a public
  chain, whether that provider answers like `ChainlinkVRFRandomness` for that
  consumer (a `MockRandomness` there is an error). The Vault is checked only
  when the deployment file has `vaultRandomness` or
  `KEEPER_EXPECTED_RANDOMNESS_VAULT` is set: deployments made before it had its
  own unlock draw have no such adapter.
- **Ownership**: `owner()` of thirteen contracts against the expected owner
  and against the last run; pending two-step transfers.
- Unlocked holdings and auctions at their reserve (a lump of budget is coming),
  whether the prediction market settles on the sales oracle, and the keeper's
  own balance.

## What each call costs

Gas used, measured on anvil (solc 0.8.28, optimizer at 200 runs, contracts of
the `moving-lock` branch on 2026-10-14) by `test/integration.test.ts`, which prints this table at the
end of a run. The draws include a request to `MockRandomness`, which is two
storage writes; a Chainlink VRF request costs more.

| Call | Gas used |
|---|---|
| `PredictionMarket.resolve` | 65,883 with a price; 62,950 into void |
| `Points.flushMany` | 67,281 for one account that already has points; 81,858 for two; 146,538 for two of which one is new; 326,142 for the first two accounts ever (the sum tree is initialised once) |
| `VaultRaffle.draw` | 144,873 |
| `VaultRaffle.resetDraw` | 39,119 |
| `VaultRaffle.claim` | 53,849 |
| `Lottery.draw` | 132,669 the first time, 115,569 after a reset |
| `Lottery.resetDraw` | 32,516 |
| `Lottery.abort` | 33,021 |
| `TicketRaffle.close` | 129,943 the first time, 112,843 after a reset; 32,837 into refunds |
| `TicketRaffle.settle` | 131,881 |
| `TicketRaffle.resetDraw` | 30,936 |
| `TicketRaffle.abort` | 31,318 |
| `Games.refund` | 116,915 the first time, 91,795 after |
| `Vault.sampleFloor` | 123,461 for a collection's first sample, 89,000 to 93,000 after; 177,000 to 213,000 for the first sample after a draw request, which records the median as it stood then |
| `Vault.requestUnlockRound` | 124,242 the first time, 75,752 after |
| `Vault.unlock` | 219,928 (the median sorts up to 30 samples) |
| `Vault.releaseToPlayers` | 185,974, including opening the raffle |
| `Vault.startAuction` | 120,592 to start, 81,244 to restart |

Activating a new account costs roughly 80,000 to 90,000 gas and a returning one
about 15,000 on top of the first. Anyone can make the keeper pay for an
activation by earning a dust amount of points with a fresh address; they pay a
trade's gas to do it. `KEEPER_FLUSH_MIN_PENDING` and the daily budget bound
that.

Reads: one pass makes a few dozen `eth_call`s plus a handful per open market,
raffle, round, bet and vault holding, plus four per watched collection for the
floor samples, batched over HTTP, and scans new blocks for three event
streams. Locked holdings are re-read on every pass.

The Vault's daily routine costs, per collection, one `sampleFloor` a day, and
one `requestUnlockRound` a day for the whole Vault while any holding could
unlock (plus the provider's fee on a public chain).

## Trust

Running the keeper requires trusting it with nothing but its own gas money.
Every call it makes is one that any address may make, so a keeper has no power
over the protocol that the rest of the world lacks, and whoever runs it does
not need to be trusted by users.

What a malicious or modified keeper **could not** do: move, freeze or redirect
funds; change a fee, an oracle, a randomness provider or an owner; pick a
winner, an outcome or a price; see a random word in advance; stop anyone else
making the same calls.

What it **could** do is what any address can already do, namely choose its
timing:

- **Wait.** Not resolving, not drawing, not flushing. Anyone else can step in,
  but if nobody does, a market settles on a later price, or voids after three
  days; points stay unactivated; bets and draws stay open until someone calls.
- **Resolve at a moment it prefers.** `resolve` uses the oracle's price at that
  moment. A keeper that also bets could hold back while a later price would
  suit it better. This is the risk the keeper exists to remove, so it only
  works if the keeper is run by someone with no position, or by more than one
  party.
- **Draw without flushing, or after flushing only some accounts.** `draw`
  closes activation for everyone else, which shifts raffle odds towards the
  accounts already activated.
- **Abort instead of waiting.** Once a round or raffle is past its abort time,
  refunds can be opened. For a ticket raffle with a drawn winner that nobody
  settled for a week, an abort takes the prize back from the winner.
- **Restart an auction the moment it reaches its reserve**, so that nobody can
  buy at the reserve.
- **Unlock at a chosen moment.** A picked holding can be unlocked at any time
  in the day its draw's result lasts, or not at all; the median floor recorded
  at `unlock` sets a lower bound on later auction openings. With several picked
  holdings and a release cap, whoever calls first chooses which ones unlock.
- **Sample the floor at a chosen moment of the day**, or skip a day. One sample
  out of up to thirty moves the median little, and anyone else can take the
  day's sample first.
- **Request the draw, or not.** It cannot choose the random word, but not
  requesting a round delays every unlock by a day.

None of these needs the keeper's key. They are properties of the contracts;
the keeper's defaults (flush before draw, resolve at once, report instead of
abort, dwell before restart) are the benign choice in each case.

If the keeper's key leaks, the thief gets the keeper's ETH balance and nothing
else. Keep the balance small.

## Limits

- Not run against a public network, a real RPC provider's log limits, a real
  mempool or Chainlink VRF. The replacement logic was exercised on anvil with
  mining paused, and against a scripted node in unit tests.
- No reorg handling beyond re-reading the last 64 blocks of each log stream
  and re-deriving all state from the chain on every pass.
- The log scans start at `KEEPER_START_BLOCK`. With the default of 0 on a long
  chain the first run is slow.
- One RPC endpoint, no failover. In `watch` mode a failing endpoint is retried
  with a backoff; in `once` mode it is exit code 1 or 3.
- The ABIs are read from `../out`, so the keeper has to be restarted after the
  contracts are rebuilt, and refuses to start if a listed function changed.

## Tests

```sh
npm run typecheck
npm test
```

Unit tests cover the decision logic of every task (pure functions over fetched
state), the allowlist, the sender against a scripted node (simulation, budgets,
nonces, replacement), configuration and key handling, the cache and the log
scanner.

`test/integration.test.ts` runs against anvil and is skipped when anvil is not
listening on port 8547:

```sh
anvil --port 8547     # in another terminal
npm test
```

It snapshots the chain, deploys with `script/Deploy.s.sol` (which rewrites
`deployments/31337.json`; the test restores the previous content), seeds the
protocol with players other than the owner, and plays about six months of
chain time with the keeper signing as anvil account #1, which owns nothing. The
owner-only steps (oracle prices, `sendToRaffle`, `governanceUnlock`) and the
mock randomness `fulfill` are done by the test. For the Vault it trades every
other day to keep the sales oracle fresh while the keeper samples the floor
daily, answers the unlock draw first with a word that misses the holding and
the next day with one that picks it (`keccak256(abi.encode(word, vaultId)) %
10000 < drawChanceBps(age)`), and checks that the keeper unlocks it, releases
the fifth purchase to the players' raffle after 30 days, and claims the raffle
prize only once it has vested. It reverts to the snapshot at
the end.
