# Dawn's WhatsApp customer service bot

A WhatsApp bot on Meta's official **WhatsApp Cloud API** that answers customers
in English, Malay and Chinese, hands chats to Dawn when it should, and lets Dawn
update what it knows by simply WhatsApp-ing it.

```
Customer ──WhatsApp──▶ Meta Cloud API ──webhook──▶ Supabase Edge Function (whatsapp-webhook)
                                                     │  ├─ Claude writes the reply from the business info
                                                     │  └─ stores every message in Postgres
Dawn (admin number) ──WhatsApp "Update: …"──────────▶│  └─ Claude edits the business info, replies with what changed
Dawn (browser) ──▶ admin page (Vercel) ──▶ admin-api Edge Function: edit info, read chats, reply, pause/resume
```

## What it does

**For customers**
- Answers questions about services, prices, hours and booking from the business info only (never makes up prices).
- Replies in the customer's language (English, Bahasa Melayu, 中文, or a mix).
- Hands over to Dawn when it can't answer, the customer is unhappy, asks for a human, or it's about an existing booking/payment/damage. It tells the customer Dawn will reply, pauses itself for that chat, and pings Dawn's admin number.

**For Dawn, by WhatsApp** (from her admin number to the bot's number)
| Send | What happens |
|---|---|
| any update, e.g. `Tinting promo RM299 until 31 Dec`, `Closed 25 Dec`, or a **photo of a price list** | the bot updates its info and replies with exactly what changed |
| `UNDO` | undo the last change |
| `INFO` | show everything the bot knows |
| `TEST how much for coating a Myvi?` | see how the bot would answer a customer |
| `PAUSE 60123456789` / `RESUME 60123456789` | stop / restart the bot for one customer |
| `HELP` | list the commands |

**For Dawn, in the browser** (admin page): edit the full business info, see history and undo, read every chat, reply by hand, pause or resume the bot per customer. Replying by hand pauses the bot for that chat for `OWNER_PAUSE_HOURS` (default 12).

## Layout

```
supabase/
  migrations/…_init.sql          tables: contacts, messages, knowledge_versions
  functions/whatsapp-webhook/    Meta webhook (GET verify, POST messages)
  functions/admin-api/           JSON API for the admin page (password protected)
  functions/_shared/             config, database, WhatsApp API, Claude
admin/                           static admin page (index.html + config.js)
```

## Setup

The Supabase project (**Dawn WhatsApp Bot**, Singapore, ref `yqhuvxxbuvevmwejpjbr`) is already created, with the database tables and both functions deployed.

Webhook URL for Meta:
`https://yqhuvxxbuvevmwejpjbr.supabase.co/functions/v1/whatsapp-webhook`

### 1. Meta (WhatsApp Cloud API)

1. Go to <https://developers.facebook.com/apps> → **Create app** → use case **Connect with customers through WhatsApp** (type *Business*), and pick Dawn's business portfolio.
2. In the app: **WhatsApp → API Setup**. Add the bot's phone number (a number **not** currently registered on any WhatsApp app) and verify it by SMS/call. Note the **Phone number ID**.
3. Create a permanent token: **Business settings → Users → System users → Add** (Admin) → **Assign assets** (the app, full control; the WhatsApp account, full control) → **Generate token** with permissions `whatsapp_business_messaging` and `whatsapp_business_management`. This is `WHATSAPP_TOKEN`.
4. **App settings → Basic → App secret** → this is `WHATSAPP_APP_SECRET`.
5. **WhatsApp → Configuration → Webhook → Edit**: Callback URL = the webhook URL above, Verify token = any random phrase you choose (this is `WHATSAPP_VERIFY_TOKEN`). Set the secrets (step 2 below) **before** pressing Verify. Then **Manage** webhook fields and subscribe to `messages`.
6. Add a payment method in WhatsApp Manager. Replies to customers who message first are free; it's only needed for business-initiated templates.
7. Publish the app (App mode: Live) and complete **Business verification** when Meta asks for it.

### 2. Supabase secrets

Supabase dashboard → project **Dawn WhatsApp Bot** → **Edge Functions → Secrets**, add:

| Name | Value |
|---|---|
| `WHATSAPP_TOKEN` | system user token (step 1.3) |
| `WHATSAPP_PHONE_NUMBER_ID` | phone number ID (step 1.2) |
| `WHATSAPP_APP_SECRET` | app secret (step 1.4) |
| `WHATSAPP_VERIFY_TOKEN` | the phrase you chose (step 1.5) |
| `ANTHROPIC_API_KEY` | from <https://console.anthropic.com> → API keys |
| `ADMIN_NUMBERS` | Dawn's personal WhatsApp number(s), digits with country code, comma separated, e.g. `60123456789` |
| `ADMIN_PASSWORD` | a long password for the admin page |
| `BUSINESS_NAME` | the shop's name as customers know it |
| `OWNER_NAME` | optional, default `Dawn` |
| `OWNER_PAUSE_HOURS` | optional, default `12` |
| `CLAUDE_MODEL` | optional, default `claude-opus-5-5`; `claude-haiku-5-5` is much cheaper |

### 3. Fill in the business info

Either WhatsApp it to the bot from the admin number (text or screenshots of the price list), or paste it on the admin page.

### Notes

- **24-hour rule**: WhatsApp only allows free-form replies within 24 hours of the customer's last message. The bot always replies inside that window. Hand-off pings to Dawn's admin number only arrive if she has messaged the bot in the last 24h, so she should check the admin page's chat list too.
- **Costs**: Supabase free tier; Meta charges nothing for replies to customer-started chats; Claude is pay-as-you-go per message.
- **Coexistence** (the same number in the WhatsApp Business app *and* the API) is supported by the code (`smb_message_echoes` pauses the bot when Dawn replies from the app), but Meta only allows onboarding it through a Tech Provider / Solution Partner.

## Development

```
deno check supabase/functions/whatsapp-webhook/index.ts supabase/functions/admin-api/index.ts
supabase functions deploy whatsapp-webhook --no-verify-jwt
supabase functions deploy admin-api --no-verify-jwt
```
