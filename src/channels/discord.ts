import { Client, GatewayIntentBits, Events, type Message } from 'discord.js';
import type { Config } from '../config/schema.js';
import type { Agent } from '../agent/agent.js';

export class DiscordChannel {
  private client: Client;
  private config: Config;
  private agent: Agent;
  private ready = false;

  constructor(config: Config, agent: Agent) {
    this.config = config;
    this.agent = agent;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  async start(): Promise<void> {
    if (!this.config.channels.discord.token) {
      console.log('Discord: No token configured, skipping');
      return;
    }

    this.client.once(Events.ClientReady, (c) => {
      this.ready = true;
      console.log(`Discord: Logged in as ${c.user.tag}`);
    });

    this.client.on(Events.MessageCreate, (msg) => this.handleMessage(msg));

    await this.client.login(this.config.channels.discord.token);
  }

  private async handleMessage(msg: Message): Promise<void> {
    // Ignore bots
    if (msg.author.bot) return;

    // Check if it's a DM or mention
    const isDM = !msg.guild;
    const isMentioned = msg.mentions.has(this.client.user!);

    if (!isDM && !isMentioned) return;

    // Access control
    const allowFrom = this.config.channels.discord.allowFrom;
    if (!allowFrom.includes('*') && !allowFrom.includes(msg.author.id)) {
      return;
    }

    // Clean the message content (remove mention)
    let content = msg.content;
    if (isMentioned) {
      content = content.replace(/<@!?\d+>/g, '').trim();
    }
    if (!content) return;

    const sessionId = `discord:${isDM ? 'dm' : msg.guild!.id}:${msg.author.id}`;

    // Check commands
    if (content.startsWith('/')) {
      const cmdResult = this.agent.handleCommand(sessionId, content);
      if (cmdResult) {
        await this.sendMessage(msg, cmdResult);
        return;
      }
    }

    // Show typing
    await msg.channel.sendTyping();
    const typingInterval = setInterval(() => {
      msg.channel.sendTyping().catch(() => {});
    }, 8000);

    try {
      // Process with streaming - collect full response then send
      let fullResponse = '';
      const result = await this.agent.processMessage(sessionId, content, (chunk) => {
        fullResponse += chunk;
      });

      clearInterval(typingInterval);

      const response = result.content || fullResponse;
      if (response) {
        await this.sendMessage(msg, response);
      }
    } catch (err) {
      clearInterval(typingInterval);
      await this.sendMessage(msg, `Error: ${err}`);
    }
  }

  private async sendMessage(msg: Message, content: string): Promise<void> {
    // Discord has a 2000 char limit
    const chunks = this.chunkMessage(content, 1990);
    for (const chunk of chunks) {
      await msg.reply({ content: chunk, allowedMentions: { repliedUser: false } });
    }
  }

  private chunkMessage(content: string, maxLen: number): string[] {
    if (content.length <= maxLen) return [content];

    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      // Try to split at newline
      let splitIdx = remaining.lastIndexOf('\n', maxLen);
      if (splitIdx < maxLen / 2) {
        // Try space
        splitIdx = remaining.lastIndexOf(' ', maxLen);
      }
      if (splitIdx < maxLen / 2) {
        splitIdx = maxLen;
      }

      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx).trimStart();
    }

    return chunks;
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }
}
