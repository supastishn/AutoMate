#!/usr/bin/env node
// Launcher for AutoMate - ensures proper ESM loading
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Register tsx for TypeScript support
try {
  register('tsx/esm', pathToFileURL('./'));
} catch {
  // tsx might already be registered
}

// Import and run the main entry
const main = await import('./src/index.ts');
