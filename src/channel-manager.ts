import {
  type Guild,
  type TextChannel,
  type ThreadChannel,
  ChannelType,
} from 'discord.js';

const CATEGORY_NAME = '🤖 Claude Agents';
const COMMANDS_CHANNEL = 'claude-commands';

export class ChannelManager {
  private guild: Guild;
  private commandsChannel: TextChannel | null = null;

  constructor(guild: Guild) {
    this.guild = guild;
  }

  async setup(): Promise<TextChannel> {
    // find or create category
    let category = this.guild.channels.cache.find(
      (c) => c.name === CATEGORY_NAME && c.type === ChannelType.GuildCategory
    );

    if (!category) {
      category = await this.guild.channels.create({
        name: CATEGORY_NAME,
        type: ChannelType.GuildCategory,
      });
    }

    // find or create commands channel
    let cmdChannel = this.guild.channels.cache.find(
      (c) => c.name === COMMANDS_CHANNEL && c.parentId === category!.id
    ) as TextChannel | undefined;

    if (!cmdChannel) {
      cmdChannel = await this.guild.channels.create({
        name: COMMANDS_CHANNEL,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: 'Claude Code에 작업을 요청하는 채널입니다. 메시지를 입력하면 작업이 시작됩니다.',
      });

      await cmdChannel.send({
        embeds: [{
          title: '🤖 Claude Discord Bridge',
          description: [
            '**사용법:**',
            '메시지를 입력하면 작업이 시작됩니다 (기본 프로젝트 디렉토리)',
            '`--project /path/to/project <프롬프트>` — 특정 프로젝트에서 작업',
            '`!stop <task-id>` — 특정 작업 중지',
            '`!stop` — 모든 작업 중지',
            '`!status` — 현재 실행 중인 작업 목록',
            '',
            '**작업이 시작되면:**',
            '- 자동으로 스레드가 생성됩니다',
            '- 에이전트 활동이 실시간으로 표시됩니다',
            '- 질문이 나오면 스레드에서 답변할 수 있습니다',
            '- 스레드에 메시지를 입력하면 세션이 이어집니다',
          ].join('\n'),
          color: 0x7C3AED,
        }],
      });
    }

    this.commandsChannel = cmdChannel;
    return cmdChannel;
  }

  async createTaskThread(taskId: string, prompt: string): Promise<ThreadChannel> {
    if (!this.commandsChannel) {
      throw new Error('Channels not set up. Call setup() first.');
    }

    const shortPrompt = prompt.length > 80 ? prompt.slice(0, 80) + '...' : prompt;
    const thread = await this.commandsChannel.threads.create({
      name: `🔄 ${shortPrompt}`,
      autoArchiveDuration: 1440, // 24h
      reason: `Task ${taskId}`,
    });

    await thread.send({
      embeds: [{
        title: '🚀 작업 시작',
        description: prompt,
        fields: [
          { name: 'Task ID', value: taskId, inline: true },
          { name: 'Status', value: '실행 중...', inline: true },
        ],
        color: 0x3B82F6,
        timestamp: new Date().toISOString(),
      }],
    });

    return thread;
  }

  async updateThreadName(thread: ThreadChannel, status: 'running' | 'completed' | 'failed'): Promise<void> {
    const currentName = thread.name.replace(/^[🔄✅❌]\s*/, '');
    const emoji = status === 'completed' ? '✅' : status === 'failed' ? '❌' : '🔄';
    try {
      await thread.setName(`${emoji} ${currentName}`);
    } catch {
      // thread name update may fail if too frequent
    }
  }

  getCommandsChannel(): TextChannel | null {
    return this.commandsChannel;
  }
}
