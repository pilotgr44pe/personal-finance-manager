# Moneta

Moneta is a personal finance manager for tracking purchases, bills, subscriptions, and income. It uses Supabase Authentication, PostgreSQL, and private object storage, with a static frontend and a small Vercel configuration endpoint.

## Features

- Public landing page introducing Moneta, with direct sign-in and account creation links.
- Email and password sign-up, sign-in, email confirmation, and password reset.
- Private per-account transactions, recurring payments, currency, and theme preferences.
- Private image and PDF receipt uploads (up to 10 MB per file).
- Monthly summaries, spending breakdowns, recurring due dates, and transaction filters.
- JSON backups that include receipt files; restore backups from the signed-in app.
- Light, dark, ocean, lavender, and sunset themes.

## Deploy to Vercel

1. Create a Supabase project.
2. In the Supabase SQL Editor, run [`supabase/migrations/20261125000000_initial_schema.sql`](./supabase/migrations/20261125000000_initial_schema.sql). It creates the tables, indexes, private receipt bucket, and row-level security policies.
3. In Supabase **Authentication → URL Configuration**, set the production Site URL and add your Vercel production and preview URLs to the allowed redirect URLs. Keep email confirmation enabled; configure a custom SMTP provider before inviting real users.
4. Import this GitHub repository into Vercel.
5. Add these Vercel environment variables for Production, Preview, and Development, then redeploy:
   - `SUPABASE_URL` — the project URL.
   - `SUPABASE_ANON_KEY` — the project’s publishable/anon key.

   The `/api/config` endpoint returns only those public client settings. **Never add a Supabase service-role key, database password, or other secret to the frontend or these variables.** Database and receipt access is restricted by the included row-level security and storage policies.
6. Open the deployed site and choose **Get started** to create an account, then confirm the email address. If the previous local Moneta data is available in that browser origin, the app offers a one-time import. Otherwise, sign in and use **Import a Moneta backup** to restore a JSON backup.

The app is not ready for real accounts until the SQL migration, Supabase Auth URL settings, and Vercel environment variables are configured.

## Local development

Install Node.js and the Vercel CLI, link the project with `vercel link`, pull local environment variables with `vercel env pull .env.local`, then run:

```sh
vercel dev
```

Use the local URL printed by Vercel. Opening `index.html` directly with `file://` is not supported because authentication and account data require the `/api/config` endpoint.

## Data and backups

Each account’s transactions, recurring payments, and preferences are stored in Supabase. Receipt files are stored in a private Supabase Storage bucket. RLS policies restrict database rows to the authenticated owner, and storage policies require receipt paths to be prefixed with that owner’s user ID.

Use **Export your data** regularly to download a JSON backup, including receipt files. Backups can contain sensitive financial information; keep them somewhere private. Importing a backup adds a copy of its entries to the signed-in account. The legacy local import leaves the old browser data untouched.

The previous local app’s v1 JSON export did not include receipt file contents. For those receipts to migrate automatically, the old browser storage must still be available to Moneta from the same origin.

Moneta does not connect to financial institutions or automatically move money.
