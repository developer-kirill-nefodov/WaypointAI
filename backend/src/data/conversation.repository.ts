import { Op } from "sequelize";
import type { ChatMessage } from "../llm/ollama.provider.js";
import { database } from "../database/client.js";
import { Conversation, type ConversationMessage } from "../models/conversation.js";
import { initModels } from "../models/index.js";

const MAX_CONVERSATIONS_PER_WORKSPACE = 100;
const MAX_HISTORY_MESSAGES = 12;
const CONVERSATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

initModels();

export async function getConversationMessages(id: string, workspaceId: string): Promise<ChatMessage[]> {
  await database.authenticate();
  const conversation = await Conversation.findOne({
    where: { id, workspaceId, expiresAt: { [Op.gt]: new Date() } },
    attributes: ["messages"],
  });
  return (conversation?.messages ?? []).map(({ role, content }) => ({ role, content }));
}

export async function saveConversationTurn(id: string, workspaceId: string, messages: ChatMessage[]): Promise<void> {
  await database.authenticate();
  const now = new Date();
  const filteredMessages: ConversationMessage[] = messages.flatMap((message) =>
    (message.role === "user" || message.role === "assistant") && !message.tool_calls
      ? [{ role: message.role, content: message.content.slice(0, 4000) }]
      : [],
  );
  const safeMessages = filteredMessages.length <= MAX_HISTORY_MESSAGES
    ? filteredMessages
    : [filteredMessages[0]!, ...filteredMessages.slice(-(MAX_HISTORY_MESSAGES - 1))];

  await database.transaction(async (transaction) => {
    await Conversation.destroy({ where: { workspaceId, expiresAt: { [Op.lte]: now } }, transaction });
    const current = await Conversation.findOne({ where: { id, workspaceId }, transaction });
    if (!current) {
      const count = await Conversation.count({ where: { workspaceId }, transaction });
      if (count >= MAX_CONVERSATIONS_PER_WORKSPACE) {
        const oldest = await Conversation.findOne({ where: { workspaceId }, order: [["updatedAt", "ASC"]], transaction });
        await oldest?.destroy({ transaction });
      }
      await Conversation.create({ id, workspaceId, messages: safeMessages, expiresAt: new Date(now.getTime() + CONVERSATION_TTL_MS) }, { transaction });
      return;
    }
    current.messages = safeMessages;
    current.expiresAt = new Date(now.getTime() + CONVERSATION_TTL_MS);
    await current.save({ transaction });
  });
}

export async function clearConversationHistory(workspaceId: string): Promise<void> {
  await database.authenticate();
  await Conversation.destroy({ where: { workspaceId } });
}

export async function hasConversation(id: string, workspaceId: string): Promise<boolean> {
  await database.authenticate();
  return Boolean(await Conversation.findOne({ where: { id, workspaceId, expiresAt: { [Op.gt]: new Date() } }, attributes: ["id"] }));
}
