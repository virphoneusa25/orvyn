// Complete payments.sqlite migration contract; live billing remains unchanged.
export const STRIPE_TABLES = [
  {name:"stripe_checkouts",sql:"CREATE TABLE stripe_checkouts (\n        session_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, item TEXT NOT NULL,\n        period TEXT, status TEXT NOT NULL, payment_intent TEXT, subscription_id TEXT, created_at INTEGER NOT NULL\n      )",columns:[
    {"name":"session_id","type":"TEXT","notNull":false,"primaryKey":1},
    {"name":"account_id","type":"TEXT","notNull":true,"primaryKey":0},
    {"name":"kind","type":"TEXT","notNull":true,"primaryKey":0},
    {"name":"item","type":"TEXT","notNull":true,"primaryKey":0},
    {"name":"period","type":"TEXT","notNull":false,"primaryKey":0},
    {"name":"status","type":"TEXT","notNull":true,"primaryKey":0},
    {"name":"payment_intent","type":"TEXT","notNull":false,"primaryKey":0},
    {"name":"subscription_id","type":"TEXT","notNull":false,"primaryKey":0},
    {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
  ]},
  {name:"stripe_customers",sql:"CREATE TABLE stripe_customers (account_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL UNIQUE, email TEXT, created_at INTEGER NOT NULL)",columns:[
    {"name":"account_id","type":"TEXT","notNull":false,"primaryKey":1},
    {"name":"customer_id","type":"TEXT","notNull":true,"primaryKey":0},
    {"name":"email","type":"TEXT","notNull":false,"primaryKey":0},
    {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
  ]},
  {name:"stripe_events",sql:"CREATE TABLE stripe_events (\n        id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at INTEGER NOT NULL,\n        status TEXT NOT NULL, error TEXT, processed_at INTEGER\n      )",columns:[
    {"name":"id","type":"TEXT","notNull":false,"primaryKey":1},
    {"name":"type","type":"TEXT","notNull":true,"primaryKey":0},
    {"name":"received_at","type":"INTEGER","notNull":true,"primaryKey":0},
    {"name":"status","type":"TEXT","notNull":true,"primaryKey":0},
    {"name":"error","type":"TEXT","notNull":false,"primaryKey":0},
    {"name":"processed_at","type":"INTEGER","notNull":false,"primaryKey":0},
  ]},
  {name:"stripe_subscriptions",sql:"CREATE TABLE stripe_subscriptions (\n        subscription_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, plan_id TEXT NOT NULL, status TEXT NOT NULL,\n        period_start INTEGER, period_end INTEGER, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL\n      )",columns:[
    {"name":"subscription_id","type":"TEXT","notNull":false,"primaryKey":1},
    {"name":"account_id","type":"TEXT","notNull":true,"primaryKey":0},
    {"name":"plan_id","type":"TEXT","notNull":true,"primaryKey":0},
    {"name":"status","type":"TEXT","notNull":true,"primaryKey":0},
    {"name":"period_start","type":"INTEGER","notNull":false,"primaryKey":0},
    {"name":"period_end","type":"INTEGER","notNull":false,"primaryKey":0},
    {"name":"cancel_at_period_end","type":"INTEGER","notNull":true,"primaryKey":0},
    {"name":"updated_at","type":"INTEGER","notNull":true,"primaryKey":0},
  ]},
] as const;
export const STRIPE_UNIQUE_KEYS:Record<string,readonly (readonly string[])[]> = {
  "stripe_checkouts": [
    [
      "session_id"
    ],
    [
      "session_id"
    ]
  ],
  "stripe_customers": [
    [
      "customer_id"
    ],
    [
      "account_id"
    ],
    [
      "account_id"
    ]
  ],
  "stripe_events": [
    [
      "id"
    ],
    [
      "id"
    ]
  ],
  "stripe_subscriptions": [
    [
      "subscription_id"
    ],
    [
      "subscription_id"
    ]
  ]
};
export const STRIPE_INDEXES = ["CREATE INDEX stripe_checkouts_pi ON stripe_checkouts(payment_intent)"] as const;
