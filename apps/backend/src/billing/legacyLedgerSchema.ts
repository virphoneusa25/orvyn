// Archived v1 records are retained for audit only; active balances use wallets/ledger_entries.
const columns = (text: string[], integers: string[], real: string[] = []) => [
  ...text.map(name => ({name,type:"TEXT"})), ...integers.map(name => ({name,type:"INTEGER"})), ...real.map(name => ({name,type:"REAL"})),
];
export const LEGACY_LEDGER_TABLES = [
  {name:"v1_accounts",key:"user_id",columns:columns(["user_id","plan_id"],["cycle_start","included_balance","purchased_balance","reserved_balance"])},
  {name:"credit_transactions",key:"id",columns:columns(["id","user_id","kind","meta"],["credits","included_after","purchased_after","reserved_after","created_at"])},
  {name:"credit_reservations",key:"id",columns:columns(["id","user_id","run_id","status"],["credits","created_at"])},
  {name:"top_up_orders",key:"id",columns:columns(["id","user_id","pack_id","source"],["credits","created_at"],["price_usd"])},
];
