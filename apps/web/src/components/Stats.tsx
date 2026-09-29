import { date, num } from "../lib/format";
import { navigate } from "../lib/router";
import type { Wallet } from "../lib/store";
import { Bar } from "./Bits";
import { Icon } from "./Icons";

function until(ts: number): string {
  const ms = Math.max(0, ts - Date.now());
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 48) return `${Math.round(h / 24)} days`;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** The six account cards (Home and Billing). */
export function StatCards({ w }: { w: Wallet }) {
  const sub = w.subscription;
  const paid = w.plan.id !== "free";
  const active = sub?.status === "active" || sub?.status === "trialing";
  return (
    <div className="stats" data-testid="stat-cards">
      <div className="card stat stat--link" onClick={() => navigate("/billing#plans")} role="link">
        <Icon.crown size={32} />
        <div className="stat__body">
          <div className="stat__label">Current Plan</div>
          <div className="stat__value" data-testid="stat-plan">{w.plan.label}</div>
          <div className="stat__foot">{paid ? w.plan.priceLabel : "Upgrade anytime"}</div>
        </div>
        <Icon.chev size={16} />
      </div>
      <div className="card stat">
        <Icon.coins size={32} />
        <div className="stat__body">
          <div className="stat__label">Monthly Credits</div>
          <div className="stat__value">{num(w.windows.cycle.used)} <small>/ {num(w.windows.cycle.limit)}</small></div>
          <Bar used={w.windows.cycle.used} limit={w.windows.cycle.limit} />
        </div>
      </div>
      <div className="card stat">
        <Icon.clock size={32} />
        <div className="stat__body">
          <div className="stat__label">5-Hour Usage <span title="Rolling 5-hour allowance"><Icon.info size={14} /></span></div>
          <div className="stat__value">{num(w.windows.fiveHour.used)} <small>/ {num(w.windows.fiveHour.limit)}</small></div>
          <Bar used={w.windows.fiveHour.used} limit={w.windows.fiveHour.limit} />
          <div className="stat__foot">Frees up in {until(w.windows.fiveHour.resetAt)}</div>
        </div>
      </div>
      <div className="card stat">
        <Icon.bars size={32} />
        <div className="stat__body">
          <div className="stat__label">7-Day Usage <span title="Rolling 7-day allowance"><Icon.info size={14} /></span></div>
          <div className="stat__value">{num(w.windows.sevenDay.used)} <small>/ {num(w.windows.sevenDay.limit)}</small></div>
          <Bar used={w.windows.sevenDay.used} limit={w.windows.sevenDay.limit} />
          <div className="stat__foot">Frees up in {until(w.windows.sevenDay.resetAt)}</div>
        </div>
      </div>
      <div className="card stat stat--link" onClick={() => navigate("/billing#credits")} role="link">
        <Icon.plusCircle size={32} />
        <div className="stat__body">
          <div className="stat__label">Top-up Balance</div>
          <div className="stat__value" data-testid="stat-topup">{num(w.purchasedBalance)} <small>credits</small></div>
          <div className="stat__foot">Never expires</div>
        </div>
        <Icon.chev size={16} />
      </div>
      <div className="card stat stat--link" onClick={() => navigate("/billing")} role="link">
        <Icon.billing size={32} />
        <div className="stat__body">
          <div className="stat__label">Active Subscription</div>
          <div className="stat__value">{paid && sub ? (active ? "Active" : sub.status.replace(/_/g, " ")) : "None"}</div>
          <div className="stat__foot">{paid && sub?.cycleEnd ? `Renews ${date(sub.cycleEnd)}` : "Free plan"}</div>
        </div>
        <Icon.chev size={16} />
      </div>
    </div>
  );
}
