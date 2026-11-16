// Token Radar's scoring model, radar-2 — written as a pipeline.
//
// A snapshot goes through four stages: pick the protocols the board may rank,
// score each one from the snapshot's own figures, order them by implied value,
// and lay the rows out in the shape board.json carries. The farm plan is built
// from the same record in the same pass. Nothing here looks at a protocol's
// name except the eligibility rules the house published; the same arithmetic
// scores every row, and the dashboard prints the formula with the constants
// it ran on.
//
// The value model, radar-2:
//
//   base      = tvl_usd x 0.25
//   growth    = clamp(change_7d, -60, 120) per cent, 0 when unreported
//   growth x  = 1 + (growth / 100) x 0.5
//   maturity  = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age unknown: 365 days)
//   chain x   = 0.85 + 0.03 x min(chains, 5)
//   implied   = max(1, round(base x growth x maturity x chain x))
//
// TVL is what a launch would be priced against; seven-day growth is the
// momentum the snapshot records; age is how long the protocol has run with
// no token on record; chain breadth is how many chains its TVL sits on.
// The field order of a board row is load-bearing: board.json is written by
// JSON.stringify, so a field moved here moves the bytes.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_floor: number;
  chain_step: number;
  chain_cap: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.25,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  chain_floor: 0.85,
  chain_step: 0.03,
  chain_cap: 5,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with the farm plan generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
  /** Implied dollars per dollar of TVL: how hard each locked dollar works in the model. */
  value_density: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist: string[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Four decimals, for the multipliers the board and the page both print. */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Whole days from `listedAt` to `asOf`, never negative; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const listedMs = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(listedMs)) return null;
  return Math.max(0, Math.floor((asOfMs - listedMs) / DAY_MS));
}

/** Clamp `v` into [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The seven-day growth the model prices, clamped to the model's window, 0 when unreported. */
function growthPctOf(p: SnapshotProtocol, model: ModelConstants): number {
  return clamp(finiteOr(p.change_7d, 0), model.growth_floor, model.growth_cap);
}

/** The growth factor: 1 plus the clamped weekly change, half-weighted. */
function growthFactor(pct: number, model: ModelConstants): number {
  return 1 + (pct / 100) * model.growth_weight;
}

/** The maturity factor: a protocol that has run longer with no token counts for more, up to the cap. */
function maturityFactor(age: number | null, model: ModelConstants): number {
  const days = clamp(age ?? model.unknown_age_days, 0, model.maturity_days);
  return model.maturity_floor + (days / model.maturity_days) * model.maturity_range;
}

/** The chain factor: each chain up to the cap adds a step to the base. */
function chainFactor(nChains: number, model: ModelConstants): number {
  return model.chain_floor + model.chain_step * Math.min(nChains, model.chain_cap);
}

/** The four factors and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; chainMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = growthPctOf(protocol, model);
  const growthMult = growthFactor(growthPct, model);
  const maturityMult = maturityFactor(age, model);
  const chainMult = chainFactor(protocol.chains.length, model);
  const base = protocol.tvl_usd * model.base_multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * chainMult));
  return { implied, growthPct, growthMult, maturityMult, chainMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/**
 * The categories the house's watchlist rule keeps out: a wrapped, staked or bridged product of a
 * token that already trades, or an exchange. 'Cross Chain Bridge' is a bridge and 'Stablecoin
 * Wrapper' is a wrapper under other words, so they are kept out by the same rule.
 */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Cross Chain Bridge', 'Stablecoin Wrapper', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** The exchange names the house's watchlist rule keeps out, when a protocol's name begins with one. */
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a protocol's name carries a whole word wrapped, staked or staking, in any case. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool,
 * and not a wrapped, staked or bridged product of a token that already trades. The rule is the
 * house's watchlist rule without the TVL floor, so the board's early rows are judged by the same
 * definition as its watchlist rows.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_NAMES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

/** Stage 1 — pick the pool: the whole watchlist first, then every other rankable protocol. */
function pickPool(snapshot: Snapshot): SnapshotProtocol[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const pool = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but
  // the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) pool.set(slug, p);
  }
  // The early radar: every other rankable protocol below the watchlist floor. No cap, no hand-pick:
  // the radar exists to find these, and the whole set is small enough to rank in full.
  for (const p of snapshot.protocols) {
    if (!pool.has(p.slug) && isRankable(p)) pool.set(p.slug, p);
  }
  return [...pool.values()];
}

/** Stage 2 — score every protocol in the pool. */
function scorePool(pool: SnapshotProtocol[], snapshot: Snapshot, model: ModelConstants) {
  return pool.map((p) => {
    const s = impliedValue(p, snapshot.as_of, model);
    return { protocol: p, ...s };
  });
}

/** Stage 3 — order by implied value, strongest first; a tie falls to the slug, so the order is stable. */
function orderByValue<T extends { implied: number; protocol: SnapshotProtocol }>(scored: T[]): T[] {
  return scored.sort((a, b) => b.implied - a.implied || (a.protocol.slug < b.protocol.slug ? -1 : a.protocol.slug > b.protocol.slug ? 1 : 0));
}

