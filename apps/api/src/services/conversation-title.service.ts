import type { ModelConfig } from "../catalog/llm-models";
import type { ChatMessage } from "../types/chat";
import { chatOnce } from "./agent/provider.service";
import { stripAttachmentNotes } from "./agent/model-runtime-policy";
import { logger } from "../lib/logger";

/**
 * Conversation titles: one small model call, after the first turn, that names
 * the conversation.
 *
 * The conversation row is created with the first user message as the title, so
 * the sidebar is never blank; this service replaces that raw text with a short
 * title shortly after. Fired and never awaited — a run that answered must not
 * hold its stream open for a metadata job, and a title failure must not be
 * reported as a run failure. The same fire-and-forget shape as the playbook
 * reflector, for the same reasons.
 *
 * Titles are generated once per conversation, from the first turn only: later
 * turns drift the subject, and a title that keeps rewriting itself is worse
 * than a stable one that is slightly stale.
 */

/** Enough of the first turn to name a conversation, small enough to be cheap. */
const PROMPT_CHAR_CAP = 2000;

const SYSTEM_PROMPT = `You write the title for a conversation with an AI assistant.
Reply with a concise title of 3 to 6 words describing the primary topic of the conversation.
Do not use quotation marks. Do not end with punctuation. Do not prefix with anything.
Return only the title text and nothing else.`;

export type TitleInput = {
  workspaceId: string;
  conversationId: string;
  model: ModelConfig;
  /** The turn that opened the conversation. */
  history: ChatMessage[];
  signal?: AbortSignal;
};

export type TitleStore = {
  setTitle(
    conversationId: string,
    workspaceId: string,
    title: string,
  ): Promise<boolean>;
};

export async function generateTitle(
  input: TitleInput,
  store: TitleStore,
  chat: typeof chatOnce = chatOnce,
): Promise<string | null> {
  const { workspaceId, conversationId, model, history, signal } = input;

  const firstUser = [...history]
    .reverse()
    .find((message) => message.role === "user");
  if (!firstUser) return null;

  const prompt = stripAttachmentNotes(firstUser.content ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PROMPT_CHAR_CAP);
  if (!prompt) return null;

  let text: string;
  try {
    const reply = await chat(
      model,
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      [],
      signal,
    );
    text = reply.text ?? "";
  } catch (e: any) {
    logger.warn("conversation.title_failed", {
      workspaceId,
      conversation: conversationId,
      message: e?.message ?? String(e),
    });
    return null;
  }

  const title = normaliseTitle(text);
  if (!title) {
    logger.warn("conversation.title_unparsed", {
      workspaceId,
      conversation: conversationId,
      preview: text.slice(0, 120),
    });
    return null;
  }

  const applied = await store.setTitle(conversationId, workspaceId, title).catch((e: any) => {
    logger.warn("conversation.title_store_failed", {
      workspaceId,
      conversation: conversationId,
      message: e?.message ?? String(e),
    });
    return false;
  });
  if (applied) {
    logger.info("conversation.titled", { workspaceId, conversation: conversationId, title });
    return title;
  }
  return null;
}

/**
 * Keep the model's words, drop its packaging. Quotes, a trailing period, a
 * `Title:` prefix — the small failure modes of a one-line reply.
 */
export function normaliseTitle(text: string): string {
  let title = text.trim();
  title = title.replace(/^(?:title|heading)\s*:\s*/i, "");
  title = title.replace(/^["'“”«»]+|["'“”«».!?]+$/g, "");
  title = title.replace(/\s+/g, " ").trim();
  if (!title) return "";
  return title.slice(0, 80);
}
