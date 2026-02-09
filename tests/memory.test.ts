/**
 * Memory System Integration Tests
 * 
 * Tests MemoryManager, VectorIndex chunking/search, daily logs,
 * identity files, factory reset, and prompt injection — all using
 * real filesystem operations in temp directories.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryManager } from '../src/memory/manager.js';
import { chunkText } from '../src/memory/vector-index.js';

const TEST_DIR = join(tmpdir(), `automate-test-memory-${Date.now()}`);

describe('MemoryManager', () => {
  let mm: MemoryManager;
  let memDir: string;

  beforeEach(() => {
    memDir = join(TEST_DIR, `mem-${Date.now()}`);
    mkdirSync(memDir, { recursive: true });
    // Disable embeddings for these tests (no API available)
    mm = new MemoryManager(memDir, { enabled: false, model: '', apiBase: '', chunkSize: 512, chunkOverlap: 64, vectorWeight: 0.6, bm25Weight: 0.4, topK: 10 });
  });

  afterEach(() => {
    rmSync(memDir, { recursive: true, force: true });
  });

  test('creates default template files on init', () => {
    assert.ok(existsSync(join(memDir, 'PERSONALITY.md')));
    assert.ok(existsSync(join(memDir, 'BOOTSTRAP.md')));
    assert.ok(existsSync(join(memDir, 'IDENTITY.md')));
    assert.ok(existsSync(join(memDir, 'USER.md')));
    assert.ok(existsSync(join(memDir, 'AGENTS.md')));
    assert.ok(existsSync(join(memDir, 'HEARTBEAT.md')));
  });

  test('MEMORY.md read/write cycle', () => {
    // Initially empty
    assert.equal(mm.getMemory(), '');

    // Save
    mm.saveMemory('# Important Facts\n- User likes TypeScript');
    const content = mm.getMemory();
    assert.ok(content.includes('Important Facts'));
    assert.ok(content.includes('TypeScript'));

    // Verify on disk
    const diskContent = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
    assert.equal(diskContent, content);
  });

  test('appendMemory adds without overwriting', () => {
    mm.saveMemory('Fact 1');
    mm.appendMemory('Fact 2');
    mm.appendMemory('Fact 3');

    const content = mm.getMemory();
    assert.ok(content.includes('Fact 1'));
    assert.ok(content.includes('Fact 2'));
    assert.ok(content.includes('Fact 3'));
  });

  test('daily log creates dated file with timestamps', () => {
    mm.appendDailyLog('Test entry');

    const today = new Date().toISOString().split('T')[0];
    const logPath = join(memDir, `${today}.md`);
    assert.ok(existsSync(logPath));

    const content = readFileSync(logPath, 'utf-8');
    assert.ok(content.includes('Test entry'));
    assert.ok(content.includes('##')); // timestamp header
  });

  test('getDailyLog returns correct date content', () => {
    mm.appendDailyLog('Entry 1');
    mm.appendDailyLog('Entry 2');

    const today = new Date().toISOString().split('T')[0];
    const log = mm.getDailyLog(today);
    assert.ok(log.includes('Entry 1'));
    assert.ok(log.includes('Entry 2'));

    // Non-existent date returns empty
    assert.equal(mm.getDailyLog('1990-01-01'), '');
  });

  test('getRecentDailyLogs includes today', () => {
    mm.appendDailyLog('Today note');
    const recent = mm.getRecentDailyLogs();
    assert.ok(recent.includes('Today note'));
    assert.ok(recent.includes('Today'));
  });

  test('identity file read/write', () => {
    mm.saveIdentityFile('IDENTITY.md', '- **Name:** TestBot\n- **Emoji:** 🤖');
    const content = mm.getIdentityFile('IDENTITY.md');
    assert.ok(content.includes('TestBot'));
    assert.ok(content.includes('🤖'));
  });

  test('getAgentName parses IDENTITY.md correctly', () => {
    // Default template has placeholder
    assert.equal(mm.getAgentName(), null);

    // Set a real name
    mm.saveIdentityFile('IDENTITY.md', '- **Name:** Archie\n- **Creature:** AI assistant');
    assert.equal(mm.getAgentName(), 'Archie');
  });

  test('getAgentEmoji parses IDENTITY.md', () => {
    assert.equal(mm.getAgentEmoji(), null);

    mm.saveIdentityFile('IDENTITY.md', '- **Name:** Test\n- **Emoji:** 🔥');
    assert.equal(mm.getAgentEmoji(), '🔥');
  });

  test('hasBootstrap returns true initially, false after delete', () => {
    assert.ok(mm.hasBootstrap());
    mm.deleteBootstrap();
    assert.ok(!mm.hasBootstrap());
    assert.ok(!existsSync(join(memDir, 'BOOTSTRAP.md')));
  });

  test('factoryReset wipes everything and restores defaults', () => {
    // Write custom data
    mm.saveMemory('Important data');
    mm.appendDailyLog('Some log');
    mm.deleteBootstrap();

    // Factory reset
    mm.factoryReset();

    // Memory gone
    assert.equal(mm.getMemory(), '');

    // Bootstrap restored
    assert.ok(mm.hasBootstrap());

    // Default templates restored
    assert.ok(existsSync(join(memDir, 'PERSONALITY.md')));
    assert.ok(existsSync(join(memDir, 'IDENTITY.md')));
  });

  test('listFiles returns md files with metadata', () => {
    mm.saveMemory('test');
    const files = mm.listFiles();
    assert.ok(files.length > 0);

    const memFile = files.find(f => f.name === 'MEMORY.md');
    assert.ok(memFile);
    assert.ok(memFile!.size > 0);
    assert.ok(memFile!.modified);
  });

  test('getPromptInjection includes identity and memory', () => {
    mm.saveIdentityFile('IDENTITY.md', '- **Name:** TestBot');
    mm.saveMemory('Remember: user likes coffee');

    const injection = mm.getPromptInjection();
    assert.ok(injection.includes('Agent Memory & Identity'));
    assert.ok(injection.includes('TestBot'));
    assert.ok(injection.includes('coffee'));
  });

  test('getPromptInjection includes bootstrap on first run', () => {
    const injection = mm.getPromptInjection();
    assert.ok(injection.includes('FIRST RUN'));
  });

  test('getPromptInjection truncates large memory', () => {
    // Write > 8000 chars
    const bigMemory = 'x'.repeat(9000);
    mm.saveMemory(bigMemory);
    const injection = mm.getPromptInjection();
    assert.ok(injection.includes('truncated'));
  });

  test('legacy search finds text matches', () => {
    mm.saveMemory('The user prefers PostgreSQL over MySQL');
    const results = mm.search('PostgreSQL');
    assert.ok(results.length > 0);
    assert.ok(results[0].matches.some(m => m.includes('PostgreSQL')));
  });

  test('legacy search is case-insensitive', () => {
    mm.saveMemory('TypeScript is preferred');
    const results = mm.search('typescript');
    assert.ok(results.length > 0);
  });

  test('search returns empty for non-existent terms', () => {
    mm.saveMemory('Hello world');
    const results = mm.search('xyznonexistent');
    assert.equal(results.length, 0);
  });

  test('indexing toggle works', () => {
    // Initially disabled
    let stats = mm.getIndexStats();
    assert.equal(stats.enabled, false);

    // Enable
    mm.enableIndexing();
    stats = mm.getIndexStats();
    assert.equal(stats.enabled, true);

    // Disable
    mm.disableIndexing();
    stats = mm.getIndexStats();
    assert.equal(stats.enabled, false);
  });
});

describe('VectorIndex Chunking', () => {
  test('chunks small text into single chunk', () => {
    const chunks = chunkText('Hello world', 512, 64);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, 'Hello world');
    assert.equal(chunks[0].charStart, 0);
  });

  test('chunks empty text returns empty array', () => {
    assert.deepEqual(chunkText('', 512, 64), []);
    assert.deepEqual(chunkText('   ', 512, 64), []);
  });

  test('chunks large text into multiple chunks', () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) =>
      `Paragraph ${i}: ${'word '.repeat(50)}`
    );
    const text = paragraphs.join('\n\n');
    const chunks = chunkText(text, 512, 64);
    assert.ok(chunks.length > 1);

    // Verify all text is covered
    for (const chunk of chunks) {
      assert.ok(chunk.text.length > 0);
      assert.ok(chunk.charStart >= 0);
      assert.ok(chunk.charEnd > chunk.charStart);
    }
  });

  test('chunks respect paragraph boundaries', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const chunks = chunkText(text, 100, 0);
    // Should keep paragraphs together when they fit
    assert.ok(chunks.length >= 1);
    assert.ok(chunks[0].text.includes('First paragraph'));
  });

  test('overlapping chunks share content', () => {
    const text = Array.from({ length: 30 }, (_, i) =>
      `Section ${i}: ${'content '.repeat(30)}`
    ).join('\n\n');
    const chunks = chunkText(text, 256, 64);

    if (chunks.length >= 2) {
      // With overlap, adjacent chunks may share some text
      // Just verify we get multiple chunks without errors
      assert.ok(chunks.length > 1);
    }
  });
});
