export interface FormattedOutput {
  emoji: string;
  label: string;
  content: string;
  isQuestion: boolean;
  questionOptions?: string[];
}

export function parseClaudeOutput(line: string): FormattedOutput[] {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    if (line.trim()) {
      return [{ emoji: '📝', label: 'Output', content: line.trim(), isQuestion: false }];
    }
    return [];
  }

  const type = event.type as string;
  const subtype = event.subtype as string | undefined;

  // --- skip noise events ---
  if (type === 'system' && ['hook_started', 'hook_response'].includes(subtype || '')) {
    return [];
  }
  if (type === 'rate_limit_event') return [];

  // --- system init: skip (session tracking handled in bridge) ---
  if (type === 'system' && subtype === 'init') {
    return [];
  }

  // --- #7: task_notification events ---
  if (type === 'system' && subtype === 'task_notification') {
    const taskId = (event.task_id as string) || '';
    const status = (event.status as string) || '';
    const summary = (event.summary as string) || '';
    return [{
      emoji: status === 'completed' ? '✅' : status === 'failed' ? '❌' : '🔄',
      label: `Agent ${taskId}`,
      content: `[${status}] ${summary}`.trim(),
      isQuestion: false,
    }];
  }

  // --- assistant message: return ALL blocks ---
  if (type === 'assistant') {
    const message = event.message as Record<string, unknown> | undefined;
    if (!message) return [];

    const content = message.content as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(content)) return [];

    const outputs: FormattedOutput[] = [];

    for (const block of content) {
      const blockType = block.type as string;

      if (blockType === 'text') {
        const text = (block.text as string) || '';
        if (!text.trim()) continue;

        outputs.push({ emoji: '💬', label: 'Claude', content: text, isQuestion: false });
      }

      if (blockType === 'tool_use') {
        const parsed = parseToolUse(block);
        if (parsed) outputs.push(parsed);
      }
    }

    return outputs;
  }

  // --- #6: user message (tool results) - show successes too ---
  if (type === 'user') {
    const message = event.message as Record<string, unknown> | undefined;
    if (!message) return [];

    const content = message.content as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(content)) return [];

    const outputs: FormattedOutput[] = [];

    for (const block of content) {
      if (block.type === 'tool_result') {
        let output = '';
        if (typeof block.content === 'string') {
          output = block.content;
        } else if (Array.isArray(block.content)) {
          output = (block.content as Array<Record<string, unknown>>)
            .map((c) => (c.text as string) || '')
            .join('\n');
        }

        if (!output.trim()) continue;

        const isError = block.is_error === true;

        if (isError) {
          outputs.push({
            emoji: '❌', label: 'Error',
            content: output.slice(0, 500),
            isQuestion: false,
          });
        } else {
          // Show truncated successful result
          const lines = output.split('\n');
          const lineCount = lines.length;
          const truncated = lineCount > 5
            ? lines.slice(0, 5).join('\n') + `\n... (${lineCount} lines total)`
            : output;
          outputs.push({
            emoji: '📋', label: 'Result',
            content: truncated.slice(0, 300),
            isQuestion: false,
          });
        }
      }
    }

    return outputs;
  }

  // --- final result ---
  if (type === 'result') {
    const result = (event.result as string) || '';
    const cost = (event.total_cost_usd as number) ?? (event.cost_usd as number) ?? undefined;
    const resultSubtype = (event.subtype as string) || '';
    const emoji = resultSubtype === 'success' ? '✅' : '❌';
    const costStr = cost != null ? ` ($${cost.toFixed(4)})` : '';
    return [{
      emoji,
      label: 'Complete',
      content: (result.slice(0, 500) || resultSubtype) + costStr,
      isQuestion: false,
    }];
  }

  return [];
}

function parseToolUse(block: Record<string, unknown>): FormattedOutput | null {
  const toolName = block.name as string || 'Unknown';
  const input = block.input as Record<string, unknown> || {};

  // Agent spawn
  if (toolName === 'Agent') {
    const desc = (input.description as string) || (input.prompt as string) || '';
    const agentType = (input.subagent_type as string) || '';
    return {
      emoji: '🚀',
      label: `Agent: ${agentType}`,
      content: desc.slice(0, 200),
      isQuestion: false,
    };
  }

  // AskUserQuestion
  if (toolName === 'AskUserQuestion') {
    const questions = (input.questions as Array<Record<string, unknown>>) || [];
    const questionTexts: string[] = [];
    const allOptions: string[] = [];

    for (const q of questions) {
      questionTexts.push((q.question as string) || '');
      const opts = (q.options as Array<Record<string, unknown>>) || [];
      for (const o of opts) {
        allOptions.push((o.label as string) || '');
      }
    }

    return {
      emoji: '❓',
      label: 'Question',
      content: questionTexts.join('\n'),
      isQuestion: true,
      questionOptions: allOptions,
    };
  }

  // File operations
  if (['Read', 'Write', 'Edit'].includes(toolName)) {
    const path = (input.file_path as string) || (input.path as string) || '';
    const shortPath = path.split('/').slice(-2).join('/');
    return { emoji: '📄', label: toolName, content: shortPath, isQuestion: false };
  }

  // Bash
  if (toolName === 'Bash') {
    const cmd = (input.command as string) || '';
    const desc = (input.description as string) || '';
    const display = desc || (cmd.length > 100 ? cmd.slice(0, 100) + '...' : cmd);
    return { emoji: '⚡', label: 'Bash', content: `\`${display}\``, isQuestion: false };
  }

  // Search tools
  if (['Glob', 'Grep'].includes(toolName)) {
    const pattern = (input.pattern as string) || '';
    return { emoji: '🔍', label: toolName, content: pattern, isQuestion: false };
  }

  // Skill
  if (toolName === 'Skill') {
    const skill = (input.skill as string) || '';
    return { emoji: '🎯', label: 'Skill', content: skill, isQuestion: false };
  }

  // Task tools
  if (['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'].includes(toolName)) {
    const subject = (input.subject as string) || (input.taskId as string) || '';
    return { emoji: '📌', label: toolName, content: subject, isQuestion: false };
  }

  // Web tools
  if (toolName === 'WebSearch') {
    return { emoji: '🌐', label: 'WebSearch', content: (input.query as string) || '', isQuestion: false };
  }
  if (toolName === 'WebFetch') {
    return { emoji: '🌐', label: 'WebFetch', content: (input.url as string) || '', isQuestion: false };
  }

  // Other tools
  return { emoji: '🔧', label: toolName, content: JSON.stringify(input).slice(0, 150), isQuestion: false };
}

export function formatForDiscord(output: FormattedOutput): string {
  const header = `${output.emoji} **[${output.label}]**`;

  if (output.isQuestion && output.questionOptions?.length) {
    const options = output.questionOptions
      .map((o, i) => `  ${i + 1}. ${o}`)
      .join('\n');
    return `${header}\n${output.content}\n\n**선택지:**\n${options}\n\n💡 *이 스레드에 답변을 입력하세요*`;
  }

  const content = output.content.length > 1800
    ? output.content.slice(0, 1800) + '\n... (truncated)'
    : output.content;

  return `${header}\n${content}`;
}
