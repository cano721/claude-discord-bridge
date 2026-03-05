import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { StringDecoder } from 'string_decoder';
import { parseClaudeOutput, type FormattedOutput } from './output-parser.js';

// --- #10: Toggleable debug logging ---
const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === '1';
const LOG_DIR = process.env.CLAUDE_BRIDGE_LOG_DIR || './logs';

function debugLog(msg: string): void {
  if (!DEBUG) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  process.stderr.write(line);
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(`${LOG_DIR}/bridge.log`, line);
  } catch { /* ignore */ }
}

// --- #3: Session ID validation ---
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
function isValidSessionId(id: string): boolean {
  return id.length > 0 && id.length <= 64 && SESSION_ID_RE.test(id);
}

export interface BridgeEvents {
  output: [FormattedOutput];
  question: [FormattedOutput];
  complete: [{ message: string; exitCode: number | null }];
  error: [string];
  started: [];
}

const DEFAULT_ALLOWED_TOOLS = [
  'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent', 'TaskOutput',
  'TaskStop', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Skill',
  'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList',
];

// --- #2: Security rules added to system prompt ---
const SYSTEM_PROMPT = `You are a coding assistant invoked via Discord bot. Be concise and focus on the task.
Respond in the same language as the user.

SECURITY RULES (MUST FOLLOW):
- NEVER execute destructive commands like rm -rf, format, mkfs, dd, etc.
- NEVER modify system files in /etc, /sys, /proc, /boot
- NEVER access or modify files outside the current working directory without explicit user path
- NEVER execute commands that could harm the system or compromise security
- If a request seems dangerous, explain the risk and suggest a safer alternative

BASH EXECUTION RULES (MUST FOLLOW):
- All commands MUST run non-interactively without user input
- Use -y, --yes, or --non-interactive flags when available
- Use -m flag for commit messages (e.g., git commit -m "message")
- Disable pagers with --no-pager or pipe to cat
- NEVER use commands that open editors (vim, nano, etc.)
- NEVER use interactive flags like -i`;

export class ClaudeBridge extends EventEmitter {
  private process: ChildProcess | null = null;
  private claudePath: string;
  private projectDir: string;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private lastSessionId: string | null = null;
  private cancelled = false;           // #5: Cancel flag
  private stderrBuffer: string[] = []; // #4: Stderr buffering
  private receivedResult = false;      // #9: Track result event
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(claudePath: string, projectDir: string) {
    super();
    this.claudePath = claudePath;
    this.projectDir = projectDir;
  }

  getSessionId(): string | null {
    return this.lastSessionId;
  }

  start(prompt: string, options?: {
    sessionId?: string;
    model?: string;
    allowedTools?: string[];
    systemPrompt?: string;
  }): void {
    if (this.process) {
      throw new Error('Claude process already running');
    }

    this.cancelled = false;
    this.stderrBuffer = [];
    this.receivedResult = false;

    // Allowlist env vars — avoid leaking DISCORD_BOT_TOKEN and other secrets
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      SHELL: process.env.SHELL,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      TERM: process.env.TERM || 'dumb',
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
      BASH_DEFAULT_TIMEOUT_MS: '86400000',
      BASH_MAX_TIMEOUT_MS: '86400000',
    };

    const tools = (options?.allowedTools || DEFAULT_ALLOWED_TOOLS).join(',');
    const args = [
      '-p',
      '--dangerously-skip-permissions',
      '--tools', tools,
      '--verbose',
      '--output-format', 'stream-json',
      '--append-system-prompt', options?.systemPrompt || SYSTEM_PROMPT,
    ];

    if (options?.model) {
      args.push('--model', options.model);
    }

    // #3: Validate session ID before passing to CLI
    if (options?.sessionId) {
      if (isValidSessionId(options.sessionId)) {
        args.push('--resume', options.sessionId);
      } else {
        debugLog(`Invalid session ID rejected: ${options.sessionId}`);
      }
    }

