// Small JSON API for the admin web page. Protected by ADMIN_PASSWORD.

import { config } from "../_shared/config.ts";
import { currentKnowledge, db, loadSettings, pauseBot, saveKnowledge, saveMessage, undoKnowledge } from "../_shared/db.ts";
import { sendText } from "../_shared/whatsapp.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-admin-password, authorization, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

function passwordOk(given: string | null): boolean {
  const expected = config.adminPassword;
  if (!given || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  await loadSettings();
  if (!passwordOk(req.headers.get("x-admin-password"))) return json({ error: "Wrong password" }, 401);

  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  try {
    switch (action) {
      case "knowledge": {
        const k = await currentKnowledge();
        const { data: history } = await db().from("knowledge_versions")
          .select("id, summary, source, created_at").order("id", { ascending: false }).limit(15);
        return json({ content: k.content, history });
      }
      case "save": {
        const content = String(body.content ?? "").trim();
        if (!content) return json({ error: "Empty content" }, 400);
        const id = await saveKnowledge(content, String(body.summary || "Edited on the admin page"), "web");
        return json({ ok: true, id });
      }
      case "undo":
        return json({ undone: await undoKnowledge() });
      case "chats": {
        const { data, error } = await db().from("contacts")
          .select("wa_id, name, bot_paused_until, last_customer_msg_at")
          .order("last_customer_msg_at", { ascending: false, nullsFirst: false }).limit(100);
        if (error) throw error;
        const admins = new Set(config.adminNumbers);
        return json({ chats: (data ?? []).filter((c) => !admins.has(c.wa_id)) });
      }
      case "messages": {
        const wa_id = url.searchParams.get("wa_id") ?? "";
        const { data, error } = await db().from("messages")
          .select("direction, sender, type, body, created_at").eq("wa_id", wa_id)
          .order("created_at", { ascending: false }).limit(100);
        if (error) throw error;
        return json({ messages: (data ?? []).reverse() });
      }
      case "pause": {
        const hours = body.hours === null ? null : Number(body.hours);
        await pauseBot(String(body.wa_id), hours);
        return json({ ok: true });
      }
      case "send": {
        // Dawn replies by hand. WhatsApp only allows free-form replies within
        // 24 hours of the customer's last message.
        const wa_id = String(body.wa_id ?? "");
        const text = String(body.text ?? "").trim();
        if (!wa_id || !text) return json({ error: "Missing wa_id or text" }, 400);
        const ids = await sendText(wa_id, text);
        for (const id of ids) {
          await saveMessage({ wa_id, wa_message_id: id, direction: "out", sender: "owner", body: text });
        }
        await pauseBot(wa_id, config.ownerPauseHours);
        return json({ ok: true });
      }
      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
