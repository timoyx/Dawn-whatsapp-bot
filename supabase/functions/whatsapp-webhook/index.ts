// WhatsApp Cloud API webhook.
// GET  = Meta's one-time verification handshake.
// POST = incoming messages, status updates, and (with coexistence) echoes of
//        messages Dawn sends herself from the WhatsApp Business app.

import { config, normalizeNumber } from "../_shared/config.ts";
import {
  currentKnowledge, isPaused, loadSettings, pauseBot, recentMessages, saveKnowledge,
  saveMessage, saveSetting, undoKnowledge, upsertContact,
} from "../_shared/db.ts";
import { answerCustomer, applyUpdate } from "../_shared/ai.ts";
import { downloadMedia, forwardImage, markReadAndTyping, sendText, subscribeWaba, verifySignature } from "../_shared/whatsapp.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

// ---------------------------------------------------------------- types (subset of Meta's payload)

interface WaMessage {
  from: string;
  to?: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type?: string; caption?: string };
  document?: { caption?: string; filename?: string };
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
  button?: { text: string };
  location?: { name?: string; address?: string };
}

interface WaChangeValue {
  contacts?: { wa_id: string; profile?: { name?: string } }[];
  messages?: WaMessage[];
  message_echoes?: WaMessage[];
  statuses?: { id: string; status: string; recipient_id: string; errors?: unknown[] }[];
}

// ---------------------------------------------------------------- helpers

/** Plain-text view of any message type, for storage and for Claude. */
function describe(m: WaMessage): string {
  switch (m.type) {
    case "text": return m.text?.body ?? "";
    case "image": return `[photo]${m.image?.caption ? " " + m.image.caption : ""}`;
    case "interactive": return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "[button]";
    case "button": return m.button?.text ?? "[button]";
    case "location": return `[location] ${m.location?.name ?? ""} ${m.location?.address ?? ""}`.trim();
    case "document": return `[file] ${m.document?.filename ?? ""} ${m.document?.caption ?? ""}`.trim();
    case "audio": return "[voice note]";
    case "video": return "[video]";
    case "sticker": return "[sticker]";
    default: return `[${m.type}]`;
  }
}

async function reply(to: string, body: string, sender: "bot" | "admin" = "bot") {
  const ids = await sendText(to, body);
  for (const id of ids) {
    await saveMessage({ wa_id: to, wa_message_id: id, direction: "out", sender, body });
  }
}

/** Tell Dawn's admin number(s) a customer needs her. Free-form messages only
 *  arrive if she has messaged the bot in the last 24h, so failures are expected. */
async function notifyAdmins(text: string, image?: { data: string; mimeType: string }) {
  for (const admin of config.adminNumbers) {
    try {
      if (image) await forwardImage(admin, image, text);
      else await sendText(admin, text);
    } catch (e) { console.warn("admin notify failed", admin, e); }
  }
}

// ---------------------------------------------------------------- admin (Dawn's personal number)

const HELP = `Commands:
• Send any update, e.g. "Tinting promo RM299 until 31 Dec" or a photo of a price list
• UNDO: undo the last change
• INFO: show everything the bot knows
• TEST <question>: see how the bot would answer a customer
• RESUME <customer number>: turn the bot back on for that customer
• PAUSE <customer number>: stop the bot for that customer`;

async function handleAdmin(m: WaMessage) {
  const from = m.from;
  const text = (m.type === "image" ? m.image?.caption : m.text?.body)?.trim() ?? "";
  const cmd = text.split(/\s+/)[0]?.toUpperCase() ?? "";
  const arg = text.slice(cmd.length).trim();

  if (cmd === "HELP" || cmd === "?") return reply(from, HELP, "admin");

  if (cmd === "UNDO") {
    const undone = await undoKnowledge();
    return reply(from, undone ? `↩️ Undone: ${undone}` : "Nothing to undo.", "admin");
  }

  if (cmd === "INFO") {
    const k = await currentKnowledge();
    return reply(from, `📋 What the bot knows now:\n\n${k.content}`, "admin");
  }

  if (cmd === "TEST" && arg) {
    const k = await currentKnowledge();
    const r = await answerCustomer(k.content, [], arg);
    const out = r
      ? `🤖 Bot would reply:\n\n${r.reply}${r.handoff ? `\n\n(Would hand over to you: ${r.handoff_reason})` : ""}`
      : "The AI didn't give an answer. Try rephrasing.";
    return reply(from, out, "admin");
  }

  if ((cmd === "RESUME" || cmd === "PAUSE") && arg) {
    const customer = normalizeNumber(arg);
    await pauseBot(customer, cmd === "PAUSE" ? 24 * 30 : null);
    return reply(from, cmd === "PAUSE"
      ? `⏸️ Bot paused for ${customer} (30 days, or until RESUME).`
      : `▶️ Bot is back on for ${customer}.`, "admin");
  }

  // Anything else: treat it as an update to the business info.
  const image = m.type === "image" && m.image ? await downloadMedia(m.image.id) : undefined;
  if (!text && !image) return reply(from, HELP, "admin");

  const k = await currentKnowledge();
  const u = await applyUpdate(k.content, text, image);
  if (!u) return reply(from, "Sorry, I couldn't process that. Please try again or rephrase.", "admin");
  if (!u.is_update || !u.new_content.trim()) return reply(from, u.reply || HELP, "admin");

  await saveKnowledge(u.new_content, u.summary, "whatsapp");
  return reply(from, `✅ Updated: ${u.summary}\n\nReply UNDO to undo, or INFO to see everything.`, "admin");
}

