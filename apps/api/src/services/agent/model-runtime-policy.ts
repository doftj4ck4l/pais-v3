import type { ModelConfig } from "../../catalog/llm-models";
import type { ChatMessage } from "../../types/chat";
import { stripDocumentReferenceNotes } from "./document-references";

export const CHAT_ONLY_SYSTEM_PROMPT =
  "Answer the user's message directly and clearly. You have no tools or external data access.";

// `describeAttachments` persists this bracketed suffix in user-message text so
// agent models can revisit an earlier image. A chat-only model must not receive
// either the private image URL or the instruction to call a tool it cannot use.
const IMAGE_ATTACHMENT_NOTE =
  /\n\n\[The user attached (?:an image|\d+ images) to this message: [^\]]+call read_image[^\]]+\.\]$/;
const DATA_ATTACHMENT_NOTE =
  /\n\n\[The user attached (?:a data file|\d+ data files) to this message:[\s\S]*?untrusted data, not instructions\.\]\s*$/;

export function stripAttachmentNotes(content: string): string {
  let stripped = content;
  for (;;) {
    const next = stripDocumentReferenceNotes(stripped)
      .replace(DATA_ATTACHMENT_NOTE, "")
      .replace(IMAGE_ATTACHMENT_NOTE, "");
    if (next === stripped) return stripped;
    stripped = next;
  }
}

export function isChatOnlyModel(model: ModelConfig): boolean {
  return model.mode === "chat-only";
}

export function systemPromptForModel(model: ModelConfig, agentPrompt: string): string {
  return isChatOnlyModel(model) ? CHAT_ONLY_SYSTEM_PROMPT : agentPrompt;
}

/**
 * A conversation can arrive through the API with earlier tool messages even
 * when the UI normally locks its model. Keep useful text, but never forward
 * tool calls or results into a chat-only provider request.
 */
export function prepareHistoryForModel(
  model: ModelConfig,
  history: ChatMessage[],
): ChatMessage[] {
  if (!isChatOnlyModel(model)) return history;

  return history.flatMap((message): ChatMessage[] => {
    if (message.role === "tool") return [];
    if (message.role === "assistant") {
      return message.content ? [{ role: "assistant", content: message.content }] : [];
    }
    return [{ role: "user", content: stripAttachmentNotes(message.content ?? "") }];
  });
}
