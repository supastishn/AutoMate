/**
 * Context Pruner — in-memory trimming of tool results to save context space.
 * Unlike compaction (persistent), pruning is in-memory only for the current request.
 *
 * Two phases:
 * 1. Soft Trim: Keep head+tail of large tool results (preserves structure/errors)
 * 2. Hard Clear: Replace old tool results with placeholder (aggressive savings)
 */

import type { LLMMessage, ContentPart } from '../agent/llm-client.js';

/** Helper to get text from content (handles both string and ContentPart[]) */
function getTextFromContent(content: string | ContentPart[] | null): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  // ContentPart[] - extract text parts
  return content
    .filter(part => part.type === 'text' && part.text)
    .map(part => part.text)
    .join(' ');
}

export interface PruningSettings {
  enabled: boolean;
  maxToolResults: number;     // maximum tool results before pruning starts
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
  maxToolResults: 100,            // maximum tool results before pruning starts
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
  toolIndex: number;         // position in the overall list of tool results
}

/**
 * Find tool result messages that are candidates for pruning.
 * Prunes tool results that exceed maxToolResults limit, excluding protected assistant turns.
 */
function findPrunableToolResults(
  messages: LLMMessage[],
  keepLastAssistants: number,
  maxToolResults: number,
): PrunableToolResult[] {
  // Find indices of assistant messages
  const assistantIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant') {
      assistantIndices.push(i);
    }
  }

  // Determine the cutoff: tool results before this index are prunable (for assistant protection)
  const protectedFromIndex = assistantIndices.length > keepLastAssistants
    ? assistantIndices[assistantIndices.length - keepLastAssistants]
    : 0;

  // Find all tool results with their position in the full list
  const allToolResults: PrunableToolResult[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool' && m.content && m.content.length > 0) {
      allToolResults.push({
        messageIndex: i,
        originalLength: m.content.length,
        toolIndex: allToolResults.length,  // position in the list of all tool results
      });
    }
  }

  const prunables: PrunableToolResult[] = [];

  // Identify which tool results exceed the maxToolResults limit (oldest ones)
  const excessToolResults: PrunableToolResult[] = [];
  if (allToolResults.length > maxToolResults) {
    const excessCount = allToolResults.length - maxToolResults;
    // Add oldest tools that exceed the limit
    for (let i = 0; i < excessCount; i++) {
      excessToolResults.push(allToolResults[i]);
    }
  }

  // Add tool results that are before the protected range (assistant protection)
  const protectedToolResults: PrunableToolResult[] = [];
  for (const toolResult of allToolResults) {
    if (toolResult.messageIndex < protectedFromIndex) {
      protectedToolResults.push(toolResult);
    }
  }

  // Combine both sets, avoiding duplicates
  const allPotentialPrunables = [...excessToolResults, ...protectedToolResults];
  for (const toolResult of allPotentialPrunables) {
    // Add to prunables if not already included
    if (!prunables.some(p => p.messageIndex === toolResult.messageIndex)) {
      prunables.push(toolResult);
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

  // Check if we should prune based on count (independent of context ratio)
  const totalToolResults = messages.filter(m => m.role === 'tool').length;
  const wouldPruneByCount = totalToolResults > settings.maxToolResults;
  
  // Calculate prunable chars to check minPrunableChars requirement
  const prunablesForCheck = findPrunableToolResults(messages, settings.keepLastAssistants, settings.maxToolResults);
  const prunableChars = prunablesForCheck.reduce((sum, p) => sum + p.originalLength, 0);
  
  // If context ratio is below threshold AND minPrunableChars not met AND we're not pruning by count, return without pruning
  if (ratio < settings.softTrimRatio && prunableChars < settings.minPrunableChars && !wouldPruneByCount) {
    return { messages, pruned: false, stats: { softTrimmed: 0, hardCleared: 0, charsSaved: 0 } };
  }

  // Find prunable tool results
  const prunables = findPrunableToolResults(messages, settings.keepLastAssistants, settings.maxToolResults);

  // Calculate total prunable chars
  const totalPrunableChars = prunables.reduce((sum, p) => sum + p.originalLength, 0);
  
  // If prunable chars are below threshold AND we're not pruning by count, return without pruning
  if (totalPrunableChars < settings.minPrunableChars && !wouldPruneByCount) {
    return { messages, pruned: false, stats: { softTrimmed: 0, hardCleared: 0, charsSaved: 0 } };
  }

  // Clone messages for modification
  const result = messages.map(m => ({ ...m }));
  const stats: PruneStats = { softTrimmed: 0, hardCleared: 0, charsSaved: 0 };

  // Phase 1: Soft trim (at softTrimRatio threshold)
  if (ratio >= settings.softTrimRatio) {
    for (const p of prunables) {
      const msg = result[p.messageIndex];
      const text = getTextFromContent(msg.content);
      if (text && text.length > settings.softTrim.maxChars) {
        const originalLen = text.length;
        msg.content = softTrimContent(text, settings.softTrim);
        stats.softTrimmed++;
        stats.charsSaved += originalLen - (msg.content as string).length;
      }
    }
  }

  // Phase 2: Hard clear (at hardClearRatio threshold)
  if (ratio >= settings.hardClearRatio && settings.hardClear.enabled) {
    // Recalculate ratio after soft trimming
    totalChars = 0;
    for (const m of result) {
      const text = getTextFromContent(m.content);
      if (text) totalChars += text.length;
      if (m.tool_calls) totalChars += JSON.stringify(m.tool_calls).length;
    }
    const newRatio = totalChars / charWindow;

    if (newRatio >= settings.hardClearRatio) {
      for (const p of prunables) {
        const msg = result[p.messageIndex];
        const text = getTextFromContent(msg.content);
        if (text && text !== settings.hardClear.placeholder) {
          const originalLen = text.length;
          msg.content = settings.hardClear.placeholder;
          stats.hardCleared++;
          stats.charsSaved += originalLen - settings.hardClear.placeholder.length;
        }
      }
    }
  }
  
  // Phase 3: Count-based hard clear (clear excess tool results beyond maxToolResults)
  const currentTotalToolResults = messages.filter(m => m.role === 'tool').length;
  if (currentTotalToolResults > settings.maxToolResults && settings.hardClear.enabled) {
    // Find tool results that exceed the maxToolResults limit (oldest ones)
    let toolResultCount = 0;
    for (let i = 0; i < result.length; i++) {
      if (result[i].role === 'tool') {
        toolResultCount++;
        // If this is beyond the max allowed, clear it (but respect assistant protection)
        if (toolResultCount > settings.maxToolResults) {
          // Check if this tool result is part of prunables (to respect assistant protection)
          const prunable = prunables.find(p => p.messageIndex === i);
          if (prunable) {
            const msg = result[i];
            const text = getTextFromContent(msg.content);
            if (text && text !== settings.hardClear.placeholder) {
              const originalLen = text.length;
              msg.content = settings.hardClear.placeholder;
              stats.hardCleared++;
              stats.charsSaved += originalLen - settings.hardClear.placeholder.length;
            }
          }
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
    const text = getTextFromContent(m.content);
    if (text) totalChars += text.length;
    if (m.tool_calls) totalChars += JSON.stringify(m.tool_calls).length;
  }

  const charWindow = contextWindowTokens * 4;
  const ratio = totalChars / charWindow;

  // Check if we should prune based on count (independent of context ratio)
  const totalToolResults = messages.filter(m => m.role === 'tool').length;
  const wouldPruneByCount = totalToolResults > settings.maxToolResults;
  
  const prunables = findPrunableToolResults(messages, settings.keepLastAssistants, settings.maxToolResults);
  const prunableChars = prunables.reduce((sum, p) => sum + p.originalLength, 0);

  return {
    wouldPrune: (ratio >= settings.softTrimRatio && prunableChars >= settings.minPrunableChars) || wouldPruneByCount,
    prunableCount: prunables.length,
    prunableChars,
    currentRatio: ratio,
  };
}
