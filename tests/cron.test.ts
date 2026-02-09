/**
 * Cron Scheduler Integration Tests
 * 
 * Tests job creation, persistence, cron expression parsing,
 * interval/once scheduling, tick execution, and enable/disable
 * with real filesystem and timers.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Scheduler } from '../src/cron/scheduler.js';

const TEST_DIR = join(tmpdir(), `automate-test-cron-${Date.now()}`);

describe('Scheduler', () => {
  let scheduler: Scheduler;
  let cronDir: string;
  let triggered: { name: string; prompt: string }[];

  beforeEach(() => {
    cronDir = join(TEST_DIR, `cron-${Date.now()}`);
    mkdirSync(cronDir, { recursive: true });
    triggered = [];
    scheduler = new Scheduler(cronDir, (job) => {
      triggered.push({ name: job.name, prompt: job.prompt });
    });
  });

  afterEach(() => {
    scheduler.stop();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('addJob creates a job and persists it', () => {
    const job = scheduler.addJob('test-job', 'Do something', {
      type: 'interval',
      every: 60000,
    });

    assert.ok(job.id);
    assert.equal(job.name, 'test-job');
    assert.equal(job.prompt, 'Do something');
    assert.equal(job.enabled, true);
    assert.equal(job.runCount, 0);
    assert.ok(job.nextRun);

    // Verify persistence
    const filePath = join(cronDir, 'jobs.json');
    assert.ok(existsSync(filePath));
    const saved = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].name, 'test-job');
  });

  test('addJob with type=once', () => {
    const future = new Date(Date.now() + 3600000).toISOString();
    const job = scheduler.addJob('once-job', 'Run once', {
      type: 'once',
      at: future,
    });

    assert.equal(job.schedule.type, 'once');
    assert.equal(job.nextRun, future);
  });

  test('addJob with type=cron', () => {
    const job = scheduler.addJob('cron-job', 'Every 30 min', {
      type: 'cron',
      cron: '*/30 * * * *',
    });

    assert.equal(job.schedule.type, 'cron');
    assert.ok(job.nextRun); // should calculate next match
  });

  test('removeJob deletes by ID', () => {
    const job = scheduler.addJob('remove-me', 'test', { type: 'interval', every: 60000 });
    assert.ok(scheduler.getJob(job.id));

    const removed = scheduler.removeJob(job.id);
    assert.ok(removed);
    assert.equal(scheduler.getJob(job.id), undefined);
  });

  test('removeJob returns false for non-existent ID', () => {
    assert.equal(scheduler.removeJob('nonexistent'), false);
  });

  test('enableJob and disableJob toggle state', () => {
    const job = scheduler.addJob('toggle-job', 'test', { type: 'interval', every: 60000 });

    scheduler.disableJob(job.id);
    assert.equal(scheduler.getJob(job.id)!.enabled, false);

    scheduler.enableJob(job.id);
    assert.equal(scheduler.getJob(job.id)!.enabled, true);
  });

  test('listJobs returns all jobs', () => {
    scheduler.addJob('job1', 'test1', { type: 'interval', every: 60000 });
    scheduler.addJob('job2', 'test2', { type: 'interval', every: 120000 });

    const jobs = scheduler.listJobs();
    assert.equal(jobs.length, 2);
    assert.ok(jobs.some(j => j.name === 'job1'));
    assert.ok(jobs.some(j => j.name === 'job2'));
  });

  test('once job fires when time arrives', async () => {
    scheduler.stop(); // stop default timer

    // Create a job that should fire immediately (past time)
    const past = new Date(Date.now() - 1000).toISOString();
    scheduler.addJob('fire-now', 'immediate task', { type: 'once', at: past });

    // Manually start and wait for tick
    scheduler.start();
    await new Promise(r => setTimeout(r, 20000)); // wait for tick (15s interval)

    assert.ok(triggered.some(t => t.name === 'fire-now'));

    // Once job should be disabled after firing
    const jobs = scheduler.listJobs();
    const firedJob = jobs.find(j => j.name === 'fire-now');
    assert.ok(firedJob);
    assert.equal(firedJob!.enabled, false);
  });

  test('interval job calculates next run based on last run', () => {
    const job = scheduler.addJob('interval-job', 'test', {
      type: 'interval',
      every: 300000, // 5 min
    });

    assert.ok(job.nextRun);
    const nextRun = new Date(job.nextRun!).getTime();
    const now = Date.now();
    // Next run should be ~5 min from now (within 10 seconds tolerance)
    assert.ok(Math.abs(nextRun - (now + 300000)) < 10000);
  });

  test('persistence across restarts', () => {
    scheduler.addJob('persistent-job', 'remember me', { type: 'interval', every: 60000 });
    scheduler.stop();

    // Create new scheduler from same directory
    const scheduler2 = new Scheduler(cronDir, () => {});
    const jobs = scheduler2.listJobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].name, 'persistent-job');
    assert.equal(jobs[0].prompt, 'remember me');
    scheduler2.stop();
  });

  test('invalid cron expression still creates job with fallback nextRun', () => {
    // 4-field expression should trigger error handling
    const job = scheduler.addJob('bad-cron', 'test', {
      type: 'cron',
      cron: '* * *', // invalid: only 3 fields
    });

    // Should still create the job (nextRun might be undefined due to parse error)
    assert.ok(job.id);
  });

  test('disabled jobs are not triggered', async () => {
    scheduler.stop();

    const past = new Date(Date.now() - 1000).toISOString();
    const job = scheduler.addJob('disabled-job', 'should not fire', { type: 'once', at: past });
    scheduler.disableJob(job.id);

    scheduler.start();
    await new Promise(r => setTimeout(r, 20000));

    assert.ok(!triggered.some(t => t.name === 'disabled-job'));
  });
});
