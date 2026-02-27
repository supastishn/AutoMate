import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolContext } from '../src/agent/tool-registry.js';
import { messageTools, setMessageAgent } from '../src/agent/tools/message.js';

const askTool = messageTools.find(t => t.name === 'message')!;

function makeCtx(): ToolContext {
  return {
    sessionId: 'webchat:test-session',
    workdir: process.cwd(),
  };
}

describe('AskUserQuestion tool behavior', () => {
  test('ask_user_question emits one chat question with options', async () => {
    const sent: Array<{ sessionId: string; payload: Record<string, unknown> }> = [];
    const persisted: Array<{ sessionId: string; payload: Record<string, unknown> }> = [];

    setMessageAgent({
      processMessage: async () => ({ content: '', toolCalls: [] }),
      sendEventToSession: (sessionId: string, payload: Record<string, unknown>) => {
        sent.push({ sessionId, payload });
        return true;
      },
      recordAskUserQuestion: (sessionId: string, payload: Record<string, unknown>) => {
        persisted.push({ sessionId, payload });
      },
    } as any);

    const result = await askTool.execute({
      action: 'ask_user_question',
      question: 'Which wallet should I use?',
      options: ['MetaMask', 'Rabby'],
    }, makeCtx());

    assert.equal(result.error, undefined);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].sessionId, 'webchat:test-session');
    assert.equal(sent[0].payload.type, 'ask_user_question');
    assert.equal(sent[0].payload.question, 'Which wallet should I use?');
    assert.deepEqual(sent[0].payload.options, ['MetaMask', 'Rabby']);
    assert.equal(sent[0].payload.allowCustomInput, true);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].sessionId, 'webchat:test-session');
    assert.equal(persisted[0].payload.question, 'Which wallet should I use?');
  });

  test('ask_user_question supports sending multiple questions in one call', async () => {
    const sent: Array<{ sessionId: string; payload: Record<string, unknown> }> = [];
    const persisted: Array<{ sessionId: string; payload: Record<string, unknown> }> = [];

    setMessageAgent({
      processMessage: async () => ({ content: '', toolCalls: [] }),
      sendEventToSession: (sessionId: string, payload: Record<string, unknown>) => {
        sent.push({ sessionId, payload });
        return true;
      },
      recordAskUserQuestion: (sessionId: string, payload: Record<string, unknown>) => {
        persisted.push({ sessionId, payload });
      },
    } as any);

    const result = await askTool.execute({
      action: 'ask_user_question',
      questions: [
        { question: 'Pick one', options: ['A', 'B'] },
        { question: 'Any note?', allowCustomInput: true },
      ],
    }, makeCtx());

    assert.equal(result.error, undefined);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].payload.type, 'ask_user_question');
    assert.equal(sent[0].payload.question, 'Pick one');
    assert.deepEqual(sent[0].payload.options, ['A', 'B']);
    assert.equal(sent[1].payload.question, 'Any note?');
    assert.equal(persisted.length, 2);
    assert.equal(persisted[0].payload.question, 'Pick one');
    assert.equal(persisted[1].payload.question, 'Any note?');
  });
});
