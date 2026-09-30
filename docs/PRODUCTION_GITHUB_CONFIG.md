# ORVYN GitHub Production Configuration

The OVH deployment reads production configuration from **Settings → Secrets and variables → Actions**.
The CI production-readiness gate checks for the required names before any deployment touches OVH.

## Repository secrets

Add these under **Secrets**:

### OAuth
- `GOOGLE_CLIENT_SECRET`
- `ORVYN_GH_CLIENT_SECRET` (the workflow maps this to the backend's GitHub client secret)
- `GOOGLE_OAUTH` / `ORVYN_GH_SECRET` may still be used as combined compatibility values, but explicit ID + secret configuration is preferred.

### Email
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

For port 465 use `SMTP_SECURE=true`. For port 587 use `SMTP_SECURE=false`.

### Stripe
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

Stripe webhook endpoint:

`https://orvyn.virphoneusa.com/api/v1/billing/stripe/webhook`

### Off-host backups
- `BACKUP_PASSPHRASE`
- `BACKUP_S3_ACCESS_KEY_ID`
- `BACKUP_S3_SECRET_ACCESS_KEY`

### Deployment / providers
- `OVH_SSH_PRIVATE_KEY`
- `NEBIUS_API_KEY`

## Repository variables

Add these under **Variables**:

### Public origin / OAuth IDs
- `ORVYN_PUBLIC_ORIGIN=https://orvyn.virphoneusa.com`
- `GOOGLE_CLIENT_ID`
- `ORVYN_GH_CLIENT_ID`

Google client IDs normally end in `.apps.googleusercontent.com`.
GitHub OAuth client IDs commonly begin with `Ov23` or `Iv1.`.

### Stripe recurring prices
- `STRIPE_PRICE_STARTER_MONTHLY`
- `STRIPE_PRICE_STARTER_ANNUAL`
- `STRIPE_PRICE_PRO_MONTHLY`
- `STRIPE_PRICE_PRO_ANNUAL`
- `STRIPE_PRICE_POWER_MONTHLY`
- `STRIPE_PRICE_POWER_ANNUAL`
- `STRIPE_PRICE_BUSINESS_MONTHLY`
- `STRIPE_PRICE_BUSINESS_ANNUAL`
- `STRIPE_PRICE_TEAM_MONTHLY`
- `STRIPE_PRICE_TEAM_ANNUAL`

### Stripe top-up prices
- `STRIPE_PRICE_PACK_10K`
- `STRIPE_PRICE_PACK_25K`
- `STRIPE_PRICE_PACK_50K`
- `STRIPE_PRICE_PACK_100K`
- `STRIPE_PRICE_PACK_250K`
- `STRIPE_PRICE_PACK_500K`

### Off-host backups
- `BACKUP_S3_URI`
- `BACKUP_S3_ENDPOINT` only when the bucket is not AWS S3.
- `AWS_DEFAULT_REGION` when required by the S3-compatible provider.

## OAuth callback URLs

Configure these in the external OAuth applications themselves.

### Google
- `https://orvyn.virphoneusa.com/api/v1/auth/oauth/google/callback`
- `https://app.kernelailabs.com/api/v1/auth/oauth/google/callback` if the Kernel AI app hostname will be used.

### GitHub
- `https://orvyn.virphoneusa.com/api/v1/auth/oauth/github/callback`
- `https://app.kernelailabs.com/api/v1/auth/oauth/github/callback` if the Kernel AI app hostname will be used.

## What CI now enforces

Before deployment, GitHub Actions fails if production is missing:
- Google and GitHub OAuth IDs/secrets
- SMTP configuration
- ORVYN public origin
- Stripe secret/webhook secret
- all Starter/Pro/Power/Business/Team monthly + annual Stripe Price IDs
- all six Stripe credit-pack Price IDs
- off-host backup destination + encryption/access credentials

The gate prints only configuration **names** and whether they are present. It never prints secret values.
