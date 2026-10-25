import { Op } from "sequelize";
import type { TripPlan } from "@waypoint-ai/shared";
import type { ChatMessage } from "../llm/ollama.provider.js";
import { database } from "../database/client.js";
import { Conversation, type ConversationMessage } from "../models/conversation.js";
import { initModels } from "../models/index.js";

const MAX_CONVERSATIONS_PER_WORKSPACE = 100;
const MAX_HISTORY_MESSAGES = 20;
/** A tool result in the history is a short summary (counts, names), not the rows the model saw. */
const MAX_TOOL_RESULT_CHARS = 1500;
const CONVERSATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

initModels();

/** A message of a saved turn; `placeIds` (a search's places) are stored but never sent to the model. */
export type HistoryMessage = ChatMessage & { placeIds?: string[] };

async function storedMessages(id: string, workspaceId: string): Promise<ConversationMessage[]> {
  await database.authenticate();
  const conversation = await Conversation.findOne({
    where: { id, workspaceId, expiresAt: { [Op.gt]: new Date() } },
    attributes: ["messages"],
  });
  return conversation?.messages ?? [];
}

/** The history as the model sees it: messages with the tool calls they made and the tools' short results. */
export async function getConversationMessages(id: string, workspaceId: string): Promise<ChatMessage[]> {
  return (await storedMessages(id, workspaceId)).map((message): ChatMessage => {
    if (message.role === "tool") return { role: "tool", tool_name: message.toolName ?? "", content: message.content };
    if (message.role === "assistant" && message.toolCalls?.length) {
      return { role: "assistant", content: message.content, tool_calls: message.toolCalls.map((call, index) => ({ type: "function", function: { index, name: call.name, arguments: call.arguments } })) };
    }
    return { role: message.role, content: message.content };
  });
}

/** The places the conversation's latest place search returned, in the order shown; empty when it found none. */
export async function getConversationPlaceIds(id: string, workspaceId: string): Promise<string[]> {
  const messages = await storedMessages(id, workspaceId);
  return [...messages].reverse().find((message) => message.role === "tool" && message.placeIds?.length)?.placeIds ?? [];
}

/** The trip plan the conversation currently shows, or null when it has none. */
export async function getConversationTripPlan(id: string, workspaceId: string): Promise<TripPlan | null> {
  await database.authenticate();
  const conversation = await Conversation.findOne({
    where: { id, workspaceId, expiresAt: { [Op.gt]: new Date() } },
    attributes: ["tripPlan"],
  });
  return conversation?.tripPlan ?? null;
}

/**
 * Appends a turn (the user's message, the tool calls with their short results, the answer) to the stored history.
 * `tripPlan` replaces the stored plan when given (null clears it); when omitted the stored plan is kept.
 */
export async function saveConversationTurn(id: string, workspaceId: string, messages: HistoryMessage[], tripPlan?: TripPlan | null): Promise<void> {
  await database.authenticate();
  const now = new Date();
  const filteredMessages: ConversationMessage[] = messages.flatMap((message): ConversationMessage[] => {
    if (message.role === "user") return [{ role: "user", content: message.content.slice(0, 4000) }];
    if (message.role === "tool") {
      return [{ role: "tool", toolName: (message.tool_name ?? "").slice(0, 40), content: message.content.slice(0, MAX_TOOL_RESULT_CHARS), ...(message.placeIds?.length ? { placeIds: message.placeIds.slice(0, 50) } : {}) }];
    }
    if (message.role !== "assistant") return [];
    const toolCalls = message.tool_calls?.map((call) => ({ name: call.function.name.slice(0, 40), arguments: call.function.arguments }));
    return [{ role: "assistant", content: message.content.slice(0, 4000), ...(toolCalls?.length ? { toolCalls } : {}) }];
  });

  await database.transaction(async (transaction) => {
    await Conversation.destroy({ where: { workspaceId, expiresAt: { [Op.lte]: now } }, transaction });
    const current = await Conversation.findOne({ where: { id, workspaceId }, transaction });
    if (!current) {
      const count = await Conversation.count({ where: { workspaceId }, transaction });
      if (count >= MAX_CONVERSATIONS_PER_WORKSPACE) {
        const oldest = await Conversation.findOne({ where: { workspaceId }, order: [["updatedAt", "ASC"]], transaction });
        await oldest?.destroy({ transaction });
      }
      await Conversation.create({ id, workspaceId, messages: trimHistory(filteredMessages), tripPlan: tripPlan ?? null, expiresAt: new Date(now.getTime() + CONVERSATION_TTL_MS) }, { transaction });
      return;
    }
    current.messages = trimHistory([...current.messages, ...filteredMessages]);
    if (tripPlan !== undefined) current.tripPlan = tripPlan;
    current.expiresAt = new Date(now.getTime() + CONVERSATION_TTL_MS);
    await current.save({ transaction });
  });
}

/**
 * Keeps the first message (what the conversation is about) and the latest whole turns: the cut is made before a
 * user message, so a tool result never loses the call it answers.
 */
export function trimHistory(messages: ConversationMessage[]): ConversationMessage[] {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages;
  let start = messages.length - (MAX_HISTORY_MESSAGES - 1);
  while (start < messages.length && messages[start]!.role !== "user") start += 1;
  return [messages[0]!, ...messages.slice(start)];
}

export async function clearConversationHistory(workspaceId: string): Promise<void> {
  await database.authenticate();
  await Conversation.destroy({ where: { workspaceId } });
}

export async function hasConversation(id: string, workspaceId: string): Promise<boolean> {
  await database.authenticate();
  return Boolean(await Conversation.findOne({ where: { id, workspaceId, expiresAt: { [Op.gt]: new Date() } }, attributes: ["id"] }));
}
