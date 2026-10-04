// Complete current SQLite authentication contract; migration rejects schema drift.
export const AUTH_TABLES = [
  {
    name: "api_keys",
    sql: "CREATE TABLE api_keys (\n        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, organization_id TEXT NOT NULL, name TEXT NOT NULL,\n        prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,\n        last_used_at INTEGER, revoked_at INTEGER\n      )",
    columns: [
      {"name":"id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"user_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"organization_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"name","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"prefix","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"key_hash","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"last_used_at","type":"INTEGER","notNull":false,"primaryKey":0},
      {"name":"revoked_at","type":"INTEGER","notNull":false,"primaryKey":0},
    ],
  },
  {
    name: "chat_shares",
    sql: "CREATE TABLE chat_shares (\n        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, organization_id TEXT NOT NULL,\n        session_id TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER\n      )",
    columns: [
      {"name":"id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"token_hash","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"user_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"organization_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"session_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"revoked_at","type":"INTEGER","notNull":false,"primaryKey":0},
    ],
  },
  {
    name: "desktop_handoffs",
    sql: "CREATE TABLE desktop_handoffs (id TEXT PRIMARY KEY, challenge TEXT NOT NULL, user_id TEXT, device TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, completed_at INTEGER, claimed_at INTEGER)",
    columns: [
      {"name":"id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"challenge","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"user_id","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"device","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"expires_at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"completed_at","type":"INTEGER","notNull":false,"primaryKey":0},
      {"name":"claimed_at","type":"INTEGER","notNull":false,"primaryKey":0},
    ],
  },
  {
    name: "email_verifications",
    sql: "CREATE TABLE email_verifications (\n      token_hash TEXT PRIMARY KEY,\n      user_id TEXT NOT NULL,\n      email TEXT NOT NULL,\n      created_at INTEGER NOT NULL,\n      expires_at INTEGER NOT NULL,\n      used_at INTEGER\n    )",
    columns: [
      {"name":"token_hash","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"user_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"email","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"expires_at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"used_at","type":"INTEGER","notNull":false,"primaryKey":0},
    ],
  },
  {
    name: "github_links",
    sql: "CREATE TABLE github_links (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL)",
    columns: [
      {"name":"id_hash","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"user_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"expires_at","type":"INTEGER","notNull":true,"primaryKey":0},
    ],
  },
  {
    name: "legal_acceptances",
    sql: "CREATE TABLE legal_acceptances (\n        user_id TEXT NOT NULL,\n        version TEXT NOT NULL,\n        source TEXT NOT NULL,\n        accepted_at INTEGER NOT NULL,\n        PRIMARY KEY (user_id, version)\n      )",
    columns: [
      {"name":"user_id","type":"TEXT","notNull":true,"primaryKey":1},
      {"name":"version","type":"TEXT","notNull":true,"primaryKey":2},
      {"name":"source","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"accepted_at","type":"INTEGER","notNull":true,"primaryKey":0},
    ],
  },
  {
    name: "login_failures",
    sql: "CREATE TABLE login_failures (email TEXT PRIMARY KEY, count INTEGER NOT NULL, first_at INTEGER NOT NULL)",
    columns: [
      {"name":"email","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"count","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"first_at","type":"INTEGER","notNull":true,"primaryKey":0},
    ],
  },
  {
    name: "oauth_identities",
    sql: "CREATE TABLE oauth_identities (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (provider, subject))",
    columns: [
      {"name":"provider","type":"TEXT","notNull":true,"primaryKey":1},
      {"name":"subject","type":"TEXT","notNull":true,"primaryKey":2},
      {"name":"user_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"email","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
    ],
  },
  {
    name: "oauth_states",
    sql: "CREATE TABLE oauth_states (state_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, verifier TEXT NOT NULL, client TEXT NOT NULL, handoff_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    columns: [
      {"name":"state_hash","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"provider","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"verifier","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"client","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"handoff_id","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"expires_at","type":"INTEGER","notNull":true,"primaryKey":0},
    ],
  },
  {
    name: "org_invites",
    sql: "CREATE TABLE org_invites (\n        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL,\n        token_hash TEXT NOT NULL UNIQUE, invited_by TEXT NOT NULL, created_at INTEGER NOT NULL,\n        expires_at INTEGER NOT NULL, accepted_at INTEGER, revoked_at INTEGER\n      )",
    columns: [
      {"name":"id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"organization_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"email","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"role","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"token_hash","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"invited_by","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"expires_at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"accepted_at","type":"INTEGER","notNull":false,"primaryKey":0},
      {"name":"revoked_at","type":"INTEGER","notNull":false,"primaryKey":0},
    ],
  },
  {
    name: "organization_members",
    sql: "CREATE TABLE organization_members (\n  organization_id TEXT NOT NULL,\n  user_id TEXT NOT NULL,\n  role TEXT NOT NULL,\n  created_at INTEGER NOT NULL,\n  PRIMARY KEY (organization_id, user_id)\n)",
    columns: [
      {"name":"organization_id","type":"TEXT","notNull":true,"primaryKey":1},
      {"name":"user_id","type":"TEXT","notNull":true,"primaryKey":2},
      {"name":"role","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
    ],
  },
  {
    name: "organizations",
    sql: "CREATE TABLE organizations (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  tenant_id TEXT NOT NULL UNIQUE,\n  created_at INTEGER NOT NULL\n)",
    columns: [
      {"name":"id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"name","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"kind","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"tenant_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
    ],
  },
  {
    name: "password_resets",
    sql: "CREATE TABLE password_resets (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)",
    columns: [
      {"name":"token_hash","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"user_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"expires_at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"used_at","type":"INTEGER","notNull":false,"primaryKey":0},
    ],
  },
  {
    name: "session_rotations",
    sql: "CREATE TABLE session_rotations (old_hash TEXT PRIMARY KEY, family TEXT NOT NULL, user_id TEXT NOT NULL, rotated_at INTEGER NOT NULL)",
    columns: [
      {"name":"old_hash","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"family","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"user_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"rotated_at","type":"INTEGER","notNull":true,"primaryKey":0},
    ],
  },
  {
    name: "sessions",
    sql: "CREATE TABLE sessions (\n  token_hash TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL,\n  created_at INTEGER NOT NULL,\n  expires_at INTEGER NOT NULL\n, organization_id TEXT, id TEXT, device TEXT, last_used_at INTEGER, family TEXT)",
    columns: [
      {"name":"token_hash","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"user_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"expires_at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"organization_id","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"id","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"device","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"last_used_at","type":"INTEGER","notNull":false,"primaryKey":0},
      {"name":"family","type":"TEXT","notNull":false,"primaryKey":0},
    ],
  },
  {
    name: "tenant_chats",
    sql: "CREATE TABLE tenant_chats (\n  id TEXT PRIMARY KEY,\n  tenant_id TEXT NOT NULL,\n  organization_id TEXT NOT NULL,\n  user_id TEXT NOT NULL,\n  title TEXT,\n  created_at INTEGER NOT NULL\n)",
    columns: [
      {"name":"id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"tenant_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"organization_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"user_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"title","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
    ],
  },
  {
    name: "tenant_projects",
    sql: "CREATE TABLE tenant_projects (\n  id TEXT PRIMARY KEY,\n  tenant_id TEXT NOT NULL,\n  organization_id TEXT NOT NULL,\n  user_id TEXT NOT NULL,\n  name TEXT NOT NULL,\n  project_root TEXT,\n  created_at INTEGER NOT NULL\n, description TEXT, updated_at INTEGER)",
    columns: [
      {"name":"id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"tenant_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"organization_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"user_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"name","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"project_root","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"description","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"updated_at","type":"INTEGER","notNull":false,"primaryKey":0},
    ],
  },
  {
    name: "users",
    sql: "CREATE TABLE users (\n  id TEXT PRIMARY KEY,\n  email TEXT NOT NULL UNIQUE,\n  name TEXT,\n  password_hash TEXT NOT NULL,\n  created_at INTEGER NOT NULL\n, email_verified_at INTEGER, password_changed_at INTEGER, terms_accepted_at INTEGER)",
    columns: [
      {"name":"id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"email","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"name","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"password_hash","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"email_verified_at","type":"INTEGER","notNull":false,"primaryKey":0},
      {"name":"password_changed_at","type":"INTEGER","notNull":false,"primaryKey":0},
      {"name":"terms_accepted_at","type":"INTEGER","notNull":false,"primaryKey":0},
    ],
  },
] as const;

export const AUTH_INDEXES = [
  "CREATE INDEX idx_api_keys_user ON api_keys (user_id)",
  "CREATE INDEX idx_chats_tenant ON tenant_chats (tenant_id, created_at)",
  "CREATE INDEX idx_invites_org ON org_invites (organization_id)",
  "CREATE INDEX idx_legal_acceptances_user ON legal_acceptances (user_id, accepted_at)",
  "CREATE INDEX idx_legal_acceptances_version ON legal_acceptances (version, accepted_at)",
  "CREATE INDEX idx_projects_tenant ON tenant_projects (tenant_id, created_at)",
  "CREATE INDEX idx_sessions_id ON sessions (id)",
  "CREATE INDEX idx_sessions_user ON sessions (user_id)",
  "CREATE INDEX idx_shares_session ON chat_shares (session_id)",
  "CREATE INDEX idx_verify_user ON email_verifications (user_id)"
] as const;

export const AUTH_UNIQUE_KEYS = {
  "api_keys": [
    [
      "key_hash"
    ],
    [
      "id"
    ]
  ],
  "chat_shares": [
    [
      "token_hash"
    ],
    [
      "id"
    ]
  ],
  "desktop_handoffs": [
    [
      "id"
    ]
  ],
  "email_verifications": [
    [
      "token_hash"
    ]
  ],
  "github_links": [
    [
      "id_hash"
    ]
  ],
  "legal_acceptances": [
    [
      "user_id",
      "version"
    ]
  ],
  "login_failures": [
    [
      "email"
    ]
  ],
  "oauth_identities": [
    [
      "provider",
      "subject"
    ]
  ],
  "oauth_states": [
    [
      "state_hash"
    ]
  ],
  "org_invites": [
    [
      "token_hash"
    ],
    [
      "id"
    ]
  ],
  "organization_members": [
    [
      "organization_id",
      "user_id"
    ]
  ],
  "organizations": [
    [
      "tenant_id"
    ],
    [
      "id"
    ]
  ],
  "password_resets": [
    [
      "token_hash"
    ]
  ],
  "session_rotations": [
    [
      "old_hash"
    ]
  ],
  "sessions": [
    [
      "token_hash"
    ]
  ],
  "tenant_chats": [
    [
      "id"
    ]
  ],
  "tenant_projects": [
    [
      "id"
    ]
  ],
  "users": [
    [
      "email"
    ],
    [
      "id"
    ]
  ]
} as const;
