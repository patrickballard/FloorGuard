// The flywheel as a system diagram: fees flow in from trading and games, pool in a per-collection
// budget, fuel the rising bid, a holder sells into it, the token locks in the vault and leaves by
// auction (proceeds back to the budget) or raffle. One component, three layouts; the landing page
// drives it with its explainer model, the overview with the protocol's real numbers.
//
// Value only moves when something happened: `emit` sends one particle along one flow. There is no
// ambient traffic, so the diagram never suggests activity that did not take place.
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, type KeyboardEvent } from "react";
import { clamp, easeInOut, pageHidden, prefersReducedMotion } from "./motion";

export type FlyNode = "trading" | "games" | "more" | "budget" | "bid" | "holder" | "vault" | "auction" | "raffle";
export type FlyFlow = "trade" | "games" | "more" | "fuel" | "pay" | "deposit" | "toAuction" | "proceeds" | "toRaffle";
export type FlyLayout = "wide" | "tall" | "strip";

export type FlyTile = { key: string; state: "locked" | "unlocked" | "auction" };

export type FlyData = {
  /** ETH in the collection's buyback budget. */
  budget: number;
  /** What a seller is paid: the curve, or the budget when it holds less. */
  bid: number;
  /** Where the bid curve stands, whatever the budget can pay. */
  curve: number;
  bidBase: number;
  bidCap: number;
  /** No buyback below this. */
  minBid?: number;
  /** What the vault holds now (released holdings are not in it). */
  tiles: FlyTile[];
  /** A holding on auction, if any: where its price is between its opening price and its reserve. */
  auction?: { price: number; reserve: number; progress: number };
  /** Number formatting for ETH amounts. */
  digits?: number;
};

export type FlyHandle = {
  /** Send one particle of value (ETH) or one token (NFT) along a flow, with an optional label on arrival. */
  emit: (flow: FlyFlow, kind?: "eth" | "nft", label?: string) => void;
};

type Rect = { x: number; y: number; w: number; h: number };
type Side = "l" | "r" | "t" | "b";
type Anchor = [FlyNode, Side, number?];
type LayoutSpec = { width: number; height: number; nodes: Record<FlyNode, Rect>; flows: Record<FlyFlow, [Anchor, Anchor]>; small: boolean };

