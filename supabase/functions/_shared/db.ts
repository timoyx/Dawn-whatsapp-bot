import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { config, setDbSettings } from "./config.ts";

let client: SupabaseClient | null = null;
export function db(): SupabaseClient {
  client ??= createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false },
  });
  return client;
}

export type Sender = "customer" | "bot" | "owner" | "admin";

export interface StoredMessage {
  wa_id: string;
  wa_message_id?: string | null;
  direction: "in" | "out";
  sender: Sender;
  type?: string;
  body: string | null;
}

export async function upsertContact(wa_id: string, name?: string | null, fromCustomer = false) {
  const row: Record<string, unknown> = { wa_id };
  if (name) row.name = name;
  if (fromCustomer) row.last_customer_msg_at = new Date().toISOString();
  const { error } = await db().from("contacts").upsert(row, { onConflict: "wa_id" });
  if (error) throw error;
}

/** Returns false if this WhatsApp message id was already stored (webhook retry). */
export async function saveMessage(m: StoredMessage): Promise<boolean> {
  const { error } = await db().from("messages").insert({ type: "text", ...m });
  if (error) {
    if (error.code === "23505") return false; // duplicate wa_message_id
    throw error;
  }
  return true;
}

export async function recentMessages(wa_id: string, limit = 12) {
  const { data, error } = await db()
    .from("messages")
    .select("direction, sender, body, created_at")
    .eq("wa_id", wa_id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).reverse();
}

export async function isPaused(wa_id: string): Promise<boolean> {
  const { data, error } = await db()
    .from("contacts").select("bot_paused_until").eq("wa_id", wa_id).maybeSingle();
  if (error) throw error;
  const until = data?.bot_paused_until ? new Date(data.bot_paused_until) : null;
  return !!until && until.getTime() > Date.now();
}

export async function pauseBot(wa_id: string, hours: number | null) {
  const until = hours ? new Date(Date.now() + hours * 3600_000).toISOString() : null;
  const { error } = await db()
    .from("contacts").upsert({ wa_id, bot_paused_until: until }, { onConflict: "wa_id" });
  if (error) throw error;
}

export async function currentKnowledge(): Promise<{ id: number; content: string }> {
  const { data, error } = await db()
    .from("knowledge_versions").select("id, content")
    .order("id", { ascending: false }).limit(1).single();
  if (error) throw error;
  return data;
}

export async function saveKnowledge(content: string, summary: string, source: "web" | "whatsapp" | "undo") {
  const { data, error } = await db()
    .from("knowledge_versions").insert({ content, summary, source })
    .select("id").single();
  if (error) throw error;
  return data.id as number;
}

/** Restores the version before the latest one. Returns null if there is nothing to undo. */
export async function undoKnowledge(): Promise<string | null> {
  const { data, error } = await db()
    .from("knowledge_versions").select("id, content, summary")
    .order("id", { ascending: false }).limit(2);
  if (error) throw error;
  if (!data || data.length < 2) return null;
  const [latest, previous] = data;
  await saveKnowledge(previous.content, `Undid: ${latest.summary ?? "last change"}`, "undo");
  return latest.summary ?? "last change";
}

let settingsLoadedAt = 0;
/** Loads the `settings` table into config (cached for a minute). */
export async function loadSettings() {
  if (Date.now() - settingsLoadedAt < 60_000) return;
  const { data, error } = await db().from("settings").select("key, value");
  if (error) throw error;
  setDbSettings(Object.fromEntries((data ?? []).map((r) => [r.key, r.value])));
  settingsLoadedAt = Date.now();
}

export async function saveSetting(key: string, value: string) {
  const { error } = await db().from("settings")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
  settingsLoadedAt = 0;
}