    debugLog(`spawning: ${this.claudePath}`);
    debugLog(`cwd: ${this.projectDir}, prompt: ${prompt.length} chars`);

    // #1: detached: true for proper process group kill
    this.process = spawn(this.claudePath, args, {
      cwd: this.projectDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    this.emit('started');

    // Write prompt to stdin then close it
    if (this.process.stdin) {
      this.process.stdin.write(prompt, (err) => {
        if (err) {
          debugLog(`stdin write error: ${err}`);
        }
        this.process?.stdin?.end();
      });
    }

    this.process.stdout?.on('data', (data: Buffer) => {
      // #5: Skip processing if cancelled
      if (this.cancelled) return;

      try {
        const chunk = this.decoder.write(data);
        debugLog(`stdout: ${chunk.length} bytes`);
        this.buffer += chunk;
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
          if (this.cancelled) return;
          if (!line.trim()) continue;

          // Parse JSON once for tracking
          try {
            const json = JSON.parse(line);
            if (json.type === 'system' && json.subtype === 'init' && json.session_id) {
              this.lastSessionId = json.session_id;
              debugLog(`session_id: ${json.session_id}`);
            }
            if (json.type === 'result') {
              this.receivedResult = true;
              if (json.session_id) this.lastSessionId = json.session_id;
            }
          } catch { /* not JSON */ }

          const parsedList = parseClaudeOutput(line);
          for (const parsed of parsedList) {
            if (parsed.isQuestion) {
              this.emit('question', parsed);
            } else {
              this.emit('output', parsed);
            }
          }
        }
      } catch (err) {
        debugLog(`stdout handler error: ${err}`);
        this.emit('error', `Parser error: ${err}`);
      }
    });

    // #4: Buffer stderr instead of emitting immediately
    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        debugLog(`stderr: ${text.slice(0, 300)}`);
        this.stderrBuffer.push(text);
      }
    });

    this.process.on('close', (code) => {
      // Clear force-kill timer on natural exit
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }

      if (this.cancelled) {
        this.process = null;
        this.emit('complete', { message: 'Task stopped by user', exitCode: code ?? -1 });
        return;
      }

      // flush remaining buffer + decoder
      const decoderRemainder = this.decoder.end();
      if (decoderRemainder) this.buffer += decoderRemainder;
      if (this.buffer.trim()) {
        const parsedList = parseClaudeOutput(this.buffer);
        for (const parsed of parsedList) {
          this.emit('output', parsed);
        }
        this.buffer = '';
      }

      // #4: Only emit stderr on non-zero exit
      if (code !== 0 && this.stderrBuffer.length > 0) {
        const stderr = this.stderrBuffer.join('\n').slice(0, 1000);
        this.emit('error', stderr);
      }

      this.process = null;
      debugLog(`process exited code=${code}, receivedResult=${this.receivedResult}`);

      // #9: Use exit code for status, not string matching
      this.emit('complete', {
        message: code === 0 ? 'Task completed successfully' : `Process exited with code ${code}`,
        exitCode: code,
      });
    });

    this.process.on('error', (err) => {
      this.process = null;
      debugLog(`process error: ${err}`);
      this.emit('error', `Failed to start claude: ${err.message}`);
      this.emit('complete', {
        message: `Process failed to start: ${err.message}`,
        exitCode: -1,
      });
    });
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  stop(): void {
    if (!this.process) return;
    if (this.cancelled) return; // Already stopping

    // #5: Set cancel flag first
    this.cancelled = true;
    const pid = this.process.pid;
    debugLog(`stopping process pid=${pid}`);

    // #1/#7: Kill entire process group (detached: true required)
    if (pid) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        this.process.kill('SIGTERM');
      }
    } else {
      this.process.kill('SIGTERM');
    }

    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (this.process) {
        debugLog('force killing process');
        if (pid) {
          try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ }
        }
        this.process = null;
        this.emit('complete', { message: 'Task force stopped', exitCode: -1 });
      }
    }, 5000);
  }
}