const LAYOUTS: Record<FlyLayout, LayoutSpec> = {
  wide: {
    width: 760,
    height: 560,
    small: false,
    nodes: {
      trading: { x: 16, y: 34, w: 190, h: 64 },
      games: { x: 16, y: 116, w: 190, h: 64 },
      more: { x: 16, y: 198, w: 190, h: 64 },
      budget: { x: 262, y: 44, w: 138, h: 208 },
      bid: { x: 478, y: 34, w: 266, h: 150 },
      holder: { x: 560, y: 228, w: 184, h: 56 },
      vault: { x: 520, y: 330, w: 224, h: 150 },
      auction: { x: 240, y: 346, w: 244, h: 134 },
      raffle: { x: 560, y: 504, w: 184, h: 46 },
    },
    flows: {
      trade: [["trading", "r"], ["budget", "l", 0.22]],
      games: [["games", "r"], ["budget", "l", 0.5]],
      more: [["more", "r"], ["budget", "l", 0.78]],
      fuel: [["budget", "r", 0.3], ["bid", "l", 0.55]],
      pay: [["bid", "b", 0.66], ["holder", "t"]],
      deposit: [["holder", "b"], ["vault", "t", 0.6]],
      toAuction: [["vault", "l"], ["auction", "r"]],
      proceeds: [["auction", "t", 0.45], ["budget", "b"]],
      toRaffle: [["vault", "b", 0.6], ["raffle", "t"]],
    },
  },
  strip: {
    width: 1100,
    height: 300,
    small: false,
    nodes: {
      trading: { x: 10, y: 18, w: 190, h: 58 },
      games: { x: 10, y: 92, w: 190, h: 58 },
      more: { x: 10, y: 166, w: 190, h: 58 },
      budget: { x: 240, y: 26, w: 150, h: 196 },
      bid: { x: 460, y: 18, w: 240, h: 136 },
      holder: { x: 762, y: 46, w: 112, h: 80 },
      vault: { x: 932, y: 18, w: 158, h: 136 },
      auction: { x: 520, y: 198, w: 244, h: 92 },
      raffle: { x: 932, y: 226, w: 158, h: 56 },
    },
    flows: {
      trade: [["trading", "r"], ["budget", "l", 0.2]],
      games: [["games", "r"], ["budget", "l", 0.5]],
      more: [["more", "r"], ["budget", "l", 0.8]],
      fuel: [["budget", "r", 0.32], ["bid", "l", 0.5]],
      pay: [["bid", "r", 0.5], ["holder", "l"]],
      deposit: [["holder", "r"], ["vault", "l", 0.5]],
      toAuction: [["vault", "b", 0.25], ["auction", "r"]],
      proceeds: [["auction", "l"], ["budget", "b"]],
      toRaffle: [["vault", "b", 0.7], ["raffle", "t", 0.7]],
    },
  },
  tall: {
    width: 360,
    height: 388,
    small: true,
    nodes: {
      trading: { x: 6, y: 6, w: 110, h: 46 },
      games: { x: 125, y: 6, w: 110, h: 46 },
      more: { x: 244, y: 6, w: 110, h: 46 },
      budget: { x: 6, y: 88, w: 112, h: 118 },
      bid: { x: 152, y: 88, w: 202, h: 104 },
      holder: { x: 214, y: 212, w: 140, h: 36 },
      vault: { x: 190, y: 272, w: 164, h: 108 },
      auction: { x: 6, y: 240, w: 150, h: 88 },
      raffle: { x: 6, y: 346, w: 150, h: 34 },
    },
    flows: {
      trade: [["trading", "b", 0.4], ["budget", "t", 0.3]],
      games: [["games", "b", 0.3], ["budget", "t", 0.56]],
      more: [["more", "b", 0.3], ["budget", "t", 0.8]],
      fuel: [["budget", "r", 0.3], ["bid", "l", 0.5]],
      pay: [["bid", "b", 0.7], ["holder", "t", 0.56]],
      deposit: [["holder", "b", 0.56], ["vault", "t", 0.62]],
      toAuction: [["vault", "l", 0.3], ["auction", "r", 0.6]],
      proceeds: [["auction", "t", 0.4], ["budget", "b", 0.5]],
      toRaffle: [["vault", "l", 0.8], ["raffle", "r"]],
    },
  },
};

const NORMAL: Record<Side, [number, number]> = { l: [-1, 0], r: [1, 0], t: [0, -1], b: [0, 1] };

function anchorPoint(nodes: Record<FlyNode, Rect>, [node, side, frac = 0.5]: Anchor): [number, number] {
  const r = nodes[node];
  if (side === "l") return [r.x, r.y + r.h * frac];
  if (side === "r") return [r.x + r.w, r.y + r.h * frac];
  if (side === "t") return [r.x + r.w * frac, r.y];
  return [r.x + r.w * frac, r.y + r.h];
}

/** A cubic from one node's edge to another's, leaving and arriving square to the edges. */
export function flowPath(spec: LayoutSpec, flow: FlyFlow): string {
  const [from, to] = spec.flows[flow];
  const [x0, y0] = anchorPoint(spec.nodes, from);
  const [x1, y1] = anchorPoint(spec.nodes, to);
  const reach = Math.max(18, Math.hypot(x1 - x0, y1 - y0) * 0.42);
  const [nx0, ny0] = NORMAL[from[1]];
  const [nx1, ny1] = NORMAL[to[1]];
  return `M${x0},${y0} C${x0 + nx0 * reach},${y0 + ny0 * reach} ${x1 + nx1 * reach},${y1 + ny1 * reach} ${x1},${y1}`;
}

const FLOW_TARGET: Record<FlyFlow, FlyNode> = { trade: "budget", games: "budget", more: "budget", fuel: "bid", pay: "holder", deposit: "vault", toAuction: "auction", proceeds: "budget", toRaffle: "raffle" };
const FLOW_KIND: Record<FlyFlow, "eth" | "nft"> = { trade: "eth", games: "eth", more: "eth", fuel: "eth", pay: "eth", deposit: "nft", toAuction: "nft", proceeds: "eth", toRaffle: "nft" };

