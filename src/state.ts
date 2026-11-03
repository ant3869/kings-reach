import { EventEmitter } from 'node:events';

/** Shared in-memory runtime state. One obvious way to do it. */

export type ChatEventType =
  | 'user_message'
  | 'assistant_message'
  | 'processing'
  | 'progress'
  | 'error'
  | 'hive_mind';

export interface ChatEvent {
  type: ChatEventType;
  chatId: string;
  agentId?: string;
  data: unknown;
  timestamp: number;
}

function emit(type: ChatEventType, chatId: string, data: unknown, agentId?: string): void {
  chatEvents.emit('chat', { type, chatId, agentId, data, timestamp: Date.now() } satisfies ChatEvent);
}

export const chatEvents = new EventEmitter();
export const voiceEnabledChats = new Set<string>();
export const activeSessions = new Map<string, { startedAt: number; agentId?: string }>();
export const abortControllers = new Map<string, AbortController>();

export function emitChatEvent(event: Omit<ChatEvent, 'timestamp'>): void {
  emit(event.type, event.chatId, event.data, event.agentId);
}

// --- security state (compat; starts unlocked unless a security builder locks it) ---
export let isSystemLocked = false;
export let lastActivityAt = Date.now();

export function touchActivity(): void {
  lastActivityAt = Date.now();
}

export function setLocked(locked: boolean): void {
  isSystemLocked = locked;
}
