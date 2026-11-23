-- Dawn WhatsApp bot: core schema
-- All tables are private: RLS on, no policies. Only the edge functions
-- (service role key) read and write them.

create table if not exists contacts (
  wa_id               text primary key,          -- customer's WhatsApp number, digits only
  name                text,
  bot_paused_until    timestamptz,               -- bot stays quiet for this customer until then
  last_customer_msg_at timestamptz,
  created_at          timestamptz not null default now()
);

create table if not exists messages (
  id             bigint generated always as identity primary key,
  wa_id          text not null references contacts(wa_id) on delete cascade,
  wa_message_id  text unique,                     -- Meta's id; unique so webhook retries are ignored
  direction      text not null check (direction in ('in', 'out')),
  sender         text not null check (sender in ('customer', 'bot', 'owner', 'admin')),
  type           text not null default 'text',
  body           text,
  created_at     timestamptz not null default now()
);
create index if not exists messages_wa_id_created_idx on messages (wa_id, created_at desc);

-- What the bot knows: one plain-text document Dawn can edit.
-- Every change is a new row, so UNDO and history are free.
create table if not exists knowledge_versions (
  id          bigint generated always as identity primary key,
  content     text not null,
  summary     text,                               -- what changed, in plain words
  source      text not null default 'web' check (source in ('seed', 'web', 'whatsapp', 'undo')),
  created_at  timestamptz not null default now()
);

alter table contacts enable row level security;
alter table messages enable row level security;
alter table knowledge_versions enable row level security;

insert into knowledge_versions (content, summary, source)
select $$# Business info
(Not filled in yet. Dawn can send updates by WhatsApp from her admin number, or edit this on the admin page.)

## Booking
Customers book through the Jacar app: browse a service, pick the nearest outlet, pick a time slot, confirm and check out.
$$, 'Starting template', 'seed'
where not exists (select 1 from knowledge_versions);
