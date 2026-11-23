// All settings come from Supabase secrets (Dashboard > Edge Functions > Secrets).

// Non-secret settings can also live in the `settings` table (see loadSettings).
// A Supabase secret with the same name always wins.
let dbSettings: Record<string, string> = {};
export function setDbSettings(s: Record<string, string>) { dbSettings = s; }

function get(name: string): string | undefined {
  return Deno.env.get(name) || dbSettings[name] || undefined;
}

function env(name: string, fallback?: string): string {
  const v = get(name) ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing secret: ${name}`);
  return v;
}

/** Digits only, e.g. "+6019-780 7916" -> "60197807916". */
export function normalizeNumber(n: string): string {
  return n.replace(/\D/g, "");
}

export const config = {
  get supabaseUrl() { return env("SUPABASE_URL"); },
  get serviceRoleKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); },

  // Meta / WhatsApp Cloud API
  get waToken() { return env("WHATSAPP_TOKEN"); },
  get waPhoneNumberId() { return env("WHATSAPP_PHONE_NUMBER_ID"); },
  get waAppSecret() { return env("WHATSAPP_APP_SECRET"); },
  get waVerifyToken() { return env("WHATSAPP_VERIFY_TOKEN"); },
  get graphVersion() { return env("GRAPH_API_VERSION", "v24.0"); },

  // Claude
  get anthropicKey() { return env("ANTHROPIC_API_KEY"); },
  get model() { return env("CLAUDE_MODEL", "claude-opus-5-5"); },

  // Business
  get businessName() { return env("BUSINESS_NAME", "our shop"); },
  get ownerName() { return env("OWNER_NAME", "Dawn"); },
  /** Personal numbers allowed to update the bot by WhatsApp, comma separated. */
  get adminNumbers(): string[] {
    return (get("ADMIN_NUMBERS") ?? "")
      .split(",").map(normalizeNumber).filter(Boolean);
  },
  /** How long the bot stays quiet in a chat after Dawn replies there herself. */
  get ownerPauseHours() { return Number(env("OWNER_PAUSE_HOURS", "12")); },
  get adminPassword() { return env("ADMIN_PASSWORD"); },
};
