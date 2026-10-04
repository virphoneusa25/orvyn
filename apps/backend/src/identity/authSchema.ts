// Complete production auth.db contract: authentication, staff and onboarding.
export const AUTH_TABLES = [
  {
    name: "account_suspensions",
    sql: "CREATE TABLE account_suspensions (\n        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, reason TEXT NOT NULL, category TEXT NOT NULL, by_email TEXT NOT NULL,\n        at INTEGER NOT NULL, lifted_at INTEGER, lifted_by TEXT\n      )",
    columns: [
      {"name":"id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"tenant_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"reason","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"category","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"by_email","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"lifted_at","type":"INTEGER","notNull":false,"primaryKey":0},
      {"name":"lifted_by","type":"TEXT","notNull":false,"primaryKey":0},
    ],
  },
  {
    name: "admin_audit",
    sql: "CREATE TABLE admin_audit (\n        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL,\n        actor_id TEXT NOT NULL, actor_email TEXT NOT NULL, action TEXT NOT NULL, tenant_id TEXT, detail TEXT NOT NULL DEFAULT '{}', ip TEXT\n      )",
    columns: [
      {"name":"seq","type":"INTEGER","notNull":false,"primaryKey":1},
      {"name":"id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"actor_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"actor_email","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"action","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"tenant_id","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"detail","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"ip","type":"TEXT","notNull":false,"primaryKey":0},
    ],
  },
  {
    name: "analytics_events",
    sql: "CREATE TABLE analytics_events (\n        id TEXT PRIMARY KEY,\n        user_id TEXT,\n        name TEXT NOT NULL,\n        props TEXT NOT NULL,\n        created_at INTEGER NOT NULL\n      )",
    columns: [
      {"name":"id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"user_id","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"name","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"props","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
    ],
  },
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
    name: "onboarding_profiles",
    sql: "CREATE TABLE onboarding_profiles (\n        user_id TEXT PRIMARY KEY,\n        id TEXT NOT NULL,\n        current_step TEXT NOT NULL,\n        completed_steps TEXT NOT NULL,\n        answers TEXT NOT NULL,\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL,\n        completed_at INTEGER\n      )",
    columns: [
      {"name":"user_id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"current_step","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"completed_steps","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"answers","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"updated_at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"completed_at","type":"INTEGER","notNull":false,"primaryKey":0},
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
    name: "org_profiles",
    sql: "CREATE TABLE org_profiles (tenant_id TEXT PRIMARY KEY, website TEXT, industry TEXT, location TEXT, updated_at INTEGER NOT NULL, updated_by TEXT)",
    columns: [
      {"name":"tenant_id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"website","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"industry","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"location","type":"TEXT","notNull":false,"primaryKey":0},
      {"name":"updated_at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"updated_by","type":"TEXT","notNull":false,"primaryKey":0},
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
    name: "platform_staff",
    sql: "CREATE TABLE platform_staff (user_id TEXT PRIMARY KEY, role TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT)",
    columns: [
      {"name":"user_id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"role","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"created_by","type":"TEXT","notNull":false,"primaryKey":0},
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
    name: "support_notes",
    sql: "CREATE TABLE support_notes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, author_id TEXT NOT NULL, author_email TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL)",
    columns: [
      {"name":"id","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"tenant_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"author_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"author_email","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"body","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
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
  {
    name: "view_as_sessions",
    sql: "CREATE TABLE view_as_sessions (token_hash TEXT PRIMARY KEY, staff_id TEXT NOT NULL, staff_email TEXT NOT NULL, user_id TEXT NOT NULL, organization_id TEXT NOT NULL, tenant_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    columns: [
      {"name":"token_hash","type":"TEXT","notNull":false,"primaryKey":1},
      {"name":"staff_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"staff_email","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"user_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"organization_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"tenant_id","type":"TEXT","notNull":true,"primaryKey":0},
      {"name":"created_at","type":"INTEGER","notNull":true,"primaryKey":0},
      {"name":"expires_at","type":"INTEGER","notNull":true,"primaryKey":0},
    ],
  },
] as const;

export const AUTH_INDEXES = [
  "CREATE INDEX account_suspensions_tenant ON account_suspensions (tenant_id, lifted_at)",
  "CREATE INDEX admin_audit_at ON admin_audit (at)",
  "CREATE INDEX admin_audit_tenant ON admin_audit (tenant_id, at)",
  "CREATE INDEX idx_analytics_name ON analytics_events (name, created_at)",
  "CREATE INDEX idx_api_keys_user ON api_keys (user_id)",
  "CREATE INDEX idx_chats_tenant ON tenant_chats (tenant_id, created_at)",
  "CREATE INDEX idx_invites_org ON org_invites (organization_id)",
  "CREATE INDEX idx_legal_acceptances_user ON legal_acceptances (user_id, accepted_at)",
  "CREATE INDEX idx_legal_acceptances_version ON legal_acceptances (version, accepted_at)",
  "CREATE INDEX idx_projects_tenant ON tenant_projects (tenant_id, created_at)",
  "CREATE INDEX idx_sessions_id ON sessions (id)",
  "CREATE INDEX idx_sessions_user ON sessions (user_id)",
  "CREATE INDEX idx_shares_session ON chat_shares (session_id)",
  "CREATE INDEX idx_verify_user ON email_verifications (user_id)",
  "CREATE INDEX support_notes_tenant ON support_notes (tenant_id, created_at)"
] as const;

export const AUTH_UNIQUE_KEYS = {
  "account_suspensions": [
    [
      "id"
    ],
    [
      "id"
    ]
  ],
  "admin_audit": [
    [
      "id"
    ],
    [
      "seq"
    ]
  ],
  "analytics_events": [
    [
      "id"
    ],
    [
      "id"
    ]
  ],
  "api_keys": [
    [
      "key_hash"
    ],
    [
      "id"
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
    ],
    [
      "id"
    ]
  ],
  "desktop_handoffs": [
    [
      "id"
    ],
    [
      "id"
    ]
  ],
  "email_verifications": [
    [
      "token_hash"
    ],
    [
      "token_hash"
    ]
  ],
  "github_links": [
    [
      "id_hash"
    ],
    [
      "id_hash"
    ]
  ],
  "legal_acceptances": [
    [
      "user_id",
      "version"
    ],
    [
      "user_id",
      "version"
    ]
  ],
  "login_failures": [
    [
      "email"
    ],
    [
      "email"
    ]
  ],
  "oauth_identities": [
    [
      "provider",
      "subject"
    ],
    [
      "provider",
      "subject"
    ]
  ],
  "oauth_states": [
    [
      "state_hash"
    ],
    [
      "state_hash"
    ]
  ],
  "onboarding_profiles": [
    [
      "user_id"
    ],
    [
      "user_id"
    ]
  ],
  "org_invites": [
    [
      "token_hash"
    ],
    [
      "id"
    ],
    [
      "id"
    ]
  ],
  "org_profiles": [
    [
      "tenant_id"
    ],
    [
      "tenant_id"
    ]
  ],
  "organization_members": [
    [
      "organization_id",
      "user_id"
    ],
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
    ],
    [
      "id"
    ]
  ],
  "password_resets": [
    [
      "token_hash"
    ],
    [
      "token_hash"
    ]
  ],
  "platform_staff": [
    [
      "user_id"
    ],
    [
      "user_id"
    ]
  ],
  "session_rotations": [
    [
      "old_hash"
    ],
    [
      "old_hash"
    ]
  ],
  "sessions": [
    [
      "token_hash"
    ],
    [
      "token_hash"
    ]
  ],
  "support_notes": [
    [
      "id"
    ],
    [
      "id"
    ]
  ],
  "tenant_chats": [
    [
      "id"
    ],
    [
      "id"
    ]
  ],
  "tenant_projects": [
    [
      "id"
    ],
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
    ],
    [
      "id"
    ]
  ],
  "view_as_sessions": [
    [
      "token_hash"
    ],
    [
      "token_hash"
    ]
  ]
} as const;

export const AUTH_TRIGGERS = [
  {
    "name": "admin_audit_no_delete",
    "sql": "CREATE TRIGGER admin_audit_no_delete BEFORE DELETE ON admin_audit BEGIN SELECT RAISE(ABORT, 'admin_audit is append-only'); END"
  },
  {
    "name": "admin_audit_no_update",
    "sql": "CREATE TRIGGER admin_audit_no_update BEFORE UPDATE ON admin_audit BEGIN SELECT RAISE(ABORT, 'admin_audit is append-only'); END"
  }
] as const;
