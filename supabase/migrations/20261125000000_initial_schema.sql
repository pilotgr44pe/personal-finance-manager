create table if not exists public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  theme text not null default 'light' check (theme in ('light', 'dark', 'ocean', 'lavender', 'sunset')),
  legacy_imported boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.user_settings
  add column if not exists legacy_imported boolean not null default false;

create table if not exists public.transactions (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  name text not null check (char_length(name) between 1 and 70),
  amount numeric(12, 2) not null check (amount > 0),
  type text not null check (type in ('expense', 'bill', 'subscription', 'income')),
  category text not null check (char_length(category) between 1 and 80),
  payment_method text not null default 'Other',
  date date not null,
  note text not null default '' check (char_length(note) <= 160),
  receipt_path text,
  receipt_name text,
  receipt_type text,
  created_at timestamptz not null default now(),
  primary key (user_id, id),
  check (
    (receipt_path is null and receipt_name is null and receipt_type is null)
    or (receipt_path is not null and receipt_name is not null and receipt_type is not null)
  )
);

create index if not exists transactions_user_date_idx
  on public.transactions (user_id, date desc);

create table if not exists public.recurring_payments (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  name text not null check (char_length(name) between 1 and 70),
  amount numeric(12, 2) not null check (amount > 0),
  type text not null check (type in ('bill', 'subscription')),
  category text not null check (char_length(category) between 1 and 80),
  payment_method text not null default 'Other',
  next_due date not null,
  frequency text not null check (frequency in ('weekly', 'monthly', 'quarterly', 'yearly')),
  day_of_month smallint not null check (day_of_month between 1 and 31),
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists recurring_payments_user_due_idx
  on public.recurring_payments (user_id, next_due);

revoke all on public.user_settings, public.transactions, public.recurring_payments from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.user_settings to authenticated;
grant select, insert, update, delete on public.transactions to authenticated;
grant select, insert, update, delete on public.recurring_payments to authenticated;

alter table public.user_settings enable row level security;
alter table public.transactions enable row level security;
alter table public.recurring_payments enable row level security;

drop policy if exists "Users manage their own settings" on public.user_settings;
create policy "Users manage their own settings"
  on public.user_settings for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage their own transactions" on public.transactions;
create policy "Users manage their own transactions"
  on public.transactions for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage their own recurring payments" on public.recurring_payments;
create policy "Users manage their own recurring payments"
  on public.recurring_payments for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipts',
  'receipts',
  false,
  10485760,
  array[
    'application/pdf',
    'image/avif',
    'image/bmp',
    'image/gif',
    'image/heic',
    'image/heif',
    'image/jpeg',
    'image/png',
    'image/tiff',
    'image/webp'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users read their own receipts" on storage.objects;
create policy "Users read their own receipts"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

drop policy if exists "Users upload their own receipts" on storage.objects;
create policy "Users upload their own receipts"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

drop policy if exists "Users update their own receipts" on storage.objects;
create policy "Users update their own receipts"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  )
  with check (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

drop policy if exists "Users delete their own receipts" on storage.objects;
create policy "Users delete their own receipts"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );
