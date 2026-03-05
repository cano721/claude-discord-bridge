import { Client, GatewayIntentBits, Events, type Message } from 'discord.js';
import { config } from 'dotenv';
import path from 'path';
import { existsSync, statSync } from 'fs';
import { ChannelManager } from './channel-manager.js';
import { TaskManager } from './task-manager.js';
import type { BridgeConfig, ParsedCommand } from './types.js';

config();

// --- Config ---
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error('DISCORD_BOT_TOKEN and DISCORD_GUILD_ID are required in .env');
  process.exit(1);
}

// --- Authorization ---
const AUTHORIZED_USER_IDS = new Set(
  (process.env.AUTHORIZED_USER_IDS || '').split(',').filter(Boolean)
);

function isAuthorized(message: Message): boolean {
  // If no authorized users configured, allow all (backward compatible)
  if (AUTHORIZED_USER_IDS.size === 0) return true;
  return AUTHORIZED_USER_IDS.has(message.author.id);
}

// --- Project directory validation ---
const ALLOWED_PROJECT_ROOTS = (process.env.ALLOWED_PROJECT_ROOTS || '')
  .split(':')
  .filter(Boolean)
  .map(r => path.resolve(r));

function validateProjectDir(raw: string): string {
  const resolved = path.resolve(raw);
  if (ALLOWED_PROJECT_ROOTS.length > 0) {
    const isAllowed = ALLOWED_PROJECT_ROOTS.some(
      root => resolved === root || resolved.startsWith(root + path.sep)
    );
    if (!isAllowed) {
      throw new Error(`프로젝트 경로 '${resolved}'는 허용된 범위 밖입니다.`);
    }
  }
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`프로젝트 경로 '${resolved}'가 존재하지 않거나 디렉토리가 아닙니다.`);
  }
  return resolved;
}

const bridgeConfig: BridgeConfig = {
  claudePath: process.env.CLAUDE_PATH || 'claude',
  defaultProjectDir: process.env.DEFAULT_PROJECT_DIR || undefined,
  maxConcurrentTasks: parseInt(process.env.MAX_CONCURRENT_TASKS || '3', 10),
  autoAnswerQuestions: process.env.AUTO_ANSWER_QUESTIONS === 'true',
};

// --- Discord Client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let channelManager: ChannelManager;
let taskManager: TaskManager;

