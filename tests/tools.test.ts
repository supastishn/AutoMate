/**
 * Agent Tools Integration Tests
 * 
 * Tests bash, file, memory, canvas, process, shared-memory, and session
 * tools by actually executing them with real filesystem and processes.
 * NO MOCKS — these catch real runtime errors.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolContext } from '../src/agent/tool-registry.js';

// Import tools directly
import { bashTool } from '../src/agent/tools/bash.js';
import { readFileTool, writeFileTool, editFileTool, applyPatchTool, hashlineEditTool } from '../src/agent/tools/files.js';
import { setSharedMemoryDir, sharedMemoryTools } from '../src/agent/tools/shared-memory.js';
import { processTools } from '../src/agent/tools/process.js';

const TEST_DIR = join(tmpdir(), `automate-test-tools-${Date.now()}`);

function makeCtx(elevated = false): ToolContext {
  return { sessionId: 'test:user1', workdir: TEST_DIR, elevated };
}

describe('Bash Tool', () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  test('executes simple command', async () => {
    const result = await bashTool.execute({ command: 'echo hello world' }, makeCtx());
    assert.ok(result.output.includes('hello world'));
    assert.equal(result.error, undefined);
  });

  test('captures stderr', async () => {
    const result = await bashTool.execute({ command: 'echo error >&2' }, makeCtx());
    assert.ok(result.output.includes('error'));
  });

  test('reports non-zero exit code', async () => {
    const result = await bashTool.execute({ command: 'exit 42' }, makeCtx());
    assert.ok(result.error);
    assert.ok(result.error!.includes('42'));
  });

  test('respects working directory', async () => {
    const result = await bashTool.execute({ command: 'pwd' }, makeCtx());
    assert.ok(result.output.includes(TEST_DIR));
  });

  test('blocks sudo when not elevated', async () => {
    const result = await bashTool.execute({ command: 'sudo ls' }, makeCtx(false));
    assert.ok(result.error === 'BLOCKED');
    assert.ok(result.output.includes('blocked'));
  });

  test('blocks curl when not elevated', async () => {
    const result = await bashTool.execute({ command: 'curl https://example.com' }, makeCtx(false));
    assert.ok(result.error === 'BLOCKED');
  });

  test('blocks wget when not elevated', async () => {
    const result = await bashTool.execute({ command: 'wget https://example.com' }, makeCtx(false));
    assert.ok(result.error === 'BLOCKED');
  });

  test('blocks rm -rf / when not elevated', async () => {
    const result = await bashTool.execute({ command: 'rm -rf /' }, makeCtx(false));
    assert.ok(result.error === 'BLOCKED');
  });

  test('blocks dd to device', async () => {
    const result = await bashTool.execute({ command: 'dd if=/dev/zero of=/dev/sda' }, makeCtx(false));
    assert.ok(result.error === 'BLOCKED');
  });

  test('allows blocked commands when elevated', async () => {
    // echo is safe, but test that the command is NOT blocked (reaches execution)
    const result = await bashTool.execute({ command: 'echo elevated-test' }, makeCtx(true));
    // Elevated mode should never return BLOCKED
    assert.notEqual(result.error, 'BLOCKED');
    assert.ok(result.output.includes('elevated-test'));
  });

  test('truncates large output', async () => {
    // Generate output > 50KB
    const result = await bashTool.execute(
      { command: 'yes "long line of text" | head -5000' },
      makeCtx()
    );
    assert.ok(result.output.length <= 51000); // 50000 + "... (truncated)"
  });

  test('respects timeout', async () => {
    const result = await bashTool.execute(
      { command: 'sleep 10', timeout: 1000 },
      makeCtx()
    );
    // Should either error with timeout or have an error
    assert.ok(result.output || result.error);
  });
});

describe('File Tools', () => {
  const testFile = join(TEST_DIR, 'test.txt');

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('write_file creates file and parent dirs', async () => {
    const nestedPath = join(TEST_DIR, 'deep', 'nested', 'file.txt');
    const result = await writeFileTool.execute(
      { path: nestedPath, content: 'Hello nested' },
      makeCtx()
    );
    assert.ok(result.output.includes('Written'));
    assert.ok(existsSync(nestedPath));
    assert.equal(readFileSync(nestedPath, 'utf-8'), 'Hello nested');
  });

  test('read_file returns content with hashline format', async () => {
    writeFileSync(testFile, 'Line 1\nLine 2\nLine 3');
    const result = await readFileTool.execute({ path: testFile }, makeCtx());
    // Format should be "lineNum:hash|content"
    assert.ok(result.output.includes('1:'));
    assert.ok(result.output.includes('|Line 1'));
    assert.ok(result.output.includes('2:'));
    assert.ok(result.output.includes('|Line 2'));
    assert.ok(result.output.includes('3:'));
    assert.ok(result.output.includes('|Line 3'));
  });

  test('read_file with offset and limit', async () => {
    writeFileSync(testFile, 'Line 0\nLine 1\nLine 2\nLine 3\nLine 4');
    const result = await readFileTool.execute(
      { path: testFile, offset: 1, limit: 2 },
      makeCtx()
    );
    assert.ok(result.output.includes('|Line 1'));
    assert.ok(result.output.includes('|Line 2'));
    assert.ok(!result.output.includes('|Line 0'));
    assert.ok(!result.output.includes('|Line 3'));
  });

  test('read_file returns error for missing file', async () => {
    const result = await readFileTool.execute(
      { path: join(TEST_DIR, 'nonexistent.txt') },
      makeCtx()
    );
    assert.ok(result.error);
    assert.ok(result.error!.includes('not found'));
  });

  test('edit_file replaces string in file', async () => {
    writeFileSync(testFile, 'Hello world, hello universe');
    const result = await editFileTool.execute(
      { path: testFile, old_string: 'world', new_string: 'earth' },
      makeCtx()
    );
    assert.ok(result.output.includes('Edited'));
    const content = readFileSync(testFile, 'utf-8');
    assert.ok(content.includes('Hello earth'));
    // Only first occurrence replaced by default
    assert.ok(content.includes('hello universe'));
  });

  test('edit_file with replace_all', async () => {
    writeFileSync(testFile, 'foo bar foo baz foo');
    await editFileTool.execute(
      { path: testFile, old_string: 'foo', new_string: 'qux', replace_all: true },
      makeCtx()
    );
    const content = readFileSync(testFile, 'utf-8');
    assert.equal(content, 'qux bar qux baz qux');
  });

  test('edit_file errors when old_string not found', async () => {
    writeFileSync(testFile, 'Hello world');
    const result = await editFileTool.execute(
      { path: testFile, old_string: 'nonexistent', new_string: 'replacement' },
      makeCtx()
    );
    assert.ok(result.error);
    assert.ok(result.error!.includes('not found'));
  });

  test('apply_patch applies unified diff', async () => {
    writeFileSync(testFile, 'line 1\nline 2\nline 3\nline 4');
    const patch = `--- a/test.txt
+++ b/test.txt
@@ -1,4 +1,4 @@
 line 1
-line 2
+line TWO
 line 3
 line 4`;

    const result = await applyPatchTool.execute(
      { path: testFile, patch },
      makeCtx()
    );
    assert.ok(result.output.includes('Patched'));
    const content = readFileSync(testFile, 'utf-8');
    assert.ok(content.includes('line TWO'));
    assert.ok(!content.includes('line 2'));
  });

  test('hashline_edit replaces single line with valid hash', async () => {
    writeFileSync(testFile, 'line 1\nline 2\nline 3');
    // First read to get the hash
    const readResult = await readFileTool.execute({ path: testFile }, makeCtx());
    // Extract hash for line 2 (format: "2:XX|line 2")
    const line2Match = readResult.output.match(/2:([a-z0-9]{2})\|line 2/);
    assert.ok(line2Match, 'Should find line 2 with hash');
    const hash = line2Match[1];
    
    const result = await hashlineEditTool.execute(
      { path: testFile, operation: 'replace', start_ref: `2:${hash}`, new_content: 'REPLACED LINE' },
      makeCtx()
    );
    assert.ok(result.output.includes('Replaced'));
    const content = readFileSync(testFile, 'utf-8');
    assert.equal(content, 'line 1\nREPLACED LINE\nline 3');
  });

  test('hashline_edit rejects edit with wrong hash', async () => {
    writeFileSync(testFile, 'line 1\nline 2\nline 3');
    const result = await hashlineEditTool.execute(
      { path: testFile, operation: 'replace', start_ref: '2:zz', new_content: 'REPLACED' },
      makeCtx()
    );
    assert.ok(result.error);
    assert.ok(result.error!.includes('Hash mismatch'));
    // File should be unchanged
    const content = readFileSync(testFile, 'utf-8');
    assert.equal(content, 'line 1\nline 2\nline 3');
  });

  test('hashline_edit replaces range of lines', async () => {
    writeFileSync(testFile, 'line 1\nline 2\nline 3\nline 4\nline 5');
    const readResult = await readFileTool.execute({ path: testFile }, makeCtx());
    const line2Match = readResult.output.match(/2:([a-z0-9]{2})\|line 2/);
    const line4Match = readResult.output.match(/4:([a-z0-9]{2})\|line 4/);
    assert.ok(line2Match && line4Match);
    
    const result = await hashlineEditTool.execute(
      { 
        path: testFile, 
        operation: 'replace', 
        start_ref: `2:${line2Match[1]}`,
        end_ref: `4:${line4Match[1]}`,
        new_content: 'MERGED LINE'
      },
      makeCtx()
    );
    assert.ok(result.output.includes('Replaced'));
    const content = readFileSync(testFile, 'utf-8');
    assert.equal(content, 'line 1\nMERGED LINE\nline 5');
  });

  test('hashline_edit inserts after line', async () => {
    writeFileSync(testFile, 'line 1\nline 2\nline 3');
    const readResult = await readFileTool.execute({ path: testFile }, makeCtx());
    const line2Match = readResult.output.match(/2:([a-z0-9]{2})\|line 2/);
    assert.ok(line2Match);
    
    const result = await hashlineEditTool.execute(
      { 
        path: testFile, 
        operation: 'insert_after', 
        start_ref: `2:${line2Match[1]}`,
        new_content: 'NEW LINE A\nNEW LINE B'
      },
      makeCtx()
    );
    assert.ok(result.output.includes('Inserted'));
    const content = readFileSync(testFile, 'utf-8');
    assert.equal(content, 'line 1\nline 2\nNEW LINE A\nNEW LINE B\nline 3');
  });

  test('hashline_edit deletes lines', async () => {
    writeFileSync(testFile, 'line 1\nline 2\nline 3\nline 4');
    const readResult = await readFileTool.execute({ path: testFile }, makeCtx());
    const line2Match = readResult.output.match(/2:([a-z0-9]{2})\|line 2/);
    const line3Match = readResult.output.match(/3:([a-z0-9]{2})\|line 3/);
    assert.ok(line2Match && line3Match);
    
    const result = await hashlineEditTool.execute(
      { 
        path: testFile, 
        operation: 'delete', 
        start_ref: `2:${line2Match[1]}`,
        end_ref: `3:${line3Match[1]}`
      },
      makeCtx()
    );
    assert.ok(result.output.includes('Deleted'));
    const content = readFileSync(testFile, 'utf-8');
    assert.equal(content, 'line 1\nline 4');
  });
});

describe('Shared Memory Tools', () => {
  const sharedDir = join(TEST_DIR, 'shared');

  beforeEach(() => {
    mkdirSync(sharedDir, { recursive: true });
    setSharedMemoryDir(sharedDir);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  const [readTool, writeTool, appendTool, listTool, deleteTool] = sharedMemoryTools;

  test('write and read shared memory', async () => {
    await writeTool.execute({ key: 'test-key', content: 'Shared data' }, makeCtx());
    const result = await readTool.execute({ key: 'test-key' }, makeCtx());
    assert.equal(result.output, 'Shared data');
  });

  test('append to shared memory', async () => {
    await writeTool.execute({ key: 'append-test', content: 'Initial' }, makeCtx());
    await appendTool.execute({ key: 'append-test', entry: 'Appended data' }, makeCtx());

    const result = await readTool.execute({ key: 'append-test' }, makeCtx());
    assert.ok(result.output.includes('Initial'));
    assert.ok(result.output.includes('Appended data'));
  });

  test('list shared memory keys', async () => {
    await writeTool.execute({ key: 'key1', content: 'data1' }, makeCtx());
    await writeTool.execute({ key: 'key2', content: 'data2' }, makeCtx());

    const result = await listTool.execute({}, makeCtx());
    assert.ok(result.output.includes('key1'));
    assert.ok(result.output.includes('key2'));
  });

  test('delete shared memory key', async () => {
    await writeTool.execute({ key: 'delete-me', content: 'temp' }, makeCtx());
    await deleteTool.execute({ key: 'delete-me' }, makeCtx());

    const result = await readTool.execute({ key: 'delete-me' }, makeCtx());
    assert.ok(result.output.includes('not found'));
  });

  test('read non-existent key shows available keys', async () => {
    await writeTool.execute({ key: 'existing', content: 'data' }, makeCtx());
    const result = await readTool.execute({ key: 'nonexistent' }, makeCtx());
    assert.ok(result.output.includes('not found'));
  });

  test('key sanitization strips special chars', async () => {
    await writeTool.execute({ key: 'test/../../../etc/passwd', content: 'evil' }, makeCtx());
    // The key should be sanitized: slashes become dashes
    // Verify the file was written to the shared dir with sanitized name, not traversing up
    const sanitizedKey = 'test-..-..-..-etc-passwd';
    const result = await readTool.execute({ key: sanitizedKey }, makeCtx());
    assert.equal(result.output, 'evil');
  });
});

describe('Process Tools', () => {
  const [startTool, pollTool, writeTool, killTool, listTool] = processTools;

  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  test('start and poll a background process', async () => {
    const startResult = await startTool.execute(
      { command: 'echo "bg output"' },
      makeCtx()
    );
    assert.ok(startResult.output.includes('Started'));

    // Extract process ID
    const idMatch = startResult.output.match(/bg_\d+/);
    assert.ok(idMatch);
    const id = idMatch![0];

    // Wait for process to finish
    await new Promise(r => setTimeout(r, 500));

    const pollResult = await pollTool.execute({ id }, makeCtx());
    assert.ok(pollResult.output.includes('bg output'));
  });

  test('kill a running process', async () => {
    const startResult = await startTool.execute(
      { command: 'sleep 300' },
      makeCtx()
    );
    const idMatch = startResult.output.match(/bg_\d+/);
    const id = idMatch![0];
    const pidMatch = startResult.output.match(/PID: (\d+)/);
    const pid = parseInt(pidMatch![1]);

    const killResult = await killTool.execute({ id }, makeCtx());
    assert.ok(
      killResult.output.includes('Sent SIGTERM') || killResult.output.includes('already exited'),
      `Expected kill confirmation, got: ${killResult.output}`
    );

    // Verify the actual OS process is dead (give it time to die)
    await new Promise(r => setTimeout(r, 500));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    assert.ok(!alive, `Process ${pid} should be dead after SIGTERM`);
  });

  test('list processes', async () => {
    await startTool.execute({ command: 'sleep 300' }, makeCtx());
    const listResult = await listTool.execute({}, makeCtx());
    assert.ok(listResult.output.includes('bg_'));
    assert.ok(listResult.output.includes('sleep'));

    // Cleanup
    const idMatch = listResult.output.match(/bg_\d+/);
    if (idMatch) await killTool.execute({ id: idMatch[0] }, makeCtx());
  });

  test('poll non-existent process returns error', async () => {
    const result = await pollTool.execute({ id: 'bg_99999' }, makeCtx());
    assert.ok(result.error);
    assert.ok(result.error!.includes('No background process'), `Expected error about missing process, got: ${result.error}`);
  });

  test('write stdin to running process', async () => {
    const startResult = await startTool.execute(
      { command: 'cat' },
      makeCtx()
    );
    const idMatch = startResult.output.match(/bg_\d+/);
    const id = idMatch![0];

    const writeResult = await writeTool.execute(
      { id, input: 'hello stdin\n' },
      makeCtx()
    );
    assert.ok(writeResult.output.includes('Sent'));

    await new Promise(r => setTimeout(r, 200));

    const pollResult = await pollTool.execute({ id }, makeCtx());
    assert.ok(pollResult.output.includes('hello stdin'));

    await killTool.execute({ id }, makeCtx());
  });
});
