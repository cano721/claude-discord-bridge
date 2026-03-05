import type { TextChannel, ThreadChannel } from 'discord.js';

export interface Task {
  id: string;
  prompt: string;
  projectDir: string;
  thread: ThreadChannel;
  status: 'running' | 'waiting_answer' | 'completed' | 'failed';
  startedAt: Date;
  pendingQuestion?: PendingQuestion;
}

export interface PendingQuestion {
  text: string;
  options?: string[];
  messageId: string;
}

export interface ClaudeEvent {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

export interface BridgeConfig {
  claudePath: string;
  defaultProjectDir?: string;
  maxConcurrentTasks: number;
  autoAnswerQuestions: boolean;
}

export interface ChannelConfig {
  commands: TextChannel;
  guildId: string;
}

export interface ParsedCommand {
  prompt: string;
  projectDir?: string;
}