/** Stage 4 — lay one scored protocol out as a board row, in the field order board.json carries. */
function toBoardRow(s: { protocol: SnapshotProtocol; implied: number; growthPct: number; growthMult: number; maturityMult: number; chainMult: number; age: number | null }, rank: number, model: ModelConstants): BoardRow {
  const p = s.protocol;
  return {
    rank,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    gecko_id: p.gecko_id,
    symbol: p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_multiple: model.base_multiple,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      chain_multiplier: round4(s.chainMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(p, s.age).map(stepText),
  };
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const scored = orderByValue(scorePool(pickPool(snapshot), snapshot, model));
  return scored.map((s, i) => toBoardRow(s, i + 1, model));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function primaryChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function stakeSize(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdWindow(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * The position's action, as a rule table, first match wins. The table is read top to bottom, so a
 * category that matches two rules takes the earlier one: lending before DEXes, bridges before
 * chains, and the catch-all deposit last. Each rule reads only the lowercased category.
 */
interface FarmRule {
  matches: (category: string) => boolean;
  write: (name: string, capital: number, chain: string) => string;
}

const FARM_RULES: FarmRule[] = [
  { matches: (c) => c.includes('lend') || c.includes('cdp') || c.includes('collateral'), write: (n, k, ch) => `Supply $${k} of USDC to ${n} on ${ch} and keep the position open.` },
  { matches: (c) => c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c.includes('liquidity manager') || c.includes('farm'), write: (n, k, ch) => `Provide $${k} of liquidity to ${n}'s main pool on ${ch} and keep the position open.` },
  { matches: (c) => c.includes('bridge') || c.includes('cross chain'), write: (n, k, ch) => `Bridge $${k} of USDC to ${ch} through ${n} and use the bridged funds in its app.` },
  { matches: (c) => c.includes('staking') || c.includes('restak') || c.includes('staking pool'), write: (n, k, ch) => `Stake $${k} of the chain's staking asset through ${n} and keep the receipt.` },
  { matches: (c) => c.includes('perpetual') || c.includes('derivative') || c.includes('basis trading') || c.includes('interest rate'), write: (n, k, ch) => `Deposit $${k} of USDC as margin on ${n} and open one small hedge.` },
  { matches: (c) => c.includes('prediction'), write: (n, k, ch) => `Fund $${k} and place one market position on ${n}.` },
  { matches: (c) => c.includes('curator') || c.includes('allocator') || c.includes('governance incentives'), write: (n, k, ch) => `Deposit $${k} into a ${n} vault on ${ch} and keep the shares.` },
  { matches: (c) => c.includes('stable'), write: (n, k, ch) => `Mint or deposit $${k} of the stable asset through ${n} on ${ch}.` },
  { matches: (c) => c.includes('rwa'), write: (n, k, ch) => `Mint $${k} of the protocol's yield asset on ${ch} and hold it.` },
  { matches: (c) => c.includes('insurance'), write: (n, k, ch) => `Buy $${k} of cover from ${n} on ${ch} and keep the policy.` },
  { matches: (c) => c.includes('chain') && !c.includes('cross'), write: (n, k, ch) => `Bridge $${k} of USDC to ${n} and use it in the chain's flagship app.` },
  { matches: (c) => c.includes('btc'), write: (n, k, ch) => `Mint $${k} of the BTC-backed asset through ${n} on ${ch} and hold it.` },
  { matches: (c) => c.includes('otc'), write: (n, k, ch) => `Fill one small order on ${n}'s OTC market on ${ch} and keep the receipt.` },
  { matches: (c) => c.includes('payment'), write: (n, k, ch) => `Pay $${k} through ${n} on ${ch} and keep the receipt.` },
  { matches: (c) => c.includes('card'), write: (n, k, ch) => `Load $${k} onto the ${n} card and spend it once.` },
  { matches: (c) => c.includes('index'), write: (n, k, ch) => `Buy $${k} of the ${n} index on ${ch} and hold the shares.` },
];

/** The position itself, from the first matching rule, or the catch-all deposit. */
function positionAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const category = (p.category ?? '').toLowerCase();
  for (const rule of FARM_RULES) {
    if (rule.matches(category)) return rule.write(p.name, capital, chain);
  }
  return `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of
 * names. The second step is the position itself; the third deepens the footprint with a different
 * feature; the rest are the weekly rhythm, the hold, the claim check and the log.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = primaryChain(p);
  const capital = stakeSize(p);
  const hold = holdWindow(age);
  const gas = capital >= 150 ? 8 : 4;
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: positionAction(p, capital, chain),
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Use a second feature of the protocol, such as a swap, a borrow, a vote or a second deposit, so the wallet's footprint is more than one action.`,
      cost: 'about $3 of gas',
      time: '10 minutes',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
    value_density: row.tvl_usd > 0 ? round4(row.implied_value_usd / row.tvl_usd) : 0,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist: snapshot.watchlist,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !watchlist.has(r.slug)).length,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** One protocol out of the snapshot's raw record, with the fields the model reads. */
function readProtocol(v: unknown, i: number): SnapshotProtocol {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
  const p = v as Record<string, unknown>;
  if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
    throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
  }
  const textOrNull = (x: unknown): string | null => (typeof x === 'string' ? x : null);
  const numOrNull = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  return {
    slug: p.slug,
    name: p.name,
    category: textOrNull(p.category),
    chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
    tvl_usd: p.tvl_usd,
    change_7d: numOrNull(p.change_7d),
    mcap_usd: numOrNull(p.mcap_usd),
    listed_at: textOrNull(p.listed_at),
    gecko_id: textOrNull(p.gecko_id),
    symbol: textOrNull(p.symbol),
  };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols: o.protocols.map((v, i) => readProtocol(v, i)),
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