// ---------------------------------------------------------------- customers

async function handleCustomer(m: WaMessage) {
  const from = m.from;
  if (await isPaused(from)) return; // Dawn is handling this chat

  await markReadAndTyping(m.id);
  const k = await currentKnowledge();
  const history = await recentMessages(from, 12);
  // The latest message is already stored; don't send it twice.
  const earlier = history.slice(0, -1);
  // Let the AI see photos (e.g. a screenshot of a booking in the Jacar app).
  let image: { data: string; mimeType: string } | undefined;
  if (m.type === "image" && m.image) {
    try { image = await downloadMedia(m.image.id); } catch (e) { console.warn("download failed", e); }
  }
  const r = await answerCustomer(k.content, earlier, describe(m), image);

  if (!r) {
    await reply(from, `Thanks for your message! ${config.ownerName} will get back to you shortly. 🙏`);
    await pauseBot(from, config.ownerPauseHours);
    await notifyAdmins(`🔔 Customer +${from} needs you (the bot couldn't answer): "${describe(m)}"`, image);
    return;
  }

  await reply(from, r.reply);
  if (r.handoff) {
    await pauseBot(from, config.ownerPauseHours);
    await notifyAdmins(`🔔 Customer +${from} needs you: ${r.handoff_reason}\nThey said: "${describe(m)}"\nThe bot is paused for them for ${config.ownerPauseHours}h. Send RESUME ${from} to turn it back on.`, image);
  }
}

// ---------------------------------------------------------------- dispatch

async function processPayload(payload: { object?: string; entry?: { changes?: { field: string; value: WaChangeValue }[] }[] }) {
  if (payload.object !== "whatsapp_business_account") return;
  const admins = new Set(config.adminNumbers);

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;

      // Incoming messages (from customers, or from Dawn's admin number)
      if (change.field === "messages" && v.messages) {
        for (const m of v.messages) {
          const name = v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name;
          const isAdmin = admins.has(normalizeNumber(m.from));
          await upsertContact(m.from, name, !isAdmin);
          const isNew = await saveMessage({
            wa_id: m.from, wa_message_id: m.id, direction: "in",
            sender: isAdmin ? "admin" : "customer", type: m.type, body: describe(m),
          });
          if (!isNew) continue; // Meta retried a message we already handled
          try {
            if (isAdmin) await handleAdmin(m);
            else await handleCustomer(m);
          } catch (e) {
            console.error("handling failed", m.id, e);
          }
        }
      }

      // Coexistence: Dawn replied from the WhatsApp Business app on her phone.
      // Store it, and pause the bot for that customer so they don't both talk.
      // Delivery receipts. Log failures so we can see why a reply didn't arrive.
      for (const st of v.statuses ?? []) {
        if (st.status === "failed") {
          console.error("delivery failed", st.recipient_id, JSON.stringify(st.errors));
        } else {
          console.log("status", st.status, st.recipient_id);
        }
      }

      if (change.field === "smb_message_echoes" && v.message_echoes) {
        for (const m of v.message_echoes) {
          const customer = m.to;
          if (!customer) continue;
          await upsertContact(customer);
          const isNew = await saveMessage({
            wa_id: customer, wa_message_id: m.id, direction: "out",
            sender: "owner", type: m.type, body: describe(m),
          });
          if (isNew) await pauseBot(customer, config.ownerPauseHours);
        }
      }
    }
  }
}

/** One-time: make sure Meta forwards live messages for this WhatsApp account. */
async function ensureSubscribed() {
  const waba = config.wabaId;
  if (!waba || config.wabaSubscribed) return;
  try {
    const result = await subscribeWaba(waba);
    console.log("subscribed_apps", JSON.stringify(result));
    if (result?.success) await saveSetting("WABA_SUBSCRIBED", "yes");
  } catch (e) {
    console.error("subscribed_apps failed", e);
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  await loadSettings();
  EdgeRuntime.waitUntil(ensureSubscribed());

  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" &&
      url.searchParams.get("hub.verify_token") === config.waVerifyToken;
    return ok
      ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 })
      : new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const raw = await req.text();
  if (!(await verifySignature(raw, req.headers.get("x-hub-signature-256")))) {
    return new Response("Bad signature", { status: 401 });
  }

  let payload;
  try { payload = JSON.parse(raw); } catch { return new Response("Bad JSON", { status: 400 }); }

  // Answer Meta within its timeout; do the slow work (AI, replies) in the background.
  EdgeRuntime.waitUntil(processPayload(payload).catch((e) => console.error("webhook error", e)));
  return new Response("OK", { status: 200 });
});