const SOURCE_TEXT: Record<"trading" | "games" | "more", { title: string; sub: string; short: string }> = {
  trading: { title: "Trading", sub: "2% of every sale", short: "2% of sales" },
  games: { title: "Games", sub: "half of the 2% edge", short: "½ of 2% edge" },
  more: { title: "Pots, bets, licences", sub: "5% of pots · 3% of winnings", short: "5% · 3%" },
};

const NODE_LABEL: Record<FlyNode, string> = {
  trading: "Trading: the 2% fee on every sale becomes budget, less any project share",
  games: "Games: half of the 2% edge on every wager becomes budget; the bankroll keeps the other half",
  more: "Lottery and raffle pots pay 5%, prediction winnings 3%, licences their price",
  budget: "The collection's buyback budget",
  bid: "The rising bid",
  holder: "A holder sells into the bid",
  vault: "The vault",
  auction: "The Dutch auction",
  raffle: "The vault raffle",
};

type Particle = { el: SVGElement; path: SVGPathElement; length: number; start: number; duration: number; flow: FlyFlow; label?: string };

export const Flywheel = forwardRef<
  FlyHandle,
  {
    layout: FlyLayout;
    data: FlyData;
    /** Nodes to bring forward; the rest recede. Undefined: everything is lit. */
    focus?: readonly FlyNode[];
    focusFlows?: readonly FlyFlow[];
    /** Makes nodes operable (click, Enter, Space). */
    onNode?: (node: FlyNode) => void;
    /** Which nodes are operable when `onNode` is set, and what pressing them does. */
    actions?: Partial<Record<FlyNode, string>>;
    label: string;
  }
