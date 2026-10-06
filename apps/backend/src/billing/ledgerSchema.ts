// Complete active billing.sqlite contract; live storage routing is unchanged.
export const LEDGER_TABLES = [
  {
    name:"auto_recharge",
    sql:"CREATE TABLE auto_recharge (\n        user_id TEXT PRIMARY KEY,\n        threshold INTEGER NOT NULL,\n        pack_id TEXT NOT NULL,\n        max_per_month INTEGER NOT NULL,\n        recharges_this_cycle INTEGER NOT NULL DEFAULT 0\n      )",
    columns:[
      {"name":"user_id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"threshold","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"pack_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"max_per_month","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"recharges_this_cycle","type":"INTEGER","notNull":true,"primaryKey":0},
    ],
  },
  {
    name:"auto_recharge_requests",
    sql:"CREATE TABLE auto_recharge_requests (\n        account_id TEXT NOT NULL,\n        cycle_start INTEGER NOT NULL,\n        n INTEGER NOT NULL,\n        pack_id TEXT NOT NULL,\n        status TEXT NOT NULL,\n        created_at INTEGER NOT NULL,\n        PRIMARY KEY (account_id, cycle_start, n)\n      )",
    columns:[
      {"name":"account_id","type":"TEXT","notNull":true,"primaryKey":1},
      {"name":"cycle_start","type":"INTEGER","notNull":true,"primaryKey":2},
      {"name":"n","type":"INTEGER","notNull":true,"primaryKey":3},
      {"name":"pack_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"status","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
    ],
  },
  {
    name:"image_rate_cards",
    sql:"CREATE TABLE image_rate_cards (id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,\n        usd_per_image REAL NOT NULL, source TEXT NOT NULL, verified_at INTEGER NOT NULL, UNIQUE(provider,model,verified_at))",
    columns:[
      {"name":"id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"provider","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"model","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"usd_per_image","type":"REAL","notNull":true,"primaryKey":0},
      {"name":"source","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"verified_at","type":"INTEGER","notNull":true,"primaryKey":0},
    ],
  },
  {
    name:"image_reservations",
    sql:"CREATE TABLE image_reservations (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, lane TEXT NOT NULL,\n        n INTEGER NOT NULL, credits INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    columns:[
      {"name":"id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"account_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"lane","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"n","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"credits","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"expires_at","type":"INTEGER","notNull":true,"primaryKey":0},
    ],
  },
  {
    name:"image_usage_counts",
    sql:"CREATE TABLE image_usage_counts (event_id TEXT PRIMARY KEY, n INTEGER NOT NULL)",
    columns:[
      {"name":"event_id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"n","type":"INTEGER","notNull":true,"primaryKey":0},
    ],
  },
  {
    name:"ledger_entries",
    sql:"CREATE TABLE ledger_entries (\n        seq INTEGER PRIMARY KEY AUTOINCREMENT,\n        id TEXT NOT NULL UNIQUE,\n        account_id TEXT NOT NULL,\n        type TEXT NOT NULL,\n        bucket TEXT NOT NULL CHECK (bucket IN ('included','purchased','hold')),\n        amount INTEGER NOT NULL,\n        idempotency_key TEXT NOT NULL UNIQUE,\n        run_id TEXT,\n        actor TEXT,\n        meta TEXT NOT NULL DEFAULT '{}',\n        created_at INTEGER NOT NULL\n      )",
    columns:[
      {"name":"seq","type":"INTEGER","notNull":false,"primaryKey":1},
      {"name":"id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"account_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"type","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"bucket","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"amount","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"idempotency_key","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"run_id","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"actor","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"meta","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
    ],
  },
  {
    name:"rate_cards",
    sql:"CREATE TABLE rate_cards (\n        id TEXT PRIMARY KEY,\n        provider TEXT NOT NULL,\n        model_id TEXT NOT NULL,\n        input_usd_per_million REAL NOT NULL,\n        cached_input_usd_per_million REAL NOT NULL,\n        output_usd_per_million REAL NOT NULL,\n        effective_from INTEGER NOT NULL,\n        effective_to INTEGER\n      )",
    columns:[
      {"name":"id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"provider","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"model_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"input_usd_per_million","type":"REAL","notNull":true,"primaryKey":0},
      {"name":"cached_input_usd_per_million","type":"REAL","notNull":true,"primaryKey":0},
      {"name":"output_usd_per_million","type":"REAL","notNull":true,"primaryKey":0},
      {"name":"effective_from","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"effective_to","type":"INTEGER","notNull":false,"primaryKey":0},
    ],
  },
  {
    name:"run_budget",
    sql:"CREATE TABLE run_budget (\n        run_id TEXT PRIMARY KEY,\n        user_id TEXT NOT NULL,\n        extra_usd REAL NOT NULL DEFAULT 0\n      )",
    columns:[
      {"name":"run_id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"user_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"extra_usd","type":"REAL","notNull":true,"primaryKey":0},
    ],
  },
  {
    name:"usage_events",
    sql:"CREATE TABLE usage_events (\n        id TEXT PRIMARY KEY,\n        user_id TEXT NOT NULL,\n        organization_id TEXT,\n        session_id TEXT,\n        run_id TEXT,\n        type TEXT NOT NULL,\n        provider TEXT,\n        model TEXT,\n        lane TEXT,\n        input_tokens INTEGER,\n        cached_input_tokens INTEGER,\n        output_tokens INTEGER,\n        provider_cost_micros INTEGER NOT NULL,\n        credits_charged INTEGER NOT NULL,\n        rate_card_id TEXT,\n        ok INTEGER NOT NULL,\n        created_at INTEGER NOT NULL\n      )",
    columns:[
      {"name":"id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"user_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"organization_id","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"session_id","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"run_id","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"type","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"provider","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"model","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"lane","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"input_tokens","type":"INTEGER","notNull":false,"primaryKey":0},
      {"name":"cached_input_tokens","type":"INTEGER","notNull":false,"primaryKey":0},
      {"name":"output_tokens","type":"INTEGER","notNull":false,"primaryKey":0},
      {"name":"provider_cost_micros","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"credits_charged","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"rate_card_id","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"ok","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
    ],
  },
  {
    name:"wallets",
    sql:"CREATE TABLE wallets (\n        account_id TEXT PRIMARY KEY,\n        plan_id TEXT NOT NULL,\n        subscription_id TEXT,\n        subscription_status TEXT NOT NULL DEFAULT 'none',\n        cycle_start INTEGER NOT NULL,\n        cycle_end INTEGER NOT NULL,\n        created_at INTEGER NOT NULL\n      )",
    columns:[
      {"name":"account_id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"plan_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"subscription_id","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"subscription_status","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"cycle_start","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"cycle_end","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
    ],
  },
] as const;
export const LEDGER_UNIQUE_KEYS: Record<string,readonly (readonly string[])[]> = {
  "auto_recharge": [
    [
      "user_id"
    ],
    [
      "user_id"
    ]
  ],
  "auto_recharge_requests": [
    [
      "account_id",
      "cycle_start",
      "n"
    ],
    [
      "account_id",
      "cycle_start",
      "n"
    ]
  ],
  "image_rate_cards": [
    [
      "provider",
      "model",
      "verified_at"
    ],
    [
      "id"
    ],
    [
      "id"
    ]
  ],
  "image_reservations": [
    [
      "id"
    ],
    [
      "id"
    ]
  ],
  "image_usage_counts": [
    [
      "event_id"
    ],
    [
      "event_id"
    ]
  ],
  "ledger_entries": [
    [
      "idempotency_key"
    ],
    [
      "id"
    ],
    [
      "seq"
    ]
  ],
  "rate_cards": [
    [
      "id"
    ],
    [
      "id"
    ]
  ],
  "run_budget": [
    [
      "run_id"
    ],
    [
      "run_id"
    ]
  ],
  "usage_events": [
    [
      "id"
    ],
    [
      "id"
    ]
  ],
  "wallets": [
    [
      "account_id"
    ],
    [
      "account_id"
    ]
  ]
};
export const LEDGER_INDEXES = [
  "CREATE INDEX ledger_account ON ledger_entries(account_id, created_at)",
  "CREATE INDEX ledger_run ON ledger_entries(run_id)"
] as const;
export const LEDGER_TRIGGERS = [
  {
    "name": "ledger_no_delete",
    "sql": "CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries\n        BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END"
  },
  {
    "name": "ledger_no_update",
    "sql": "CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries\n        BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END"
  }
] as const;
