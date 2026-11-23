import { decodeBase64, encodeBase64 } from "jsr:@std/encoding@1.0.10/base64";
import { config } from "./config.ts";

const graph = (path: string) => `https://graph.facebook.com/${config.graphVersion}/${path}`;

async function graphFetch(url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.waToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`WhatsApp API ${res.status}: ${await res.text()}`);
  }
  return res;
}

/** WhatsApp caps a text message at 4096 characters. */
export function chunk(text: string, max = 4000): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Sends a text and returns the WhatsApp message id(s). */
export async function sendText(to: string, body: string): Promise<string[]> {
  const ids: string[] = [];
  for (const part of chunk(body)) {
    const res = await graphFetch(graph(`${config.waPhoneNumberId}/messages`), {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: part, preview_url: false },
      }),
    });
    const json = await res.json();
    ids.push(json.messages?.[0]?.id);
  }
  return ids;
}

/** Shows blue ticks and a "typing…" bubble while the bot thinks. Best effort. */
export async function markReadAndTyping(messageId: string) {
  try {
    await graphFetch(graph(`${config.waPhoneNumberId}/messages`), {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      }),
    });
  } catch (e) {
    console.warn("mark read failed", e);
  }
}

/** Downloads an image a user sent, as base64 for Claude. */
export async function downloadMedia(mediaId: string): Promise<{ data: string; mimeType: string }> {
  const meta = await (await graphFetch(graph(mediaId))).json();
  const file = await graphFetch(meta.url, { headers: { "Content-Type": "" } });
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { data: encodeBase64(bytes), mimeType: meta.mime_type ?? "image/jpeg" };
}

/** Re-uploads an image (e.g. a customer's screenshot) and sends it to someone else. */
export async function forwardImage(to: string, image: { data: string; mimeType: string }, caption: string) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", image.mimeType);
  form.append("file", new Blob([decodeBase64(image.data)], { type: image.mimeType }), "screenshot");
  const up = await fetch(graph(`${config.waPhoneNumberId}/media`), {
    method: "POST",
    headers: { Authorization: `Bearer ${config.waToken}` },
    body: form,
  });
  if (!up.ok) throw new Error(`WhatsApp media upload ${up.status}: ${await up.text()}`);
  const { id } = await up.json();
  await graphFetch(graph(`${config.waPhoneNumberId}/messages`), {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "image",
      image: { id, caption: caption.slice(0, 1000) },
    }),
  });
}

/** Checks Meta's X-Hub-Signature-256 header so only Meta can call the webhook. */
export async function verifySignature(rawBody: string, header: string | null): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(config.waAppSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  const expected = Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** Links the WhatsApp Business Account to this app so Meta forwards live
 *  messages to our webhook (POST /{waba-id}/subscribed_apps). */
export async function subscribeWaba(wabaId: string) {
  const res = await graphFetch(graph(`${wabaId}/subscribed_apps`), { method: "POST" });
  return await res.json();
}
