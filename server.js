const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
// const pty = require('node-pty'); // Disabled - posix_spawnp issues on macOS

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const GITHUB_PATH = '/Users/thomas/GITHUB';
const PORT = 3333;
const CLAUDE_PATH = '/Users/thomas/.local/bin/claude';

// Store active processes
let claudeProcess = null;
let netlifyProcess = null;
let currentProject = null;
let claudeReady = false;
let activeVitePort = null;
let activeNetlifyPort = null;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Get list of projects
app.get('/api/projects', (req, res) => {
  try {
    const items = fs.readdirSync(GITHUB_PATH, { withFileTypes: true });
    const projects = items
      .filter(item => item.isDirectory() && !item.name.startsWith('.'))
      .map(item => item.name);
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// WebSocket handling
wss.on('connection', (ws) => {
  console.log('Client connected');

  // Send current state to newly connected client
  if (currentProject) {
    ws.send(JSON.stringify({ type: 'claude-started' }));
    ws.send(JSON.stringify({ type: 'claude-output', data: `🔄 Genopkoblet til projekt: ${currentProject}\n` }));
  }
  if (netlifyProcess) {
    ws.send(JSON.stringify({ type: 'netlify-started' }));
    if (activeVitePort) {
      ws.send(JSON.stringify({ type: 'preview-url', url: `http://localhost:${activeVitePort}` }));
    }
    if (activeNetlifyPort) {
      ws.send(JSON.stringify({ type: 'preview-url', url: `http://localhost:${activeNetlifyPort}` }));
    }
  }

  ws.on('message', (message) => {
    const data = JSON.parse(message);
    console.log('Received message:', data.type, data.project || '');

    switch (data.type) {
      case 'start-claude':
        startClaude(data.project, ws);
        break;
      case 'send-command':
        sendCommand(data.command, data.files, ws);
        break;
      case 'start-netlify':
        console.log('Starting Netlify for:', data.project);
        startNetlify(data.project, ws);
        break;
      case 'stop-claude':
        stopClaude(ws);
        break;
      case 'stop-current-command':
        stopCurrentCommand(ws);
        break;
      case 'stop-netlify':
        stopNetlify(ws);
        break;
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

function startClaude(project, ws) {
  currentProject = project;
  claudeReady = true;

  const projectPath = path.join(GITHUB_PATH, project);

  ws.send(JSON.stringify({ type: 'claude-output', data: `\n🚀 Claude er klar til projekt: ${project}\n` }));
  ws.send(JSON.stringify({ type: 'claude-output', data: `📁 Arbejdsmappe: ${projectPath}\n\n` }));
  ws.send(JSON.stringify({ type: 'claude-output', data: `✅ Skriv dine kommandoer nedenfor - hver kommando sendes til Claude.\n\n` }));
  ws.send(JSON.stringify({ type: 'claude-started' }));
}

async function sendCommand(command, files, ws) {
  if (!claudeReady || !currentProject) {
    ws.send(JSON.stringify({ type: 'claude-output', data: '\n⚠️ Vælg først et projekt og klik "START CLAUDE".\n' }));
    return;
  }

  if (claudeProcess) {
    ws.send(JSON.stringify({ type: 'claude-output', data: '\n⏳ Vent venligst - Claude arbejder stadig på forrige kommando...\n' }));
    return;
  }

  const projectPath = path.join(GITHUB_PATH, currentProject);

  // Note: File attachments are not supported in Claude CLI -p mode
  // Show warning if files were attached
  if (files && files.length > 0) {
    ws.send(JSON.stringify({ type: 'claude-output', data: `⚠️ Fil-vedhæftninger understøttes ikke i CLI-mode. Filerne ignoreres.\n` }));
  }

  ws.send(JSON.stringify({ type: 'claude-output', data: `\n💬 > ${command}\n\n` }));

  // Build arguments array - use stream-json for real-time output without TTY
  // --verbose is required when using stream-json with -p
  const args = ['-p', command, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'];


  console.log('Starting Claude with args:', args);
  console.log('Working directory:', projectPath);

  // Spawn Claude directly with stream-json output format
  claudeProcess = spawn(CLAUDE_PATH, args, {
    cwd: projectPath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: process.env.PATH + ':/Users/thomas/.local/bin:/usr/local/bin'
    }
  });

  console.log('Claude process PID:', claudeProcess.pid);
  ws.send(JSON.stringify({ type: 'claude-output', data: '⏳ Claude arbejder...\n' }));

  // Buffer for incomplete JSON lines
  let buffer = '';

  claudeProcess.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line);
        // Handle different message types from stream-json
        if (json.type === 'assistant' && json.message?.content) {
          for (const block of json.message.content) {
            if (block.type === 'text') {
              ws.send(JSON.stringify({ type: 'claude-output', data: block.text }));
            } else if (block.type === 'tool_use') {
              ws.send(JSON.stringify({ type: 'claude-output', data: `\n🔧 ${block.name}: ${JSON.stringify(block.input).substring(0, 100)}...\n` }));
            }
          }
        } else if (json.type === 'content_block_delta' && json.delta?.text) {
          ws.send(JSON.stringify({ type: 'claude-output', data: json.delta.text }));
        }
        // Skip 'result' type - it duplicates the assistant message content
        console.log('Claude JSON type:', json.type);
      } catch (e) {
        // Not JSON, send as-is
        console.log('Claude raw output:', line.substring(0, 100));
        ws.send(JSON.stringify({ type: 'claude-output', data: line + '\n' }));
      }
    }
  });

  claudeProcess.stderr.on('data', (data) => {
    const output = data.toString();
    console.log('Claude stderr:', output.substring(0, 100));
    // Don't show stderr to user unless it's an error
  });

  claudeProcess.on('close', (code) => {
    console.log('Claude exited with code:', code);
    ws.send(JSON.stringify({ type: 'claude-output', data: `\n\n✅ Kommando færdig (kode: ${code}).\n` }));
    claudeProcess = null;
  });
}

function stopClaude(ws) {
  if (claudeProcess) {
    const proc = claudeProcess;
    claudeProcess = null; // Prevent new commands while stopping
    proc.on('close', () => {
      ws.send(JSON.stringify({ type: 'claude-output', data: '\n\n🛑 Claude session stoppet.\n' }));
      ws.send(JSON.stringify({ type: 'claude-stopped' }));
    });
    proc.kill('SIGTERM');
    // Fallback if process doesn't close gracefully
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (e) {}
    }, 3000);
  } else {
    ws.send(JSON.stringify({ type: 'claude-output', data: '\n\n🛑 Claude session stoppet.\n' }));
    ws.send(JSON.stringify({ type: 'claude-stopped' }));
  }
  claudeReady = false;
  currentProject = null;
}

function stopCurrentCommand(ws) {
  if (claudeProcess) {
    claudeProcess.kill('SIGTERM');
    claudeProcess = null;
    ws.send(JSON.stringify({ type: 'claude-output', data: '\n\n⬛ Kommando stoppet.\n' }));
  }
}

async function killProcessOnPort(port) {
  return new Promise((resolve) => {
    const findProcess = spawn('sh', ['-c', `lsof -ti :${port}`]);
    let pids = '';

    findProcess.stdout.on('data', (data) => {
      pids += data.toString();
    });

    findProcess.on('close', () => {
      const pidList = pids.trim().split('\n').filter(p => p);
      if (pidList.length > 0) {
        pidList.forEach(pid => {
          try {
            spawn('sh', ['-c', `kill -9 ${pid}`]);
          } catch (e) {}
        });
      }
      setTimeout(resolve, 500);
    });
  });
}

async function startNetlify(project, ws) {
  if (netlifyProcess) {
    ws.send(JSON.stringify({ type: 'netlify-output', data: '\n⚠️ Stopper eksisterende Netlify session...\n' }));
    netlifyProcess.kill('SIGTERM');
    netlifyProcess = null;
    await new Promise(r => setTimeout(r, 1000));
  }

  // Kill any existing processes on common dev ports
  ws.send(JSON.stringify({ type: 'netlify-output', data: '🔄 Rydder op i eksisterende porte...\n' }));
  await killProcessOnPort(8888);
  await killProcessOnPort(8080);
  await killProcessOnPort(8081);
  await killProcessOnPort(3000);
  await killProcessOnPort(5000);
  // Also kill common Vite ports
  for (let port = 5173; port <= 5190; port++) {
    await killProcessOnPort(port);
  }

  const projectPath = path.join(GITHUB_PATH, project);

  // Check if node_modules exists, if not install dependencies
  const nodeModulesPath = path.join(projectPath, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    ws.send(JSON.stringify({ type: 'netlify-output', data: '📦 node_modules mangler - installerer dependencies...\n' }));

    // Check which package manager to use
    const hasPnpmLock = fs.existsSync(path.join(projectPath, 'pnpm-lock.yaml'));
    const hasYarnLock = fs.existsSync(path.join(projectPath, 'yarn.lock'));
    const installCmd = hasPnpmLock ? 'pnpm' : (hasYarnLock ? 'yarn' : 'npm');

    ws.send(JSON.stringify({ type: 'netlify-output', data: `🔧 Kører ${installCmd} install...\n` }));

    try {
      await new Promise((resolve, reject) => {
        const installProcess = spawn(installCmd, ['install'], {
          cwd: projectPath,
          shell: true
        });

        installProcess.stdout.on('data', (data) => {
          ws.send(JSON.stringify({ type: 'netlify-output', data: data.toString() }));
        });

        installProcess.stderr.on('data', (data) => {
          ws.send(JSON.stringify({ type: 'netlify-output', data: data.toString() }));
        });

        installProcess.on('close', (code) => {
          if (code === 0) {
            ws.send(JSON.stringify({ type: 'netlify-output', data: '✅ Dependencies installeret!\n\n' }));
            resolve();
          } else {
            ws.send(JSON.stringify({ type: 'netlify-output', data: `❌ Installation fejlede (kode: ${code})\n` }));
            reject(new Error(`Install failed with code ${code}`));
          }
        });

        installProcess.on('error', (err) => {
          ws.send(JSON.stringify({ type: 'netlify-output', data: `❌ Installationsfejl: ${err.message}\n` }));
          reject(err);
        });
      });
    } catch (err) {
      ws.send(JSON.stringify({ type: 'netlify-output', data: `⚠️ Fortsætter uden dependencies...\n` }));
    }
  }

  ws.send(JSON.stringify({ type: 'netlify-output', data: `\n🌐 Starter Netlify Dev i ${project}...\n\n` }));

  netlifyProcess = spawn('netlify', ['dev', '--no-open'], {
    cwd: projectPath,
    env: { ...process.env, FORCE_COLOR: '1', BROWSER: 'none' },
    shell: true
  });

  netlifyProcess.stdout.on('data', (data) => {
    const output = data.toString();
    console.log('Netlify stdout:', output.substring(0, 100));
    ws.send(JSON.stringify({ type: 'netlify-output', data: output }));

    // Check for server ready message
    if (output.includes('Server now ready') || output.includes('localhost:')) {
      const portMatch = output.match(/localhost:(\d+)/);
      if (portMatch) {
        const port = portMatch[1];
        console.log('Sending preview-url:', port);

        // Store the port for reconnecting clients
        if (port === '8888') {
          activeNetlifyPort = port;
        } else {
          activeVitePort = port;
        }

        ws.send(JSON.stringify({ type: 'preview-url', url: `http://localhost:${port}` }));
      }
    }

    // Also check for "server ready on port X" pattern (for Vite/dev servers)
    // Must include "server" to avoid matching "Waiting for...ready on port"
    const portReadyMatch = output.match(/server ready on port (\d+)/i);
    if (portReadyMatch) {
      const port = portReadyMatch[1];
      if (port !== '8888' && !activeVitePort) {
        activeVitePort = port;
        console.log('Sending preview-url (from ready pattern):', port);
        ws.send(JSON.stringify({ type: 'preview-url', url: `http://localhost:${port}` }));
      }
    }
  });

  netlifyProcess.stderr.on('data', (data) => {
    const output = data.toString();
    console.log('Netlify stderr:', output.substring(0, 100));
    ws.send(JSON.stringify({ type: 'netlify-output', data: output }));

    // Check stderr for "server ready on port X" pattern (must include "server" or "✔")
    const portReadyMatch = output.match(/(?:server ready|✔.*ready) on port (\d+)/i);
    if (portReadyMatch) {
      const port = portReadyMatch[1];
      if (port !== '8888' && !activeVitePort) {
        activeVitePort = port;
        console.log('Sending preview-url (from stderr):', port);
        ws.send(JSON.stringify({ type: 'preview-url', url: `http://localhost:${port}` }));
      }
    }
  });

  netlifyProcess.on('error', (err) => {
    console.log('Netlify process error:', err.message);
  });

  netlifyProcess.on('close', (code) => {
    ws.send(JSON.stringify({ type: 'netlify-output', data: `\n\n📋 Netlify dev afsluttet med kode ${code}\n` }));
    ws.send(JSON.stringify({ type: 'netlify-stopped' }));
    netlifyProcess = null;
  });

  ws.send(JSON.stringify({ type: 'netlify-started' }));
}

function stopNetlify(ws) {
  if (netlifyProcess) {
    netlifyProcess.kill('SIGTERM');
    netlifyProcess = null;
    activeVitePort = null;
    activeNetlifyPort = null;
    ws.send(JSON.stringify({ type: 'netlify-output', data: '\n\n🛑 Netlify dev stoppet.\n' }));
    ws.send(JSON.stringify({ type: 'netlify-stopped' }));
  }
}

server.listen(PORT, () => {
  console.log(`\n🎨 Sunkez Claude Editor kører på http://localhost:${PORT}\n`);
});
