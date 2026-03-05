import type { ThreadChannel } from 'discord.js';
import { ClaudeBridge } from './claude-bridge.js';
import { formatForDiscord, type FormattedOutput } from './output-parser.js';
import { ChannelManager } from './channel-manager.js';
import type { Task, BridgeConfig } from './types.js';

export class TaskManager {
  private tasks = new Map<string, Task>();
  private bridges = new Map<string, ClaudeBridge>();
  private pendingFollowUps = new Map<string, string[]>();
  private lockedTasks = new Set<string>();
  private coordinators = new Set<ClaudeBridge>();
  private config: BridgeConfig;
  private channelManager: ChannelManager;
  private taskCounter = 0;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(config: BridgeConfig, channelManager: ChannelManager) {
    this.config = config;
    this.channelManager = channelManager;

    // Cleanup completed tasks older than 24h every hour
    this.cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const [id, task] of this.tasks) {
        if ((task.status === 'completed' || task.status === 'failed')
            && task.startedAt.getTime() < cutoff) {
          this.tasks.delete(id);
          this.bridges.delete(id);
          this.pendingFollowUps.delete(id);
        }
      }
    }, 60 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  async startTask(prompt: string, projectDir?: string): Promise<Task> {
    if (this.getRunningCount() >= this.config.maxConcurrentTasks) {
      throw new Error(`최대 동시 작업 수(${this.config.maxConcurrentTasks})에 도달했습니다.`);
    }

    const taskId = `task-${++this.taskCounter}`;
    const dir = projectDir || this.config.defaultProjectDir || process.cwd();

    // Reserve slot immediately before any await to prevent TOCTOU race
    const placeholder: Task = {
      id: taskId,
      prompt,
      projectDir: dir,
      thread: null as unknown as import('discord.js').ThreadChannel,
      status: 'running',
      startedAt: new Date(),
    };
    this.tasks.set(taskId, placeholder);

    let thread: import('discord.js').ThreadChannel;
    try {
      thread = await this.channelManager.createTaskThread(taskId, prompt);
    } catch (err) {
      this.tasks.delete(taskId);
      throw err;
    }

    const task: Task = { ...placeholder, thread };
    this.tasks.set(taskId, task);

    const bridge = new ClaudeBridge(this.config.claudePath, dir);
    this.bridges.set(taskId, bridge);

    this.setupBridgeListeners(taskId, bridge, thread);

    bridge.start(prompt);

    return task;
  }

  private setupBridgeListeners(taskId: string, bridge: ClaudeBridge, thread: ThreadChannel): void {
    const messageQueue: string[] = [];
    let sending = false;

    // #8: Cap message queue size to prevent OOM
    const MAX_QUEUE_SIZE = 200;

    const sendToThread = async (content: string) => {
      if (messageQueue.length >= MAX_QUEUE_SIZE) {
        messageQueue.splice(0, messageQueue.length - MAX_QUEUE_SIZE + 1);
        messageQueue.unshift('⚠️ *(출력이 너무 많아 일부가 생략되었습니다)*');
      }
      messageQueue.push(content);
      if (sending) return;
      sending = true;

      while (messageQueue.length > 0) {
        const batch: string[] = [];
        let batchLength = 0;

        // batch messages to avoid rate limits
        while (messageQueue.length > 0 && batchLength < 1800) {
          const next = messageQueue[0]!;
          if (batchLength + next.length > 1900 && batch.length > 0) break;
          batch.push(messageQueue.shift()!);
          batchLength += next.length + 1;
        }

        if (batch.length > 0) {
          try {
            await thread.send(batch.join('\n'));
          } catch (err) {
            console.error(`Failed to send to thread: ${err}`);
          }
        }

        // rate limit buffer
        await new Promise((r) => setTimeout(r, 1000));
      }

      sending = false;
    };

    bridge.on('started', () => {
      sendToThread('⏳ Claude Code 프로세스 시작됨...');
    });

    bridge.on('output', (parsed: FormattedOutput) => {
      const formatted = formatForDiscord(parsed);
      sendToThread(formatted);
    });

    bridge.on('question', (parsed: FormattedOutput) => {
      const task = this.tasks.get(taskId);
      if (task) {
        task.status = 'waiting_answer';
        task.pendingQuestion = {
          text: parsed.content,
          options: parsed.questionOptions,
          messageId: '',
        };
      }

      const formatted = formatForDiscord(parsed);
      sendToThread(formatted);

      if (this.config.autoAnswerQuestions) {
        this.autoAnswer(taskId, parsed);
      }
    });

    bridge.on('error', (error: string) => {
      sendToThread(`⚠️ **Error:** ${error.slice(0, 500)}`);
    });

    bridge.on('complete', (info: { message: string; exitCode: number | null }) => {
      const task = this.tasks.get(taskId);
      if (task) {
        // Preserve waiting_answer status — CLI exits after AskUserQuestion
        // but user still needs to answer in the thread
        if (task.status !== 'waiting_answer') {
          task.status = info.exitCode === 0 ? 'completed' : 'failed';
          this.channelManager.updateThreadName(thread, task.status);
        }
      }

      // Don't show completion message if waiting for answer
      if (task?.status === 'waiting_answer') return;

      const emoji = task?.status === 'completed' ? '✅' : '❌';
      sendToThread(`\n${'─'.repeat(30)}\n${emoji} **작업 종료:** ${info.message}`);

      // Process queued follow-ups
      const queued = this.pendingFollowUps.get(taskId);
      if (queued && queued.length > 0) {
        const nextPrompt = queued.shift()!;
        if (queued.length === 0) this.pendingFollowUps.delete(taskId);
        sendToThread(`🔄 **대기 중이던 요청 실행:** ${nextPrompt.slice(0, 100)}`);
        this.sendFollowUp(taskId, nextPrompt);
      }
    });
  }

  private async autoAnswer(taskId: string, question: FormattedOutput): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    // spawn a separate claude session to answer the question (read-only tools)
    const coordinator = new ClaudeBridge(this.config.claudePath, task.projectDir);
    this.coordinators.add(coordinator);

    const answerPrompt = `프로젝트 컨텍스트를 파악하고 다음 질문에 가장 적합한 답을 한 줄로 제시해줘:\n\n질문: ${question.content}\n선택지: ${question.questionOptions?.join(', ') || '없음'}`;

    let answer = '';

    coordinator.on('output', (output: FormattedOutput) => {
      if (output.label === 'Claude' || output.label === 'Complete') {
        answer = output.content; // Use last output only, not accumulate
      }
    });

    coordinator.on('error', (err: string) => {
      console.error(`autoAnswer coordinator error: ${err}`);
    });

    let coordinatorTimeout: ReturnType<typeof setTimeout>;

    coordinator.on('complete', (_info: { message: string; exitCode: number | null }) => {
      clearTimeout(coordinatorTimeout);
      coordinator.removeAllListeners();
      this.coordinators.delete(coordinator);
      if (answer && this.tasks.get(taskId)?.status === 'waiting_answer') {
        this.answerQuestion(taskId, answer);
        task.thread.send(`🤖 **[Coordinator]** 자동 답변: ${answer}`).catch(() => {});
      }
    });

    coordinator.start(answerPrompt, {
      allowedTools: ['Read', 'Glob', 'Grep'],
    });

    // Safety timeout: force-stop coordinator after 2 minutes
    coordinatorTimeout = setTimeout(() => {
      if (this.coordinators.has(coordinator)) {
        coordinator.removeAllListeners();
        coordinator.stop();
        this.coordinators.delete(coordinator);
      }
    }, 120_000);
    coordinatorTimeout.unref();
  }

  answerQuestion(taskId: string, answer: string): boolean {
    if (this.lockedTasks.has(taskId)) return false;
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'waiting_answer') return false;

    this.lockedTasks.add(taskId);

    // -p mode is one-shot; resume session with answer as new prompt
    const oldBridge = this.bridges.get(taskId);
    const sessionId = oldBridge?.getSessionId();
    if (oldBridge) {
      oldBridge.removeAllListeners();
      oldBridge.stop();
    }
    this.bridges.delete(taskId);

    const bridge = new ClaudeBridge(this.config.claudePath, task.projectDir);
    this.bridges.set(taskId, bridge);
    this.setupBridgeListeners(taskId, bridge, task.thread);

    task.status = 'running';
    task.pendingQuestion = undefined;
    bridge.start(answer, { sessionId: sessionId || undefined });
    this.lockedTasks.delete(taskId);
    return true;
  }

  sendFollowUp(taskId: string, message: string): boolean {
    if (this.lockedTasks.has(taskId)) return false;
    const task = this.tasks.get(taskId);
    if (!task) return false;

    this.lockedTasks.add(taskId);

    // Resume session with follow-up as new prompt
    const oldBridge = this.bridges.get(taskId);
    const sessionId = oldBridge?.getSessionId();
    if (oldBridge) {
      oldBridge.removeAllListeners();
      if (oldBridge.isRunning()) oldBridge.stop();
    }
    this.bridges.delete(taskId);

    const bridge = new ClaudeBridge(this.config.claudePath, task.projectDir);
    this.bridges.set(taskId, bridge);
    this.setupBridgeListeners(taskId, bridge, task.thread);

    task.status = 'running';
    bridge.start(message, { sessionId: sessionId || undefined });
    this.lockedTasks.delete(taskId);
    return true;
  }

  private static readonly MAX_QUEUED_FOLLOWUPS = 5;

  queueFollowUp(taskId: string, message: string): boolean {
    if (!this.pendingFollowUps.has(taskId)) {
      this.pendingFollowUps.set(taskId, []);
    }
    const queue = this.pendingFollowUps.get(taskId)!;
    if (queue.length >= TaskManager.MAX_QUEUED_FOLLOWUPS) return false;
    queue.push(message);
    return true;
  }

  stopTask(taskId: string): boolean {
    if (this.lockedTasks.has(taskId)) return false;
    const bridge = this.bridges.get(taskId);
    if (!bridge) return false;
    this.lockedTasks.add(taskId);
    bridge.removeAllListeners();
    bridge.stop();
    this.bridges.delete(taskId);
    this.pendingFollowUps.delete(taskId);
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = 'failed';
      this.channelManager.updateThreadName(task.thread, 'failed');
    }
    this.lockedTasks.delete(taskId);
    return true;
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  getRunningTasks(): Task[] {
    return Array.from(this.tasks.values()).filter(
      (t) => t.status === 'running' || t.status === 'waiting_answer'
    );
  }

  getRunningCount(): number {
    return this.getRunningTasks().length;
  }

  findTaskByThread(threadId: string): Task | undefined {
    return Array.from(this.tasks.values()).find((t) => t.thread?.id === threadId);
  }

  /** Stop all coordinators and cleanup timer — call during shutdown */
  stopAll(): void {
    for (const coordinator of this.coordinators) {
      coordinator.removeAllListeners();
      coordinator.stop();
    }
    this.coordinators.clear();
    clearInterval(this.cleanupTimer);
  }
}
