# Claude Editor

A web-based visual editor for Claude CLI with live preview capabilities.

## Features

- **Project Selection**: Choose from projects in your GitHub folder
- **Task Management**: Group commands under tasks with status badges (KØRER/FÆRDIG)
- **Real-time Output**: Stream Claude CLI output via `--output-format stream-json`
- **Live Preview**: Integrated Vite/Netlify dev server with auto-refresh on task completion
- **Timer Display**: See elapsed time for running tasks

## Screenshot

The editor has a 3-column layout:
1. **Left**: Project selector and task list with completion badges
2. **Center**: Command output and multi-line input field
3. **Right**: Live preview with Vite/Netlify tabs

## Installation

```bash
# Clone the repository
git clone https://github.com/Teambattle1/claude-editor.git
cd claude-editor

# Install dependencies
npm install

# Start the server
npm start
```

Open http://localhost:3333 in your browser.

## Requirements

- Node.js 18+
- Claude CLI installed at `~/.local/bin/claude`
- Netlify CLI (optional, for Netlify dev server)

## Configuration

Edit `server.js` to change:
- `GITHUB_PATH`: Path to your projects folder (default: `/Users/thomas/GITHUB`)
- `PORT`: Server port (default: `3333`)
- `CLAUDE_PATH`: Path to Claude CLI binary

## How It Works

1. Select a project from the dropdown
2. Click "START CLAUDE" to initialize the session
3. Create a new task and type your command
4. Claude executes with `--dangerously-skip-permissions` flag
5. Output streams in real-time via WebSocket
6. Preview auto-refreshes when task completes

## Tech Stack

- **Backend**: Express.js + WebSocket (ws)
- **Frontend**: Vanilla HTML/CSS/JavaScript
- **Claude Integration**: Stream JSON output format
- **Preview**: Netlify Dev / Vite dev server

## License

MIT
