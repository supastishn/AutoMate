/**
 * TTS (Text-to-Speech) tool — ElevenLabs integration
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { Tool } from '../tool-registry.js';

interface TTSConfig {
  apiKey?: string;
  voice?: string;
  model?: string;
  outputDir?: string;
}

let ttsConfig: TTSConfig = {};

export function setTTSConfig(config: TTSConfig): void {
  ttsConfig = config;
}

export const ttsTools: Tool[] = [
  {
    name: 'tts',
    description: [
      'Text-to-Speech synthesis using ElevenLabs.',
      'Actions: speak, voices.',
      'speak — convert text to speech audio file (returns path to mp3).',
      'voices — list available voices.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: speak|voices',
        },
        text: { type: 'string', description: 'Text to convert to speech (for speak)' },
        voice: { type: 'string', description: 'Voice ID or name (for speak, default: Rachel)' },
        model: { type: 'string', description: 'Model ID (default: eleven_monolingual_v1)' },
      },
      required: ['action'],
    },
    async execute(params) {
      const action = params.action as string;
      const apiKey = ttsConfig.apiKey || process.env.ELEVENLABS_API_KEY;

      if (!apiKey) {
        return { output: '', error: 'ElevenLabs API key not configured. Set ELEVENLABS_API_KEY env var or configure in settings.' };
      }

      switch (action) {
        case 'speak': {
          const text = params.text as string;
          if (!text) return { output: '', error: 'text is required for speak' };

          const voice = (params.voice as string) || ttsConfig.voice || '21m00Tcm4TlvDq8ikWAM'; // Rachel
          const model = (params.model as string) || ttsConfig.model || 'eleven_monolingual_v1';

          try {
            const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
              method: 'POST',
              headers: {
                'Accept': 'audio/mpeg',
                'Content-Type': 'application/json',
                'xi-api-key': apiKey,
              },
              body: JSON.stringify({
                text,
                model_id: model,
                voice_settings: {
                  stability: 0.5,
                  similarity_boost: 0.5,
                },
              }),
            });

            if (!response.ok) {
              const err = await response.text();
              return { output: '', error: `ElevenLabs API error: ${response.status} ${err}` };
            }

            const audioBuffer = await response.arrayBuffer();
            const outputDir = ttsConfig.outputDir || join(homedir(), '.automate', 'tts');
            mkdirSync(outputDir, { recursive: true });

            const filename = `tts-${Date.now()}.mp3`;
            const filepath = join(outputDir, filename);
            writeFileSync(filepath, Buffer.from(audioBuffer));

            return { output: `Audio saved to: ${filepath}\nVoice: ${voice}\nText length: ${text.length} chars` };
          } catch (err) {
            return { output: '', error: `TTS failed: ${(err as Error).message}` };
          }
        }

        case 'voices': {
          try {
            const response = await fetch('https://api.elevenlabs.io/v1/voices', {
              headers: { 'xi-api-key': apiKey },
            });

            if (!response.ok) {
              return { output: '', error: `Failed to fetch voices: ${response.status}` };
            }

            const data = await response.json() as { voices: { voice_id: string; name: string; labels?: Record<string, string> }[] };
            const lines = data.voices.map(v => {
              const labels = v.labels ? Object.entries(v.labels).map(([k, val]) => `${k}:${val}`).join(', ') : '';
              return `  ${v.name} (${v.voice_id})${labels ? ` [${labels}]` : ''}`;
            });

            return { output: `Available voices:\n${lines.join('\n')}` };
          } catch (err) {
            return { output: '', error: `Failed to fetch voices: ${(err as Error).message}` };
          }
        }

        default:
          return { output: `Error: Unknown action "${action}". Valid: speak, voices` };
      }
    },
  },
];
