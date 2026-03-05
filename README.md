# Claude Discord Bridge

Discord 메시지로 Claude Code CLI 에이전트를 실행하고, 실시간으로 결과를 스레드에 스트리밍하는 봇입니다.

## Features

- Discord 채널에서 메시지를 입력하면 Claude Code 작업이 자동 시작
- 작업별 스레드 생성 및 실시간 진행 상황 표시
- 세션 기반 대화 연속성 (스레드에서 후속 메시지 가능)
- Claude의 질문에 스레드에서 직접 답변
- 자동 답변 모드 (Coordinator 에이전트)
- 동시 작업 관리 (`!status`, `!stop`)
- 사용자 인증 및 프로젝트 경로 제한

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 설치 및 인증 완료
- [Discord Bot Token](https://discord.com/developers/applications)

## Setup

```bash
# 의존성 설치
npm install

# .env 설정
cp .env.example .env
# .env 파일을 편집하여 토큰과 서버 ID 입력
```

### 환경 변수

| 변수 | 필수 | 설명 |
|------|------|------|
| `DISCORD_BOT_TOKEN` | ✅ | Discord Bot Token |
| `DISCORD_GUILD_ID` | ✅ | Discord 서버 ID |
| `DEFAULT_PROJECT_DIR` | | 기본 프로젝트 디렉토리 |
| `CLAUDE_PATH` | | Claude CLI 경로 (기본: `claude`) |
| `MAX_CONCURRENT_TASKS` | | 최대 동시 작업 수 (기본: `3`) |
| `AUTO_ANSWER_QUESTIONS` | | 자동 답변 활성화 (기본: `false`) |
| `AUTHORIZED_USER_IDS` | | 허용할 Discord 유저 ID (쉼표 구분) |
| `ALLOWED_PROJECT_ROOTS` | | 허용할 프로젝트 루트 경로 (`:` 구분) |

### Discord Bot 권한

Bot에 다음 Intent가 필요합니다:
- `Guilds`
- `Guild Messages`
- `Message Content` (Privileged Intent)

## Usage

```bash
# 개발 모드 (hot reload)
npm run dev

# 프로덕션
npm start
```

봇이 시작되면 서버에 `🤖 Claude Agents` 카테고리와 `claude-commands` 채널이 자동 생성됩니다.

### Commands

| 명령어 | 설명 |
|--------|------|
| `메시지 입력` | 기본 프로젝트에서 Claude Code 작업 시작 |
| `--project /path 메시지` | 특정 프로젝트에서 작업 시작 |
| `!status` | 실행 중인 작업 목록 |
| `!stop` | 모든 작업 중지 |
| `!stop task-1` | 특정 작업 중지 |

### Thread Interaction

- 작업이 시작되면 자동으로 스레드 생성
- Claude가 질문하면 스레드에 답변 입력
- 작업 완료 후 스레드에 메시지를 입력하면 같은 세션으로 이어서 대화
- 작업 실행 중 메시지는 대기열에 추가되어 완료 후 자동 실행

## Architecture

```
Discord Message
  → index.ts (message handler)
    → task-manager.ts (task lifecycle)
      → claude-bridge.ts (CLI process spawn)
        → claude -p --output-format stream-json
      ← output-parser.ts (JSON stream → Discord format)
    ← channel-manager.ts (thread management)
  ← Discord Thread
```

## License

MIT
