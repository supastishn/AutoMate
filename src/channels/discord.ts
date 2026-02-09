import {
  Client, GatewayIntentBits, Events, REST, Routes,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuInteraction,
  SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType,
  AttachmentBuilder,
  Message, ChannelType,
  type Interaction, type TextChannel, type ThreadChannel,
} from 'discord.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config/schema.js';
import type { Agent } from '../agent/agent.js';
import { setImageBroadcaster, type ImageEvent } from '../agent/tools/image-send.js';

// Track per-channel thread usage for auto-thread creation
interface ThreadTracker {
  messageCount: number;
  threadId?: string;
}

// Authorization level for a user
type AuthLevel = 'owner' | 'public' | 'denied';

export class DiscordChannel {
  private client: Client;
  private config: Config;
  private agent: Agent;
  private ready = false;
  private threadTrackers: Map<string, ThreadTracker> = new Map();
  private pendingImages: Map<string, ImageEvent[]> = new Map();
  // Track recently processed message IDs to detect edits
  private recentMessages: Map<string, { sessionId: string; content: string; userId: string }> = new Map();

  constructor(config: Config, agent: Agent) {
    this.config = config;
    this.agent = agent;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });
  }

  async start(): Promise<void> {
    if (!this.config.channels.discord.token) {
      console.log('Discord: No token configured, skipping');
      return;
    }

    this.client.once(Events.ClientReady, async (c) => {
      this.ready = true;
      console.log(`Discord: Logged in as ${c.user.tag}`);

      if (this.config.channels.discord.registerSlashCommands) {
        await this.registerSlashCommands();
      }
    });

    this.client.on(Events.MessageCreate, (msg) => this.handleMessage(msg));
    this.client.on(Events.InteractionCreate, (interaction) => this.handleInteraction(interaction));

    // Message edit tracking
    if (this.config.channels.discord.trackEdits) {
      this.client.on(Events.MessageUpdate, (oldMsg, newMsg) => this.handleMessageUpdate(oldMsg as Message, newMsg as Message));
    }

    // Message delete tracking
    if (this.config.channels.discord.trackDeletes) {
      this.client.on(Events.MessageDelete, (msg) => this.handleMessageDelete(msg as Message));
    }

    // Wire image broadcaster so Discord can send images as attachments
    const originalBroadcaster = this.getExistingImageBroadcaster();
    setImageBroadcaster((event: ImageEvent) => {
      const sessionId = event.sessionId;
      if (sessionId.startsWith('discord:')) {
        const existing = this.pendingImages.get(sessionId) || [];
        existing.push(event);
        this.pendingImages.set(sessionId, existing);
      }
      if (originalBroadcaster) originalBroadcaster(event);
    });

    await this.client.login(this.config.channels.discord.token);
  }

  private getExistingImageBroadcaster(): ((event: ImageEvent) => void) | null {
    return null;
  }

  // ── Slash & Context Menu Command Registration ──

  private async registerSlashCommands(): Promise<void> {
    const commands: any[] = [
      new SlashCommandBuilder()
        .setName('chat')
        .setDescription('Chat with the AI assistant')
        .addStringOption(opt =>
          opt.setName('message').setDescription('Your message').setRequired(true))
        .addAttachmentOption(opt =>
          opt.setName('image').setDescription('Attach an image to analyze').setRequired(false)),
      new SlashCommandBuilder()
        .setName('status')
        .setDescription('Show current session status'),
      new SlashCommandBuilder()
        .setName('reset')
        .setDescription('Reset your conversation session'),
      new SlashCommandBuilder()
        .setName('model')
        .setDescription('Show or switch the AI model')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Model name or index to switch to').setRequired(false)),
      new SlashCommandBuilder()
        .setName('elevated')
        .setDescription('Toggle elevated permissions')
        .addStringOption(opt =>
          opt.setName('mode').setDescription('on or off').setRequired(false)
            .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })),
      new SlashCommandBuilder()
        .setName('compact')
        .setDescription('Compact the conversation to save context'),
      // Context menu commands
      new ContextMenuCommandBuilder()
        .setName('Summarize')
        .setType(ApplicationCommandType.Message),
      new ContextMenuCommandBuilder()
        .setName('Explain')
        .setType(ApplicationCommandType.Message),
      new ContextMenuCommandBuilder()
        .setName('Translate')
        .setType(ApplicationCommandType.Message),
    ];

    try {
      const rest = new REST({ version: '10' }).setToken(this.config.channels.discord.token!);
      const clientId = this.config.channels.discord.clientId || this.client.user!.id;

      await rest.put(Routes.applicationCommands(clientId), {
        body: commands.map(c => c.toJSON()),
      });

      console.log(`Discord: Registered ${commands.length} slash/context commands`);
    } catch (err) {
      console.error(`Discord: Failed to register slash commands: ${err}`);
    }
  }

  // ── Interaction Handler ──

  private async handleInteraction(interaction: Interaction): Promise<void> {
    // Button interactions
    if (interaction.isButton()) {
      await this.handleButtonInteraction(interaction);
      return;
    }

    // Select menu interactions
    if (interaction.isStringSelectMenu()) {
      await this.handleSelectMenuInteraction(interaction);
      return;
    }

    // Context menu commands (right-click)
    if (interaction.isMessageContextMenuCommand()) {
      await this.handleContextMenuCommand(interaction);
      return;
    }

    // Slash commands
    if (!interaction.isChatInputCommand()) return;

    const sessionId = this.makeSessionId(interaction);

    if (!this.isUserAllowed(interaction.user.id) && !this.config.channels.discord.publicMode) {
      await interaction.reply({ content: 'You are not authorized.', ephemeral: true });
      return;
    }

    const cmdName = interaction.commandName;
    const isOwner = this.getUserAuthLevel(interaction.user.id) === 'owner';

    // Only owners can use admin commands
    if (['reset', 'elevated', 'compact', 'model'].includes(cmdName) && !isOwner) {
      await interaction.reply({ content: 'Only the bot owner can use this command.', ephemeral: true });
      return;
    }

    if (cmdName === 'status') {
      const result = this.agent.handleCommand(sessionId, '/status');
      await interaction.reply({
        embeds: [this.buildStatusEmbed(result || 'No active session.')],
        ephemeral: true,
      });
      return;
    }

    if (cmdName === 'reset') {
      this.agent.handleCommand(sessionId, '/new');
      this.threadTrackers.delete(sessionId);
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(0x4caf50)
          .setDescription('Session reset. Starting fresh.')],
        ephemeral: true,
      });
      return;
    }

    if (cmdName === 'model') {
      const name = interaction.options.getString('name');
      if (!name) {
        // Show model picker select menu
        const result = this.agent.handleCommand(sessionId, '/model list');
        if (result) {
          const providers = this.parseModelList(result);
          if (providers.length > 0) {
            const menu = new StringSelectMenuBuilder()
              .setCustomId('select_model')
              .setPlaceholder('Select a model...')
              .addOptions(providers.map(p => ({
                label: p.name,
                description: p.detail.slice(0, 100),
                value: p.name,
                default: p.active,
              })));

            await interaction.reply({
              embeds: [new EmbedBuilder().setColor(0x4fc3f7).setTitle('Select Model').setDescription(result)],
              components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
              ephemeral: true,
            });
            return;
          }
        }
        await interaction.reply({
          embeds: [new EmbedBuilder().setColor(0x4fc3f7).setTitle('Model').setDescription(result || 'Unknown')],
          ephemeral: true,
        });
        return;
      }
      const result = this.agent.handleCommand(sessionId, `/model ${name}`);
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x4fc3f7).setTitle('Model').setDescription(result || 'Unknown')],
        ephemeral: true,
      });
      return;
    }

    if (cmdName === 'elevated') {
      const mode = interaction.options.getString('mode');
      const cmd = mode ? `/elevated ${mode}` : '/elevated';
      const result = this.agent.handleCommand(sessionId, cmd);
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(mode === 'on' ? 0xff9800 : 0x4caf50)
          .setDescription(result || 'Unknown')],
        ephemeral: true,
      });
      return;
    }

    if (cmdName === 'compact') {
      const result = this.agent.handleCommand(sessionId, '/compact');
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x4fc3f7).setDescription(result || 'Compacted.')],
        ephemeral: true,
      });
      return;
    }

    if (cmdName === 'chat') {
      const message = interaction.options.getString('message', true);
      const imageAttachment = interaction.options.getAttachment('image');

      // Handle image attachment
      let fullMessage = message;
      if (imageAttachment && imageAttachment.contentType?.startsWith('image/')) {
        const imgPath = await this.downloadAttachment(imageAttachment.url, imageAttachment.name);
        fullMessage += `\n[User attached an image: ${imageAttachment.name} saved at ${imgPath}. Analyze it with analyze_image if relevant.]`;
      }

      await this.processSlashChat(interaction, sessionId, fullMessage, interaction.user.id);
    }
  }

  // ── Context Menu Commands ──

  private async handleContextMenuCommand(interaction: any): Promise<void> {
    const sessionId = this.makeSessionId(interaction);

    if (!this.isUserAllowed(interaction.user.id) && !this.config.channels.discord.publicMode) {
      await interaction.reply({ content: 'You are not authorized.', ephemeral: true });
      return;
    }

    const targetMessage = interaction.targetMessage as Message;
    const content = targetMessage.content;
    if (!content) {
      await interaction.reply({ content: 'No text content in this message.', ephemeral: true });
      return;
    }

    let prompt: string;
    switch (interaction.commandName) {
      case 'Summarize':
        prompt = `Please provide a concise summary of the following message:\n\n"${content}"`;
        break;
      case 'Explain':
        prompt = `Please explain the following message in simple terms:\n\n"${content}"`;
        break;
      case 'Translate':
        prompt = `Please translate the following message to English (or if already in English, translate to Spanish):\n\n"${content}"`;
        break;
      default:
        await interaction.reply({ content: 'Unknown command.', ephemeral: true });
        return;
    }

    await interaction.deferReply();

    try {
      const result = await this.processWithAuth(sessionId, interaction.user.id, prompt);
      const response = result.content || '(no response)';
      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(0x4fc3f7)
          .setTitle(interaction.commandName)
          .setDescription(response.slice(0, 4096))
          .setFooter({ text: `Original: "${content.slice(0, 100)}${content.length > 100 ? '...' : ''}"` })],
      });
    } catch (err) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0xf44336).setTitle('Error').setDescription(String(err).slice(0, 4096))],
      });
    }
  }

  // ── Select Menu Handler ──

  private async handleSelectMenuInteraction(interaction: StringSelectMenuInteraction): Promise<void> {
    const sessionId = this.makeSessionId(interaction);

    if (interaction.customId === 'select_model') {
      const selected = interaction.values[0];
      const result = this.agent.handleCommand(sessionId, `/model ${selected}`);
      await interaction.update({
        embeds: [new EmbedBuilder().setColor(0x4caf50).setDescription(result || `Switched to ${selected}`)],
        components: [],
      });
    }
  }

  // ── Button Handler ──

  private async handleButtonInteraction(interaction: any): Promise<void> {
    const customId = interaction.customId as string;
    const sessionId = this.makeSessionId(interaction);

    if (customId === 'btn_reset') {
      this.agent.handleCommand(sessionId, '/new');
      this.threadTrackers.delete(sessionId);
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x4caf50).setDescription('Session reset.')],
        ephemeral: true,
      });
    } else if (customId === 'btn_status') {
      const result = this.agent.handleCommand(sessionId, '/status');
      await interaction.reply({
        embeds: [this.buildStatusEmbed(result || 'No active session.')],
        ephemeral: true,
      });
    } else if (customId === 'btn_compact') {
      const result = this.agent.handleCommand(sessionId, '/compact');
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(0x4fc3f7).setDescription(result || 'Compacted.')],
        ephemeral: true,
      });
    } else {
      await interaction.reply({ content: 'Unknown action.', ephemeral: true });
    }
  }

  // ── Slash /chat Processing ──

  private async processSlashChat(interaction: any, sessionId: string, message: string, userId: string): Promise<void> {
    await interaction.deferReply();
    const discordConfig = this.config.channels.discord;

    try {
      let fullResponse = '';
      let lastEditTime = 0;
      const editInterval = discordConfig.streamEditInterval;

      const result = await this.processWithAuth(sessionId, userId, message, (chunk) => {
        fullResponse += chunk;

        if (discordConfig.streamEdits && fullResponse.length > 0) {
          const now = Date.now();
          if (now - lastEditTime > editInterval) {
            lastEditTime = now;
            const partial = this.truncateForDiscord(fullResponse);
            interaction.editReply({
              embeds: [this.buildResponseEmbed(partial + ' ...', message)],
            }).catch(() => {});
          }
        }
      });

      const response = result.content || fullResponse;
      if (!response) {
        await interaction.editReply({
          embeds: [new EmbedBuilder().setColor(0x888888).setDescription('(no response)')],
        });
        return;
      }

      const components = discordConfig.showButtons ? [this.buildActionRow()] : [];
      const embeds = this.buildResponseEmbeds(response, message, result.toolCalls);

      const images = this.pendingImages.get(sessionId) || [];
      this.pendingImages.delete(sessionId);
      const attachments = await this.buildAttachments(images);

      await interaction.editReply({ embeds, components, files: attachments });
    } catch (err) {
      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(0xf44336).setTitle('Error')
          .setDescription(`\`\`\`\n${String(err).slice(0, 4000)}\n\`\`\``)],
      });
    }
  }

  // ── Message Handler (DM / @mention) ──

  private async handleMessage(msg: Message): Promise<void> {
    if (msg.author.bot) return;

    const isDM = !msg.guild;
    const isMentioned = msg.mentions.has(this.client.user!);

    if (!isDM && !isMentioned) return;
    
    // In public mode, allow everyone to chat; otherwise check allowFrom
    const authLevel = this.getUserAuthLevel(msg.author.id);
    if (authLevel === 'denied' && !this.config.channels.discord.publicMode) return;
    // Even in public mode, respect channel restrictions
    if (!isDM && !this.isChannelAllowed(msg.channelId, msg.channel)) return;

    // Clean mention from content
    let content = msg.content;
    if (isMentioned) {
      content = content.replace(/<@!?\d+>/g, '').trim();
    }

    // Handle incoming attachments (images, files)
    const attachmentInfo = await this.processIncomingAttachments(msg);
    if (attachmentInfo) {
      content = (content || '') + '\n' + attachmentInfo;
    }

    if (!content.trim()) return;

    const sessionId = `discord:${isDM ? 'dm' : msg.guild!.id}:${msg.author.id}`;
    const discordConfig = this.config.channels.discord;

    // Track this message for edit/delete detection
    this.recentMessages.set(msg.id, { sessionId, content, userId: msg.author.id });
    // Limit tracked messages to 500
    if (this.recentMessages.size > 500) {
      const firstKey = this.recentMessages.keys().next().value;
      if (firstKey) this.recentMessages.delete(firstKey);
    }

    // Handle text-based slash commands (owner-only)
    if (content.startsWith('/')) {
      const isOwner = this.getUserAuthLevel(msg.author.id) === 'owner';
      if (!isOwner) {
        await msg.reply({
          content: 'Only the bot owner can use commands.',
          allowedMentions: { repliedUser: false },
        });
        return;
      }
      const cmdResult = this.agent.handleCommand(sessionId, content);
      if (cmdResult) {
        if (discordConfig.useEmbeds) {
          await msg.reply({
            embeds: [this.buildCommandEmbed(content, cmdResult)],
            allowedMentions: { repliedUser: false },
          });
        } else {
          await this.sendPlainMessage(msg, cmdResult);
        }
        return;
      }
    }

    // React to show we're processing
    if (discordConfig.reactOnReceive) {
      await msg.react('\u{1F440}').catch(() => {});
    }

    // Show typing
    await (msg.channel as any).sendTyping();
    const typingInterval = setInterval(() => {
      (msg.channel as any).sendTyping().catch(() => {});
    }, 8000);

    try {
      // Check if we should use a thread
      let thread: ThreadChannel | null = null;
      if (discordConfig.useThreads && !isDM && msg.channel.type === ChannelType.GuildText) {
        const t = await this.getOrCreateThread(msg, sessionId);
        if (t !== msg) thread = t as ThreadChannel;
      }

      let fullResponse = '';
      const sentMessages: Message[] = [];
      let lastEditTime = 0;
      const editInterval = discordConfig.streamEditInterval;

      const sendPartial = (text: string) => {
        const partial = this.truncateForDiscord(text);
        const embedOpts = discordConfig.useEmbeds
          ? { embeds: [this.buildResponseEmbed(partial + ' ...', content)] }
          : { content: partial + ' ...' };

        if (thread) {
          return thread.send({ ...embedOpts, embeds: embedOpts.embeds || [] });
        }
        return msg.reply({ ...embedOpts, embeds: embedOpts.embeds || [], allowedMentions: { repliedUser: false } });
      };

      const result = await this.processWithAuth(sessionId, msg.author.id, content, (chunk) => {
        fullResponse += chunk;

        if (discordConfig.streamEdits && fullResponse.length > 20) {
          const now = Date.now();
          if (now - lastEditTime > editInterval) {
            lastEditTime = now;

            if (sentMessages.length > 0) {
              const partial = this.truncateForDiscord(fullResponse);
              const sm = sentMessages[0];
              if (discordConfig.useEmbeds) {
                sm.edit({ embeds: [this.buildResponseEmbed(partial + ' ...', content)] }).catch(() => {});
              } else {
                sm.edit(partial + ' ...').catch(() => {});
              }
            } else {
              sendPartial(fullResponse).then(m => { sentMessages.push(m); }).catch(() => {});
            }
          }
        }
      });

      clearInterval(typingInterval);

      if (discordConfig.reactOnReceive) {
        msg.reactions.cache.get('\u{1F440}')?.users.remove(this.client.user!).catch(() => {});
      }

      const response = result.content || fullResponse;
      if (!response) return;

      const components = discordConfig.showButtons ? [this.buildActionRow()] : [];
      const embeds = discordConfig.useEmbeds
        ? this.buildResponseEmbeds(response, content, result.toolCalls)
        : [];

      const images = this.pendingImages.get(sessionId) || [];
      this.pendingImages.delete(sessionId);
      const attachments = await this.buildAttachments(images);

      const finalOpts = {
        embeds: embeds.length > 0 ? embeds : [],
        content: embeds.length === 0 ? this.truncateForDiscord(response) : undefined,
        components,
        files: attachments,
      };

      if (sentMessages.length > 0) {
        await sentMessages[0].edit(finalOpts).catch(() => {});
      } else if (thread) {
        await thread.send(finalOpts);
      } else {
        await msg.reply({ ...finalOpts, allowedMentions: { repliedUser: false } });
      }

      await msg.react('\u2705').catch(() => {});

    } catch (err) {
      clearInterval(typingInterval);
      if (discordConfig.useEmbeds) {
        await msg.reply({
          embeds: [new EmbedBuilder()
            .setColor(0xf44336).setTitle('Error')
            .setDescription(`\`\`\`\n${String(err).slice(0, 4000)}\n\`\`\``)],
          allowedMentions: { repliedUser: false },
        });
      } else {
        await this.sendPlainMessage(msg, `Error: ${err}`);
      }
    }
  }

  // ── Incoming Attachment Processing ──

  private async processIncomingAttachments(msg: Message): Promise<string | null> {
    if (!msg.attachments || msg.attachments.size === 0) return null;

    const parts: string[] = [];
    const uploadDir = join(this.config.memory.directory, 'uploads');
    mkdirSync(uploadDir, { recursive: true });

    for (const [, attachment] of msg.attachments) {
      try {
        const filePath = await this.downloadAttachment(attachment.url, attachment.name);
        const isImage = attachment.contentType?.startsWith('image/') || false;

        if (isImage) {
          parts.push(
            `[User attached image: ${attachment.name} (${this.formatBytes(attachment.size)}). ` +
            `Saved at ${filePath}. You can analyze it with the analyze_image tool.]`
          );
        } else {
          parts.push(
            `[User attached file: ${attachment.name} (${this.formatBytes(attachment.size)}, ${attachment.contentType || 'unknown'}). ` +
            `Saved at ${filePath}. You can read it with the read_file tool.]`
          );
        }
      } catch (err) {
        parts.push(`[Failed to download attachment ${attachment.name}: ${err}]`);
      }
    }

    return parts.length > 0 ? parts.join('\n') : null;
  }

  private async downloadAttachment(url: string, filename: string): Promise<string> {
    const uploadDir = join(this.config.memory.directory, 'uploads');
    mkdirSync(uploadDir, { recursive: true });

    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    const safeName = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const filePath = join(uploadDir, safeName);
    writeFileSync(filePath, buffer);
    return filePath;
  }

  // ── Message Edit Tracking ──

  private async handleMessageUpdate(oldMsg: Message, newMsg: Message): Promise<void> {
    if (!newMsg.author || newMsg.author.bot) return;
    if (!newMsg.content) return;

    const tracked = this.recentMessages.get(newMsg.id);
    if (!tracked) return; // We didn't process this message originally

    const oldContent = tracked.content;
    const newContent = newMsg.content.replace(/<@!?\d+>/g, '').trim();

    if (oldContent === newContent) return;

    // Update tracked content
    tracked.content = newContent;

    // Inform the agent about the edit
    const editNotice = `[The user edited their previous message. Original: "${oldContent.slice(0, 200)}". Updated to: "${newContent.slice(0, 200)}". Please adjust your understanding accordingly.]`;

    try {
      const result = await this.processWithAuth(tracked.sessionId, tracked.userId, editNotice);
      const response = result.content;
      if (response) {
        const discordConfig = this.config.channels.discord;
        if (discordConfig.useEmbeds) {
          await newMsg.reply({
            embeds: [new EmbedBuilder()
              .setColor(0xff9800)
              .setAuthor({ name: this.agent.getAgentName() || 'AutoMate' })
              .setDescription(response.slice(0, 4096))
              .setFooter({ text: 'Response to edited message' })],
            allowedMentions: { repliedUser: false },
          });
        } else {
          await newMsg.reply({
            content: this.truncateForDiscord(response),
            allowedMentions: { repliedUser: false },
          });
        }
      }
    } catch (err) {
      console.error(`Discord: Failed to handle message edit: ${err}`);
    }
  }

  // ── Message Delete Tracking ──

  private async handleMessageDelete(msg: Message): Promise<void> {
    const tracked = this.recentMessages.get(msg.id);
    if (!tracked) return;

    // Inform the agent the user deleted their message
    const deleteNotice = `[The user deleted their previous message: "${tracked.content.slice(0, 200)}". You can disregard it.]`;
    this.recentMessages.delete(msg.id);

    try {
      await this.processWithAuth(tracked.sessionId, tracked.userId, deleteNotice);
    } catch {
      // Silent fail for delete notifications
    }
  }

  // ── Proactive Messaging ──

  /** Send a proactive message to the configured Discord channel (for cron/heartbeat results) */
  async sendProactive(content: string, sessionId?: string): Promise<void> {
    const channelId = this.config.channels.discord.proactiveChannelId;
    if (!channelId || !this.ready) return;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return;

      const embeds = this.config.channels.discord.useEmbeds
        ? this.buildResponseEmbeds(content)
        : [];

      await (channel as TextChannel).send({
        embeds: embeds.length > 0 ? embeds : [],
        content: embeds.length === 0 ? this.truncateForDiscord(content) : undefined,
      });
    } catch (err) {
      console.error(`Discord: Failed to send proactive message: ${err}`);
    }
  }

  /** Check if this channel is ready for proactive messages */
  isReady(): boolean {
    return this.ready;
  }

  /** Get the client for external use */
  getClient(): Client {
    return this.client;
  }

  // ── Thread Management ──

  private async getOrCreateThread(msg: Message, sessionId: string): Promise<Message | ThreadChannel> {
    const tracker = this.threadTrackers.get(sessionId) || { messageCount: 0 };
    tracker.messageCount++;
    this.threadTrackers.set(sessionId, tracker);

    const threshold = this.config.channels.discord.threadThreshold;

    if (tracker.threadId) {
      try {
        const thread = await msg.guild!.channels.fetch(tracker.threadId);
        if (thread && thread.isThread() && !thread.archived) {
          return thread as ThreadChannel;
        }
      } catch {
        tracker.threadId = undefined;
      }
    }

    if (tracker.messageCount >= threshold && msg.channel.type === ChannelType.GuildText) {
      try {
        const agentName = this.getAgentNameForGuild(msg.guild?.id) || 'AutoMate';
        const thread = await (msg.channel as TextChannel).threads.create({
          name: `${agentName} - ${msg.author.displayName}`,
          autoArchiveDuration: 60,
          reason: 'Auto-created for extended conversation',
        });
        tracker.threadId = thread.id;
        return thread;
      } catch {
        // Fallback to regular reply
      }
    }

    return msg;
  }

  // ── Per-Server Overrides ──

  private getAgentNameForGuild(guildId?: string): string {
    if (guildId) {
      const override = this.config.channels.discord.serverOverrides[guildId];
      if (override?.agentName) return override.agentName;
    }
    return this.agent.getAgentName() || 'AutoMate';
  }

  // ── Embed Builders ──

  private buildResponseEmbed(content: string, userMessage?: string): EmbedBuilder {
    const name = this.agent.getAgentName() || 'AutoMate';
    return new EmbedBuilder()
      .setColor(0x4fc3f7)
      .setAuthor({ name })
      .setDescription(content.slice(0, 4096));
  }

  private buildResponseEmbeds(
    response: string,
    userMessage?: string,
    toolCalls?: { name: string; result: string }[],
  ): EmbedBuilder[] {
    const embeds: EmbedBuilder[] = [];
    const name = this.agent.getAgentName() || 'AutoMate';
    const chunks = this.chunkText(response, 4000);

    for (let i = 0; i < chunks.length && i < 10; i++) {
      const embed = new EmbedBuilder()
        .setColor(0x4fc3f7)
        .setDescription(chunks[i]);

      if (i === 0) embed.setAuthor({ name });

      if (i === chunks.length - 1 && toolCalls && toolCalls.length > 0) {
        const toolNames = toolCalls.map(t => `\`${t.name}\``).join(', ');
        embed.setFooter({ text: `Tools: ${toolNames.slice(0, 2000)}` });
      }

      embeds.push(embed);
    }

    return embeds.length > 0 ? embeds : [
      new EmbedBuilder().setColor(0x888888).setDescription('(no response)'),
    ];
  }

  private buildStatusEmbed(status: string): EmbedBuilder {
    const embed = new EmbedBuilder().setColor(0x4fc3f7).setTitle('Session Status');
    const lines = status.split('\n');
    for (const line of lines) {
      const [key, ...valueParts] = line.split(':');
      if (key && valueParts.length > 0) {
        embed.addFields({ name: key.trim(), value: valueParts.join(':').trim(), inline: true });
      }
    }
    return embed;
  }

  private buildCommandEmbed(command: string, result: string): EmbedBuilder {
    return new EmbedBuilder()
      .setColor(0x9c27b0)
      .setTitle(`Command: ${command}`)
      .setDescription(result.slice(0, 4096));
  }

  // ── Action Row / Buttons ──

  private buildActionRow(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('btn_reset')
          .setLabel('Reset')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('\u{1F504}'),
        new ButtonBuilder()
          .setCustomId('btn_status')
          .setLabel('Status')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('\u{1F4CA}'),
        new ButtonBuilder()
          .setCustomId('btn_compact')
          .setLabel('Compact')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('\u{1F4E6}'),
      );
  }

  // ── Image/File Attachment Builder ──

  private async buildAttachments(images: ImageEvent[]): Promise<AttachmentBuilder[]> {
    const attachments: AttachmentBuilder[] = [];

    for (const img of images) {
      try {
        if (img.base64) {
          const buf = Buffer.from(img.base64, 'base64');
          const ext = img.mimeType?.split('/')[1] || 'png';
          const filename = img.filename || `image.${ext}`;
          attachments.push(new AttachmentBuilder(buf, { name: filename, description: img.alt }));
        } else if (img.url) {
          if (img.url.startsWith('file://') || img.url.startsWith('/')) {
            const filePath = img.url.replace('file://', '');
            const buf = readFileSync(filePath);
            const filename = img.filename || filePath.split('/').pop() || 'image.png';
            attachments.push(new AttachmentBuilder(buf, { name: filename, description: img.alt }));
          } else {
            attachments.push(new AttachmentBuilder(img.url, {
              name: img.filename || 'image.png',
              description: img.alt,
            }));
          }
        }
      } catch (err) {
        console.error(`Discord: Failed to build attachment: ${err}`);
      }
    }

    return attachments;
  }

  // ── Helpers ──

  private parseModelList(result: string): { name: string; detail: string; active: boolean }[] {
    const lines = result.split('\n');
    const providers: { name: string; detail: string; active: boolean }[] = [];
    for (const line of lines) {
      const match = line.match(/^\s*(>?)\s*\d+:\s*(\S+)\s*(.*)$/);
      if (match) {
        providers.push({
          name: match[2],
          detail: match[3] || match[2],
          active: match[1] === '>',
        });
      }
    }
    return providers;
  }

  private makeSessionId(interaction: any): string {
    const isDM = !interaction.guild;
    const userId = interaction.user?.id || interaction.author?.id;
    return `discord:${isDM ? 'dm' : interaction.guild!.id}:${userId}`;
  }

  private isUserAllowed(userId: string): boolean {
    const allowFrom = this.config.channels.discord.allowFrom;
    return allowFrom.includes('*') || allowFrom.includes(userId);
  }

  /** Check if user is an owner (full tool access) or public (restricted) */
  private getUserAuthLevel(userId: string): AuthLevel {
    const discordConfig = this.config.channels.discord;
    
    // First check if user is allowed at all
    if (!this.isUserAllowed(userId)) {
      return 'denied';
    }
    
    // If public mode is disabled, all allowed users are owners
    if (!discordConfig.publicMode) {
      return 'owner';
    }
    
    // Check owner IDs - if empty, fall back to allowFrom list
    const ownerIds = discordConfig.ownerIds || [];
    if (ownerIds.length === 0) {
      // No explicit owners = allowFrom users are owners
      const allowFrom = discordConfig.allowFrom;
      if (allowFrom.includes(userId)) {
        return 'owner';
      }
      // '*' means everyone can chat but only explicit allowFrom get owner
      return 'public';
    }
    
    // Explicit owner check
    if (ownerIds.includes(userId)) {
      return 'owner';
    }
    
    return 'public';
  }

  /** Get the tools allowed for public users */
  private getPublicTools(): string[] {
    return this.config.channels.discord.publicTools || [
      'read_file', 'list_directory', 'search_files', 'web_search', 'analyze_image',
    ];
  }

  /** Process message based on user's auth level */
  private async processWithAuth(
    sessionId: string,
    userId: string,
    content: string,
    onStream?: (chunk: string) => void,
  ): Promise<{ content: string; toolCalls: { name: string; result: string }[] }> {
    const authLevel = this.getUserAuthLevel(userId);
    
    if (authLevel === 'denied') {
      return { content: 'You are not authorized to use this bot.', toolCalls: [] };
    }
    
    if (authLevel === 'owner') {
      // Full access
      return this.agent.processMessage(sessionId, content, onStream);
    }
    
    // Public user - restricted tools
    const publicTools = this.getPublicTools();
    return this.agent.processMessageRestricted(sessionId, content, publicTools, onStream);
  }

  private isChannelAllowed(channelId: string, channel: any): boolean {
    const allowChannels = this.config.channels.discord.allowChannels;
    if (allowChannels.includes('*')) return true;
    if (allowChannels.includes(channelId)) return true;
    if (channel.parentId && allowChannels.includes(channel.parentId)) return true;
    return false;
  }

  private truncateForDiscord(text: string, maxLen = 2000): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 15) + '\n... (truncated)';
  }

  private chunkText(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      let splitIdx = remaining.lastIndexOf('\n```', maxLen);
      if (splitIdx > maxLen / 3) {
        splitIdx += 1;
      } else {
        splitIdx = remaining.lastIndexOf('\n', maxLen);
        if (splitIdx < maxLen / 3) splitIdx = remaining.lastIndexOf(' ', maxLen);
        if (splitIdx < maxLen / 3) splitIdx = maxLen;
      }

      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx).trimStart();
    }

    return chunks;
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  private async sendPlainMessage(msg: Message, content: string): Promise<void> {
    const name = this.agent.getAgentName();
    const prefixed = name ? `**[${name}]** ${content}` : content;
    const chunks = this.chunkText(prefixed, 1990);
    for (const chunk of chunks) {
      await msg.reply({ content: chunk, allowedMentions: { repliedUser: false } });
    }
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }
}
