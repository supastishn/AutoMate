/**
 * Context Pruner — in-memory trimming of tool results to save context space.
 * Unlike compaction (persistent), pruning is in-memory only for the current request.
 * 
 * Two phases:
 * 1. Soft Trim: Keep head+tail of large tool results (preserves structure/errors)
 * 2. Hard Clear: Replace old tool results with placeholder (aggressive savings)
 */

import type { LLMMessage } from '../agent/llm-client.js';

export interface PruningSettings {
  enabled: boolean;
  ttlMs: number;              // tool results older than this are candidates for pruning
  keepLastAssistants: number; // protect tool results from last N assistant turns
  softTrimRatio: number;      // start soft trimming at this context ratio
  hardClearRatio: number;     // start hard clearing at this context ratio
  minPrunableChars: number;   // only prune if there's at least this many chars to prune
  softTrim: {
    maxChars: number;         // max chars to keep after soft trim
    headChars: number;        // keep first N chars
    tailChars: number;        // keep last N chars
  };
  hardClear: {
    enabled: boolean;
    placeholder: string;
  };
}

export const DEFAULT_PRUNING_SETTINGS: PruningSettings = {
  enabled: true,
  ttlMs: 5 * 60 * 1000,           // 5 minutes
  keepLastAssistants: 3,          // protect last 3 assistant turns
  softTrimRatio: 0.3,             // start trimming at 30% of context
  hardClearRatio: 0.5,            // hard clear at 50% of context
  minPrunableChars: 50000,        // only prune if >50K chars prunable
  softTrim: {
    maxChars: 4000,
    headChars: 1500,
    tailChars: 1500,
  },
  hardClear: {
    enabled: true,
    placeholder: '[Old tool result content cleared]',
  },
};

interface PrunableToolResult {
  messageIndex: number;
  originalLength: number;
  timestamp?: number;        // when the tool was called (if tracked)
}

/**
 * Find tool result messages that are candidates for pruning.
 * Excludes tool results from the last N assistant turns.
 */
function findPrunableToolResults(
  messages: LLMMessage[],
  keepLastAssistants: number,
): PrunableToolResult[] {
  // Find indices of assistant messages
  const assistantIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant') {
      assistantIndices.push(i);
    }
  }

  // Determine the cutoff: tool results before this index are prunable
  const protectedFromIndex = assistantIndices.length > keepLastAssistants
    ? assistantIndices[assistantIndices.length - keepLastAssistants]
    : 0;

  // Find tool results before the protected zone
  const prunables: PrunableToolResult[] = [];
  for (let i = 0; i < protectedFromIndex; i++) {
    const m = messages[i];
    if (m.role === 'tool' && m.content && m.content.length > 0) {
      prunables.push({
        messageIndex: i,
        originalLength: m.content.length,
        timestamp: (m as any)._timestamp,
      });
    }
  }

  return prunables;
}

/**
 * Soft trim a tool result: keep head + tail, replace middle with ellipsis.
 */
function softTrimContent(content: string, settings: PruningSettings['softTrim']): string {
  if (content.length <= settings.maxChars) return content;

  const head = content.slice(0, settings.headChars);
  const tail = content.slice(-settings.tailChars);
  const removed = content.length - settings.headChars - settings.tailChars;

  return `${head}\n\n... [${removed} chars trimmed] ...\n\n${tail}`;
}

/**
 * Prune context messages in-place. Returns a modified copy of messages.
 * This is meant to be called before sending messages to the LLM.
 */
export function pruneContextMessages(
  messages: LLMMessage[],
  contextWindowTokens: number,
  settings: PruningSettings = DEFAULT_PRUNING_SETTINGS,
): { messages: LLMMessage[]; pruned: boolean; stats: PruneStats } {
  if (!settings.enabled) {
    return { messages, pruned: false, stats: { softTrimmed: 0, hardCleared: 0, charsSaved: 0 } };
  }

  // Estimate current char usage (rough: 4 chars per token)
  let totalChars = 0;
  for (const m of messages) {
    if (m.content) totalChars += m.content.length;
    if (m.tool_calls) totalChars += JSON.stringify(m.tool_calls).length;
  }

  const charWindow = contextWindowTokens * 4;
  const ratio = totalChars / charWindow;

  // Not enough context used yet to warrant pruning
  if (ratio < settings.softTrimRatio) {
    return { messages, pruned: false, stats: { softTrimmed: 0, hardCleared: 0, charsSaved: 0 } };
  }

  // Find prunable tool results
  const prunables = findPrunableToolResults(messages, settings.keepLastAssistants);

  // Calculate total prunable chars
  const totalPrunableChars = prunables.reduce((sum, p) => sum + p.originalLength, 0);
  if (totalPrunableChars < settings.minPrunableChars) {
    return { messages, pruned: false, stats: { softTrimmed: 0, hardCleared: 0, charsSaved: 0 } };
  }

  // Clone messages for modification
  const result = messages.map(m => ({ ...m }));
  const stats: PruneStats = { softTrimmed: 0, hardCleared: 0, charsSaved: 0 };

  // Phase 1: Soft trim (at softTrimRatio threshold)
  if (ratio >= settings.softTrimRatio) {
    for (const p of prunables) {
      const msg = result[p.messageIndex];
      if (msg.content && msg.content.length > settings.softTrim.maxChars) {
        const originalLen = msg.content.length;
        msg.content = softTrimContent(msg.content, settings.softTrim);
        stats.softTrimmed++;
        stats.charsSaved += originalLen - msg.content.length;
      }
    }
  }

  // Phase 2: Hard clear (at hardClearRatio threshold)
  if (ratio >= settings.hardClearRatio && settings.hardClear.enabled) {
    // Recalculate ratio after soft trimming
    totalChars = 0;
    for (const m of result) {
      if (m.content) totalChars += m.content.length;
      if (m.tool_calls) totalChars += JSON.stringify(m.tool_calls).length;
    }
    const newRatio = totalChars / charWindow;

    if (newRatio >= settings.hardClearRatio) {
      for (const p of prunables) {
        const msg = result[p.messageIndex];
        if (msg.content && msg.content !== settings.hardClear.placeholder) {
          const originalLen = msg.content.length;
          msg.content = settings.hardClear.placeholder;
          stats.hardCleared++;
          stats.charsSaved += originalLen - msg.content.length;
        }
      }
    }
  }

  const pruned = stats.softTrimmed > 0 || stats.hardCleared > 0;
  return { messages: result, pruned, stats };
}

export interface PruneStats {
  softTrimmed: number;
  hardCleared: number;
  charsSaved: number;
}

/**
 * Get pruning statistics without modifying messages.
 */
export function getPruningStats(
  messages: LLMMessage[],
  contextWindowTokens: number,
  settings: PruningSettings = DEFAULT_PRUNING_SETTINGS,
): { wouldPrune: boolean; prunableCount: number; prunableChars: number; currentRatio: number } {
  let totalChars = 0;
  for (const m of messages) {
    if (m.content) totalChars += m.content.length;
    if (m.tool_calls) totalChars += JSON.stringify(m.tool_calls).length;
  }

  const charWindow = contextWindowTokens * 4;
  const ratio = totalChars / charWindow;

  const prunables = findPrunableToolResults(messages, settings.keepLastAssistants);
  const prunableChars = prunables.reduce((sum, p) => sum + p.originalLength, 0);

  return {
    wouldPrune: ratio >= settings.softTrimRatio && prunableChars >= settings.minPrunableChars,
    prunableCount: prunables.length,
    prunableChars,
    currentRatio: ratio,
  };
}