// --- Bot Ready ---
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot logged in as ${c.user.tag}`);

  const guild = c.guilds.cache.get(GUILD_ID);
  if (!guild) {
    console.error(`Guild ${GUILD_ID} not found`);
    process.exit(1);
  }

  channelManager = new ChannelManager(guild);
  await channelManager.setup();
  taskManager = new TaskManager(bridgeConfig, channelManager);

  console.log(`✅ Channels ready in "${guild.name}"`);
  console.log(`📋 Config: maxTasks=${bridgeConfig.maxConcurrentTasks}, autoAnswer=${bridgeConfig.autoAnswerQuestions}`);
  if (bridgeConfig.defaultProjectDir) {
    console.log(`📁 Default project: ${bridgeConfig.defaultProjectDir}`);
  }
});

// --- Message Handler ---
client.on(Events.MessageCreate, async (message: Message) => {
  try {
  if (message.author.bot) return;
  if (!taskManager) return;
  if (!isAuthorized(message)) return;

  const content = message.content.trim();

  // --- Commands in main channel ---
  const commandsChannel = channelManager.getCommandsChannel();

  if (message.channelId === commandsChannel?.id) {
    // !stop command
    if (content === '!stop' || content.startsWith('!stop ')) {
      const taskId = content.slice(5).trim();
      if (taskId) {
        const stopped = taskManager.stopTask(taskId);
        await message.reply(stopped ? `⏹️ ${taskId} 중지됨` : `❌ ${taskId}를 찾을 수 없습니다`);
      } else {
        // stop all
        const running = taskManager.getRunningTasks();
        for (const t of running) taskManager.stopTask(t.id);
        await message.reply(`⏹️ ${running.length}개 작업 모두 중지됨`);
      }
      return;
    }

    // !status command
    if (content === '!status') {
      await handleStatusCommand(message);
      return;
    }

    // Everything else → treat as task prompt
    if (content) {
      await handleTaskCommand(message, content);
      return;
    }

    return;
  }

  // --- Messages in task threads ---
  if (message.channel.isThread()) {
    const task = taskManager.findTaskByThread(message.channelId);
    if (!task) return;

    // if waiting for answer, treat as answer
    if (task.status === 'waiting_answer') {
      const answered = taskManager.answerQuestion(task.id, content);
      await message.react(answered ? '✅' : '⚠️');
      return;
    }

    // if running, wait then auto-resume after completion
    if (task.status === 'running') {
      const queued = taskManager.queueFollowUp(task.id, content);
      await message.react(queued ? '⏳' : '⚠️');
      if (!queued) await message.reply('⚠️ 대기열이 가득 찼습니다. 현재 작업 완료 후 다시 시도해주세요.');
      return;
    }

    // completed/failed → resume same session
    await message.react('🔄');
    const sent = taskManager.sendFollowUp(task.id, content);
    if (!sent) {
      await message.reply('❌ 세션 재개에 실패했습니다.');
    }
  }
  } catch (err) {
    console.error(`Message handler error: ${err}`);
  }
});

// --- Command Handlers ---

function parseCommand(input: string): ParsedCommand {
  const projectMatch = input.match(/^--project\s+(\S+)\s+(.+)$/s);
  if (projectMatch) {
    return { projectDir: projectMatch[1], prompt: projectMatch[2] };
  }
  return { prompt: input };
}

async function handleTaskCommand(message: Message, input: string): Promise<void> {
  const { prompt, projectDir: rawProjectDir } = parseCommand(input);

  if (!prompt) {
    await message.reply('❌ 메시지를 입력해주세요.');
    return;
  }

  if (!rawProjectDir && !bridgeConfig.defaultProjectDir) {
    await message.reply(
      '❌ 프로젝트 경로를 지정해주세요.\n' +
      '`--project /path/to/project 프롬프트`\n' +
      '또는 `.env`에 `DEFAULT_PROJECT_DIR`을 설정하세요.'
    );
    return;
  }

  let projectDir: string | undefined;
  if (rawProjectDir) {
    try {
      projectDir = validateProjectDir(rawProjectDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await message.reply(`❌ ${msg}`);
      return;
    }
  }

  try {
    const task = await taskManager.startTask(prompt, projectDir);
    await message.reply(`✅ 작업 시작됨 → ${task.thread}`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await message.reply(`❌ 작업 시작 실패: ${errorMsg}`);
  }
}

async function handleStatusCommand(message: Message): Promise<void> {
  const running = taskManager.getRunningTasks();

  if (running.length === 0) {
    await message.reply('📋 실행 중인 작업이 없습니다.');
    return;
  }

  const lines = running.map((t) => {
    const elapsed = Math.round((Date.now() - t.startedAt.getTime()) / 1000 / 60);
    const statusEmoji = t.status === 'waiting_answer' ? '❓' : '🔄';
    const displayPrompt = t.prompt.length > 50 ? t.prompt.slice(0, 50) + '...' : t.prompt;
    return `${statusEmoji} **${t.id}** — ${displayPrompt} (${elapsed}분 경과) → ${t.thread}`;
  });

  await message.reply({
    embeds: [{
      title: '📋 실행 중인 작업',
      description: lines.join('\n'),
      color: 0x3B82F6,
    }],
  });
}

// --- Graceful Shutdown ---
function shutdown() {
  console.log('\n🛑 Shutting down...');
  if (taskManager) {
    const running = taskManager.getRunningTasks();
    for (const task of running) {
      taskManager.stopTask(task.id);
    }
    taskManager.stopAll();
  }
  client.destroy();
  // Let event loop drain for child process cleanup, then force exit
  setTimeout(() => {
    console.log('Force exiting after timeout');
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Start ---
client.login(DISCORD_TOKEN);