>(function Flywheel({ layout, data, focus, focusFlows, onNode, actions, label }, handle) {
  const spec = LAYOUTS[layout];
  const svg = useRef<SVGSVGElement>(null);
  const layer = useRef<SVGGElement>(null);
  const particles = useRef<Particle[]>([]);
  const frame = useRef(0);
  const digits = data.digits ?? 3;
  const paths = useMemo(() => (Object.keys(spec.flows) as FlyFlow[]).map((flow) => [flow, flowPath(spec, flow)] as const), [spec]);

  const hit = (flow: FlyFlow, labelText?: string) => {
    const root = svg.current;
    if (!root) return;
    const node = root.querySelector<SVGGElement>(`[data-node="${FLOW_TARGET[flow]}"]`);
    if (node) {
      node.classList.remove("hit");
      // restart the CSS animation
      void node.getBoundingClientRect();
      node.classList.add("hit");
    }
    if (labelText && layer.current) {
      const r = spec.nodes[FLOW_TARGET[flow]];
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", String(r.x + r.w / 2));
      text.setAttribute("y", String(r.y - 6));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("class", `fly-pop ${FLOW_KIND[flow]}`);
      text.textContent = labelText;
      layer.current.appendChild(text);
      setTimeout(() => text.remove(), 1_700);
    }
  };

  const step = (now: number) => {
    const alive: Particle[] = [];
    for (const p of particles.current) {
      const k = clamp((now - p.start) / p.duration);
      if (k < 0) {
        alive.push(p);
        continue;
      }
      const point = p.path.getPointAtLength(p.length * easeInOut(k));
      p.el.setAttribute("transform", `translate(${point.x.toFixed(1)},${point.y.toFixed(1)})`);
      p.el.style.opacity = k < 0.1 ? String(k * 10) : k > 0.92 ? String((1 - k) * 12.5) : "1";
      if (k >= 1) {
        p.el.remove();
        hit(p.flow, p.label);
      } else alive.push(p);
    }
    particles.current = alive;
    frame.current = alive.length ? requestAnimationFrame(step) : 0;
  };

  useImperativeHandle(handle, () => ({
    emit(flow, kind = FLOW_KIND[flow], labelText) {
      const root = svg.current;
      const path = root?.querySelector<SVGPathElement>(`[data-flow="${flow}"] .fly-path`);
      if (!root || !path || !layer.current) return;
      const line = path.parentElement!;
      line.classList.remove("flash");
      void line.getBoundingClientRect();
      line.classList.add("flash");
      if (prefersReducedMotion() || pageHidden()) {
        hit(flow, labelText);
        return;
      }
      const el = document.createElementNS("http://www.w3.org/2000/svg", "g");
      el.setAttribute("class", `fly-p ${kind}`);
      el.innerHTML = kind === "eth" ? '<circle r="9" class="halo"/><circle r="4.200" class="core"/>' : '<rect x="-7" y="-7" width="14" height="14" rx="3.500" class="halo"/><rect x="-5" y="-5" width="10" height="10" rx="2.500" class="core"/>';
      el.style.opacity = "0";
      layer.current.appendChild(el);
      const length = path.getTotalLength();
      particles.current.push({ el, path, length, start: performance.now(), duration: clamp(length * 4.2, 620, 1_500), flow, label: labelText });
      if (!frame.current) frame.current = requestAnimationFrame(step);
    },
  }));

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      particles.current.forEach((p) => p.el.remove());
      particles.current = [];
      frame.current = 0;
    },
    [layout],
  );

  const lit = (node: FlyNode) => !focus || focus.includes(node);
  const flowLit = (flow: FlyFlow) => !focus || (focusFlows ?? []).includes(flow);
  const nodeProps = (node: FlyNode) => {
    const action = onNode && actions?.[node];
    const r = spec.nodes[node];
    return {
      "data-node": node,
      className: `fly-node fly-${node}${lit(node) ? "" : " dim"}${action ? " can-press" : ""}`,
      transform: `translate(${r.x},${r.y})`,
      ...(action
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": action,
            onClick: () => onNode!(node),
            onKeyDown: (event: KeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onNode!(node);
              }
            },
          }
        : { "aria-label": NODE_LABEL[node] }),
    };
  };
  const frameOf = (node: FlyNode) => {
    const r = spec.nodes[node];
    return <rect className="fly-frame" width={r.w} height={r.h} rx={spec.small ? 9 : 12} />;
  };
  const fs = spec.small ? { cap: 8.5, title: 11.5, value: 15, sub: 9.5 } : { cap: 10.5, title: 14, value: 21, sub: 11.5 };
  const pad = spec.small ? 9 : 14;
  const n = spec.nodes;

  // budget tank: the level saturates, so it always has room to rise
  const level = data.bid > 0 ? data.budget / (data.budget + 3 * data.bid) : 0;
  const tank = { x: pad, y: pad + fs.cap + 8, w: n.budget.w - 2 * pad, h: n.budget.h - (pad + fs.cap + 8) - (pad + fs.value + fs.sub + 10) };
  const liquid = tank.h * clamp(level, 0.04, 1);

  // bid mini chart
  const chart = { x: pad, y: pad + fs.cap + fs.value + 14, w: n.bid.w - 2 * pad, h: n.bid.h - (pad + fs.cap + fs.value + 14) - pad };
  const bidK = data.bidCap > data.bidBase ? clamp((data.curve - data.bidBase) / (data.bidCap - data.bidBase)) : 1;
  const limited = data.budget < data.curve;
  const bx = chart.x + chart.w * (0.08 + 0.84 * bidK);
  const by = chart.y + chart.h - chart.h * (0.08 + 0.8 * bidK);
  const base = { x: chart.x + chart.w * 0.08, y: chart.y + chart.h * 0.92 };
  const cap = { x: chart.x + chart.w * 0.92, y: chart.y + chart.h * 0.12 };

  // vault slots
  const cols = spec.small ? 5 : layout === "strip" ? 4 : 6;
  const slot = Math.min(spec.small ? 20 : 26, (n.vault.w - 2 * pad - (cols - 1) * 5) / cols);
  const tiles = data.tiles.slice(0, cols * 2);
  const more = data.tiles.length - tiles.length;

  // auction mini curve: sixteen times the reserve, halving four times
  const ac = { x: pad, y: pad + fs.cap + 10, w: n.auction.w - 2 * pad, h: n.auction.h - (pad + fs.cap + 10) - (pad + fs.sub + 6) };
  const ay = (k: number) => ac.y + ac.h * (1 - 2 ** (-4 * k)) * (16 / 15);
  const curve = Array.from({ length: 17 }, (_, i) => `${i === 0 ? "M" : "L"}${(ac.x + (ac.w * i) / 16).toFixed(1)},${Math.min(ac.y + ac.h, ay(i / 16)).toFixed(1)}`).join("");
  const ak = data.auction ? clamp(data.auction.progress) : 0;

  return (
    <svg ref={svg} className={`flywheel-svg layout-${layout}`} viewBox={`0 0 ${spec.width} ${spec.height}`} role={onNode ? "group" : "img"} aria-label={label}>
      <g className="fly-flows">
        {paths.map(([flow, d]) => (
          <g key={flow} data-flow={flow} className={`fly-flow kind-${FLOW_KIND[flow]}${flowLit(flow) ? "" : " dim"}`}>
            <path className="fly-path-bg" d={d} />
            <path className="fly-path" d={d} />
          </g>
        ))}
      </g>

      {(["trading", "games", "more"] as const).map((node) => (
        <g key={node} {...nodeProps(node)}>
          {frameOf(node)}
          <text className="fly-title" x={pad} y={spec.small ? 19 : 27} fontSize={fs.title}>
            {spec.small && node === "more" ? "Pots & bets" : SOURCE_TEXT[node].title}
          </text>
          <text className="fly-sub" x={pad} y={spec.small ? 34 : 46} fontSize={fs.sub}>
            {spec.small ? SOURCE_TEXT[node].short : SOURCE_TEXT[node].sub}
          </text>
        </g>
      ))}

      <g {...nodeProps("budget")}>
        {frameOf("budget")}
        <text className="fly-cap" x={pad} y={pad + fs.cap} fontSize={fs.cap}>
          BUDGET
        </text>
        <rect className="tank" x={tank.x} y={tank.y} width={tank.w} height={tank.h} rx="6" />
        <rect className="tank-liquid" x={tank.x} y={tank.y + tank.h - liquid} width={tank.w} height={liquid} rx="6" />
        <line className="tank-surface" x1={tank.x} x2={tank.x + tank.w} y1={tank.y + tank.h - liquid} y2={tank.y + tank.h - liquid} />
        <text className="fly-value" x={n.budget.w / 2} y={n.budget.h - pad - fs.sub - 6} fontSize={fs.value} textAnchor="middle">
          {data.budget.toFixed(digits)}
        </text>
        <text className="fly-sub" x={n.budget.w / 2} y={n.budget.h - pad} fontSize={fs.sub} textAnchor="middle">
          ETH, this collection
        </text>
      </g>

      <g {...nodeProps("bid")}>
        {frameOf("bid")}
        <text className="fly-cap" x={pad} y={pad + fs.cap} fontSize={fs.cap}>
          RISING BID
        </text>
        <text className="fly-value accent" x={pad} y={pad + fs.cap + fs.value + 3} fontSize={fs.value}>
          {data.bid.toFixed(Math.max(digits, 4))}
          <tspan className="fly-unit" fontSize={fs.sub} dx="5">
            ETH
          </tspan>
        </text>
        <text className={limited ? "fly-flag no" : "fly-flag ok"} x={n.bid.w - pad} y={pad + fs.cap} fontSize={fs.cap} textAnchor="end">
          {data.budget < (data.minBid ?? 1e-18) ? "NO BUYBACK" : limited ? "LIMITED BY BUDGET" : data.curve >= data.bidCap ? "AT ITS CAP" : "RISING"}
        </text>
        {limited && (
          <text className="fly-sub warn" x={n.bid.w - pad} y={pad + fs.cap + fs.sub + 5} fontSize={fs.sub} textAnchor="end">
            curve {data.curve.toFixed(3)}
          </text>
        )}
        <line className="bid-cap" x1={chart.x} x2={chart.x + chart.w} y1={cap.y} y2={cap.y} />
        <text className="fly-sub" x={chart.x + chart.w} y={cap.y - 4} fontSize={fs.sub - 1} textAnchor="end">
          cap {data.bidCap.toFixed(2)}
        </text>
        <path className="bid-proj" d={`M${bx},${by} L${cap.x},${cap.y}`} />
        <path className="bid-area" d={`M${base.x},${base.y} L${bx},${by} L${bx},${chart.y + chart.h} L${base.x},${chart.y + chart.h} Z`} />
        <path className="bid-line" d={`M${base.x},${base.y} L${bx},${by}`} />
        <line className="bid-floor" x1={chart.x} x2={chart.x + chart.w} y1={chart.y + chart.h} y2={chart.y + chart.h} />
        <circle className="bid-dot-halo" cx={bx} cy={by} r={spec.small ? 7 : 9} />
        <circle className={limited ? "bid-dot hollow" : "bid-dot"} cx={bx} cy={by} r={spec.small ? 3 : 4} />
      </g>

      <g {...nodeProps("holder")}>
        {frameOf("holder")}
        {layout === "strip" ? (
          <>
            <text className="fly-title" x={n.holder.w / 2} y={34} fontSize={fs.title} textAnchor="middle">
              Holder
            </text>
            <text className="fly-sub" x={n.holder.w / 2} y={52} fontSize={fs.sub} textAnchor="middle">
              sells into it
            </text>
          </>
        ) : (
          <>
            <text className="fly-title" x={pad} y={spec.small ? 15 : 23} fontSize={fs.title}>
              A holder sells
            </text>
            <text className="fly-sub" x={pad} y={spec.small ? 28 : 42} fontSize={fs.sub}>
              paid the bid, no fee
            </text>
          </>
        )}
      </g>

      <g {...nodeProps("vault")}>
        {frameOf("vault")}
        <text className="fly-cap" x={pad} y={pad + fs.cap} fontSize={fs.cap}>
          VAULT
        </text>
        <text className="fly-flag" x={n.vault.w - pad} y={pad + fs.cap} fontSize={fs.cap} textAnchor="end">
          {data.tiles.length} HELD
        </text>
        <g transform={`translate(${pad},${pad + fs.cap + 10})`}>
          {Array.from({ length: Math.max(cols, tiles.length) }, (_, i) => {
            const tile = tiles[i];
            const x = (i % cols) * (slot + 5);
            const y = Math.floor(i / cols) * (slot + 5);
            return (
              <g key={tile?.key ?? `empty-${i}`} className={tile ? `slot is-${tile.state}` : "slot is-empty"} transform={`translate(${x},${y})`}>
                <rect width={slot} height={slot} rx="4" />
                {tile?.state === "locked" && <path d={`M${slot * 0.34},${slot * 0.5} v${-slot * 0.12} a${slot * 0.16},${slot * 0.16} 0 0 1 ${slot * 0.32},0 v${slot * 0.12} M${slot * 0.26},${slot * 0.5} h${slot * 0.48} v${slot * 0.28} h${-slot * 0.48} Z`} />}
              </g>
            );
          })}
        </g>
        {more > 0 && (
          <text className="fly-sub" x={n.vault.w - pad} y={n.vault.h - pad - fs.sub - 4} fontSize={fs.sub} textAnchor="end">
            +{more} more
          </text>
        )}
        <text className="fly-sub" x={pad} y={n.vault.h - pad} fontSize={fs.sub}>
          daily draw from day 90
        </text>
      </g>

      <g {...nodeProps("auction")}>
        {frameOf("auction")}
        <text className="fly-cap" x={pad} y={pad + fs.cap} fontSize={fs.cap}>
          AUCTION
        </text>
        {data.auction && (
          <text className="fly-flag ok" x={n.auction.w - pad} y={pad + fs.cap} fontSize={fs.cap} textAnchor="end">
            {data.auction.price.toFixed(digits)} ETH
          </text>
        )}
        <path className="auction-curve" d={curve} />
        <line className="auction-reserve" x1={ac.x} x2={ac.x + ac.w} y1={ac.y + ac.h} y2={ac.y + ac.h} />
        {data.auction && (
          <>
            <circle className="bid-dot-halo" cx={ac.x + ac.w * ak} cy={Math.min(ac.y + ac.h, ay(ak))} r={spec.small ? 6 : 8} />
            <circle className="bid-dot" cx={ac.x + ac.w * ak} cy={Math.min(ac.y + ac.h, ay(ak))} r={spec.small ? 3 : 4} />
          </>
        )}
        <text className="fly-sub" x={pad} y={n.auction.h - pad + 1} fontSize={fs.sub}>
          {spec.small ? "16× reserve, halves daily" : "opens at 16× the reserve, halves daily"}
        </text>
      </g>

      <g {...nodeProps("raffle")}>
        {frameOf("raffle")}
        <text className="fly-title" x={pad} y={spec.small ? 21 : layout === "strip" ? 24 : 20} fontSize={fs.title}>
          Raffle
        </text>
        <text className="fly-sub" x={spec.small ? 52 : pad} y={spec.small ? 21 : layout === "strip" ? 42 : 36} fontSize={fs.sub}>
          to points holders
        </text>
      </g>

      <g ref={layer} className="fly-particles" aria-hidden="true" />
    </svg>
  );
});
