const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const chokidar = require('chokidar');
// const pty = require('node-pty'); // Disabled - posix_spawnp issues on macOS

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const GITHUB_PATH = '/Users/thomas/GITHUB';
const PORT = 3333;
const CLAUDE_PATH = '/Users/thomas/.local/bin/claude';

// Multi-project state management
const projects = new Map(); // projectName -> { process, vitePort, netlifyPort, fileWatcher, claudeReady, claudeProcess, commandQueue }

// Get or create project state
function getProjectState(projectName) {
  if (!projects.has(projectName)) {
    projects.set(projectName, {
      netlifyProcess: null,
      claudeProcess: null,
      vitePort: null,
      netlifyPort: null,
      fileWatcher: null,
      claudeReady: false,
      commandQueue: [],
      currentWs: null
    });
  }
  return projects.get(projectName);
}

// Find next available port starting from base
async function findAvailablePort(basePort) {
  const { execSync } = require('child_process');
  for (let port = basePort; port < basePort + 100; port++) {
    try {
      execSync(`lsof -ti :${port} 2>/dev/null`);
      // Port is in use, try next
    } catch {
      // Port is free
      return port;
    }
  }
  return basePort; // Fallback
}

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

  // Send current state for all active projects
  for (const [projectName, state] of projects) {
    if (state.claudeReady) {
      ws.send(JSON.stringify({ type: 'claude-started', project: projectName }));
    }
    if (state.netlifyProcess) {
      ws.send(JSON.stringify({ type: 'netlify-started', project: projectName }));
      if (state.vitePort) {
        ws.send(JSON.stringify({ type: 'preview-url', project: projectName, url: `http://localhost:${state.vitePort}` }));
      }
      if (state.netlifyPort) {
        ws.send(JSON.stringify({ type: 'preview-url', project: projectName, url: `http://localhost:${state.netlifyPort}` }));
      }
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
        sendCommand(data.command, data.files, data.project, ws);
        break;
      case 'start-netlify':
        console.log('Starting Netlify for:', data.project);
        startNetlify(data.project, ws);
        break;
      case 'stop-claude':
        stopClaude(data.project, ws);
        break;
      case 'stop-current-command':
        stopCurrentCommand(data.project, ws);
        break;
      case 'stop-netlify':
        stopNetlify(data.project, ws);
        break;
      case 'get-project-state':
        sendProjectState(data.project, ws);
        break;
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Send current project state to client
function sendProjectState(projectName, ws) {
  const state = projects.get(projectName);
  if (state) {
    ws.send(JSON.stringify({
      type: 'project-state',
      project: projectName,
      claudeReady: state.claudeReady,
      netlifyRunning: !!state.netlifyProcess,
      vitePort: state.vitePort,
      netlifyPort: state.netlifyPort,
      queueLength: state.commandQueue.length
    }));
  }
}

// File watcher for auto-refresh
function startFileWatcher(project) {
  const state = getProjectState(project);

  if (state.fileWatcher) {
    state.fileWatcher.close();
    state.fileWatcher = null;
  }

  const projectPath = path.join(GITHUB_PATH, project);

  // Watch for file changes, ignore node_modules, .git, etc.
  state.fileWatcher = chokidar.watch(projectPath, {
    ignored: [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/.cache/**',
      '**/.netlify/**',
      '**/coverage/**',
      '**/*.log'
    ],
    ignoreInitial: true,
    persistent: true
  });

  // Debounce file changes to avoid too many refreshes
  let debounceTimer = null;

  state.fileWatcher.on('all', (event, filePath) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      const relativePath = path.relative(projectPath, filePath);
      console.log(`File ${event}: ${relativePath}`);

      // Notify all connected clients
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'file-changed',
            project,
            event: event,
            file: relativePath
          }));
        }
      });
    }, 300); // 300ms debounce
  });

  console.log(`File watcher started for ${project}`);
}

// Clean up temp files older than 1 hour
function cleanupTempFiles(projectPath) {
  const tempDir = path.join(projectPath, '.claude-temp');
  if (!fs.existsSync(tempDir)) return;

  const oneHourAgo = Date.now() - (60 * 60 * 1000);

  try {
    const files = fs.readdirSync(tempDir);
    for (const file of files) {
      if (file === '.gitignore') continue;
      const filePath = path.join(tempDir, file);
      const stats = fs.statSync(filePath);
      if (stats.mtimeMs < oneHourAgo) {
        fs.unlinkSync(filePath);
        console.log('Cleaned up temp file:', file);
      }
    }
  } catch (e) {
    console.log('Temp cleanup error:', e.message);
  }
}

function startClaude(project, ws) {
  const state = getProjectState(project);
  state.claudeReady = true;

  const projectPath = path.join(GITHUB_PATH, project);

  // Clean up old temp files when starting a new session
  cleanupTempFiles(projectPath);

  ws.send(JSON.stringify({ type: 'claude-output', project, data: `\n🚀 Claude er klar til projekt: ${project}\n` }));
  ws.send(JSON.stringify({ type: 'claude-output', project, data: `📁 Arbejdsmappe: ${projectPath}\n\n` }));
  ws.send(JSON.stringify({ type: 'claude-output', project, data: `✅ Skriv dine kommandoer nedenfor - hver kommando sendes til Claude.\n\n` }));
  ws.send(JSON.stringify({ type: 'claude-started', project }));
}

// Process Claude stream-json output and send to client
function processClaudeOutput(content, project, ws, buffer = '') {
  buffer += content;
  const lines = buffer.split('\n');
  buffer = lines.pop(); // Keep incomplete line

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const json = JSON.parse(line);

      if (json.type === 'assistant' && json.message?.content) {
        for (const block of json.message.content) {
          if (block.type === 'text') {
            ws.send(JSON.stringify({ type: 'claude-output', project, data: block.text }));
          } else if (block.type === 'tool_use') {
            ws.send(JSON.stringify({ type: 'claude-output', project, data: `\n🔧 ${block.name}: ${JSON.stringify(block.input).substring(0, 100)}...\n` }));
          }
        }
      } else if (json.type === 'content_block_delta' && json.delta?.text) {
        ws.send(JSON.stringify({ type: 'claude-output', project, data: json.delta.text }));
      } else if (json.type === 'system') {
        // Show system messages like "Reading file..."
        if (json.message) {
          ws.send(JSON.stringify({ type: 'claude-output', project, data: `📋 ${json.message}\n` }));
        }
      }
      console.log('Claude JSON type:', json.type);
    } catch (e) {
      // Not JSON, show as raw output
      if (line.trim()) {
        console.log('Claude raw:', line.substring(0, 100));
        ws.send(JSON.stringify({ type: 'claude-output', project, data: line + '\n' }));
      }
    }
  }

  return buffer;
}

async function sendCommand(command, files, project, ws, fromQueue = false) {
  const state = getProjectState(project);

  if (!state.claudeReady) {
    ws.send(JSON.stringify({ type: 'claude-output', project, data: '\n⚠️ Klik "START CLAUDE" først.\n' }));
    return;
  }

  // If a command is running and this isn't from the queue, add to queue
  if (state.claudeProcess && !fromQueue) {
    const queueItem = { command, files };
    state.commandQueue.push(queueItem);
    state.currentWs = ws;
    const queuePosition = state.commandQueue.length;
    ws.send(JSON.stringify({ type: 'claude-output', project, data: `\n📋 Kommando sat i kø (position ${queuePosition}): ${command.substring(0, 50)}${command.length > 50 ? '...' : ''}\n` }));
    ws.send(JSON.stringify({ type: 'queue-update', project, queue: state.commandQueue.map(q => q.command.substring(0, 50)) }));
    return;
  }

  const projectPath = path.join(GITHUB_PATH, project);
  const tempDir = path.join(projectPath, '.claude-temp');

  // Build the full prompt with file contents
  let fullPrompt = command;

  if (files && files.length > 0) {
    const textFiles = files.filter(f => !f.isImage);
    const imageFiles = files.filter(f => f.isImage);

    // Add text file contents to the prompt
    if (textFiles.length > 0) {
      fullPrompt += '\n\n--- Vedhæftede tekstfiler ---\n';
      for (const file of textFiles) {
        fullPrompt += `\n### ${file.name}\n\`\`\`\n${file.data}\n\`\`\`\n`;
      }
      ws.send(JSON.stringify({ type: 'claude-output', project, data: `📎 ${textFiles.length} tekstfil(er) inkluderet i prompt\n` }));
    }

    // Save images to temp folder and include paths in prompt
    if (imageFiles.length > 0) {
      // Create temp directory if it doesn't exist
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
        // Add .gitignore to prevent committing temp files
        fs.writeFileSync(path.join(tempDir, '.gitignore'), '*\n');
      }

      fullPrompt += '\n\n--- Vedhæftede billeder ---\n';
      fullPrompt += 'Brug dit Read tool til at se disse billeder:\n';

      for (const file of imageFiles) {
        // Extract base64 data and save to file
        const base64Data = file.data.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const fileName = `${Date.now()}-${file.name}`;
        const filePath = path.join(tempDir, fileName);
        const absolutePath = path.resolve(filePath);

        fs.writeFileSync(filePath, buffer);
        fullPrompt += `- ${file.name}: ${absolutePath}\n`;
      }

      ws.send(JSON.stringify({ type: 'claude-output', project, data: `🖼️ ${imageFiles.length} billede(r) gemt i .claude-temp/ - Claude kan læse dem\n` }));
    }
  }

  ws.send(JSON.stringify({ type: 'claude-output', project, data: `\n💬 > ${command}\n\n` }));

  // Ensure temp directory exists and write prompt to file
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.gitignore'), '*\n');
  }
  const tempPromptFile = path.join(tempDir, 'prompt.txt');
  fs.writeFileSync(tempPromptFile, fullPrompt);

  // Use shell script to run Claude and capture output
  const outputFile = path.join(tempDir, `output-${Date.now()}.jsonl`);
  const scriptContent = `#!/bin/bash
cd "${projectPath}"
"${CLAUDE_PATH}" -p "$(cat "${tempPromptFile}")" --dangerously-skip-permissions --output-format stream-json --verbose > "${outputFile}" 2>&1 &
echo $!
`;
  const scriptFile = path.join(tempDir, 'run-claude.sh');
  fs.writeFileSync(scriptFile, scriptContent);
  fs.chmodSync(scriptFile, '755');

  console.log('Starting Claude in:', projectPath);
  ws.send(JSON.stringify({ type: 'claude-output', project, data: '⏳ Claude starter...\n' }));

  // Run the script to get PID
  const { execSync } = require('child_process');
  let claudePid;
  try {
    claudePid = execSync(`bash "${scriptFile}"`, { encoding: 'utf8' }).trim();
    console.log('Claude process PID:', claudePid);
  } catch (err) {
    ws.send(JSON.stringify({ type: 'claude-output', project, data: `\n❌ Kunne ikke starte Claude: ${err.message}\n` }));
    return;
  }

  ws.send(JSON.stringify({ type: 'claude-output', project, data: `⏳ Claude arbejder (PID: ${claudePid})...\n` }));

  // Poll output file for new content
  let lastSize = 0;
  let buffer = '';
  let checkCount = 0;
  const maxChecks = 600; // 10 minutes max

  const pollInterval = setInterval(() => {
    checkCount++;

    // Check if process is still running
    try {
      execSync(`kill -0 ${claudePid} 2>/dev/null`);
    } catch {
      // Process ended
      clearInterval(pollInterval);

      // Read remaining output
      if (fs.existsSync(outputFile)) {
        const finalContent = fs.readFileSync(outputFile, 'utf8');
        processClaudeOutput(finalContent.slice(lastSize), project, ws, buffer);
        try { fs.unlinkSync(outputFile); } catch {}
      }
      try { fs.unlinkSync(tempPromptFile); } catch {}
      try { fs.unlinkSync(scriptFile); } catch {}

      ws.send(JSON.stringify({ type: 'claude-output', project, data: `\n\n✅ Kommando færdig.\n` }));
      state.claudeProcess = null;

      // Process next command in queue
      processNextInQueue(project, ws);
      return;
    }

    // Read new content from output file
    if (fs.existsSync(outputFile)) {
      const stats = fs.statSync(outputFile);
      if (stats.size > lastSize) {
        const fd = fs.openSync(outputFile, 'r');
        const newContent = Buffer.alloc(stats.size - lastSize);
        fs.readSync(fd, newContent, 0, stats.size - lastSize, lastSize);
        fs.closeSync(fd);
        lastSize = stats.size;

        buffer = processClaudeOutput(newContent.toString(), project, ws, buffer);
      }
    }

    if (checkCount >= maxChecks) {
      clearInterval(pollInterval);
      try { execSync(`kill ${claudePid}`); } catch {}
      ws.send(JSON.stringify({ type: 'claude-output', project, data: `\n\n⏱️ Timeout efter 10 minutter.\n` }));
      state.claudeProcess = null;
    }
  }, 1000);

  // Store interval so we can stop it
  state.claudeProcess = { pid: claudePid, interval: pollInterval };
}

function processNextInQueue(project, ws) {
  const state = getProjectState(project);

  if (state.commandQueue.length === 0) {
    return;
  }

  const nextCommand = state.commandQueue.shift();
  const targetWs = state.currentWs || ws;

  targetWs.send(JSON.stringify({ type: 'claude-output', project, data: `\n📋 Kører næste kommando fra kø (${state.commandQueue.length} tilbage)...\n` }));
  targetWs.send(JSON.stringify({ type: 'queue-update', project, queue: state.commandQueue.map(q => q.command.substring(0, 50)) }));

  // Small delay before starting next command
  setTimeout(() => {
    sendCommand(nextCommand.command, nextCommand.files, project, targetWs, true);
  }, 500);
}

function stopClaude(project, ws) {
  const state = getProjectState(project);
  const { execSync } = require('child_process');

  if (state.claudeProcess) {
    // Stop the polling interval
    if (state.claudeProcess.interval) {
      clearInterval(state.claudeProcess.interval);
    }
    // Kill the Claude process
    if (state.claudeProcess.pid) {
      try { execSync(`kill ${state.claudeProcess.pid} 2>/dev/null`); } catch {}
    }
    state.claudeProcess = null;
  }
  // Clear the command queue
  const queuedCount = state.commandQueue.length;
  state.commandQueue.length = 0;
  state.currentWs = null;
  if (queuedCount > 0) {
    ws.send(JSON.stringify({ type: 'claude-output', project, data: `\n🗑️ ${queuedCount} kommando(er) fjernet fra kø.\n` }));
  }
  ws.send(JSON.stringify({ type: 'queue-update', project, queue: [] }));
  ws.send(JSON.stringify({ type: 'claude-output', project, data: '\n\n🛑 Claude session stoppet.\n' }));
  ws.send(JSON.stringify({ type: 'claude-stopped', project }));
  state.claudeReady = false;
}

function stopCurrentCommand(project, ws) {
  const state = getProjectState(project);
  const { execSync } = require('child_process');

  if (state.claudeProcess) {
    // Stop the polling interval
    if (state.claudeProcess.interval) {
      clearInterval(state.claudeProcess.interval);
    }
    // Kill the Claude process
    if (state.claudeProcess.pid) {
      try { execSync(`kill ${state.claudeProcess.pid} 2>/dev/null`); } catch {}
    }
    state.claudeProcess = null;
    ws.send(JSON.stringify({ type: 'claude-output', project, data: '\n\n⬛ Kommando stoppet.\n' }));
  }
}

async function killProcessOnPort(port) {
  const { execSync } = require('child_process');
  try {
    const pids = execSync(`lsof -ti :${port} 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (pids) {
      const pidList = pids.split('\n').filter(p => p);
      pidList.forEach(pid => {
        try {
          execSync(`kill -9 ${pid} 2>/dev/null`);
        } catch (e) {}
      });
    }
  } catch (e) {
    // Port not in use or command failed - that's fine
  }
  await new Promise(r => setTimeout(r, 200));
}

// Detect port from dev server output and send to client
function detectAndSendPort(output, project, ws) {
  const state = getProjectState(project);

  // Skip "waiting for" messages - they mention ports but aren't ready yet
  if (output.toLowerCase().includes('waiting for')) {
    return;
  }

  // Patterns to match (in priority order):
  // - "➜ Local: http://localhost:5173/" (Vite ready)
  // - "Server now ready on http://localhost:8888" (Netlify ready)
  // - "✔ Vite dev server ready on port 5173" (Netlify confirms Vite)
  // - "listening on port 3000" / "listening to 3999"
  // - Generic "localhost:PORT" as fallback

  const patterns = [
    { regex: /(?:Local|Network):\s*https?:\/\/localhost:(\d+)/i, type: 'vite-ready' },
    { regex: /Server now ready.*localhost:(\d+)/i, type: 'netlify-ready' },
    { regex: /✔.*ready on port (\d+)/i, type: 'confirmed-ready' },
    { regex: /listening (?:on|to) (?:port )?(\d+)/i, type: 'listening' },
    { regex: /localhost:(\d+)/i, type: 'generic' }
  ];

  for (const { regex, type } of patterns) {
    const match = output.match(regex);
    if (match) {
      const port = match[1];
      const portNum = parseInt(port);

      // Skip if this is just a random port mention (too low or too high)
      if (portNum < 3000 || portNum > 9999) continue;

      console.log('Detected port:', port, 'type:', type, 'for project:', project);

      // Determine if this is a Netlify proxy port or a dev server port
      if (port === '8888' || portNum >= 8880) {
        // Netlify proxy port
        state.netlifyPort = port;
        console.log('Sending Netlify preview-url:', port, 'for:', project);
        ws.send(JSON.stringify({ type: 'preview-url', project, url: `http://localhost:${port}` }));
      } else {
        // Vite/dev server port
        if (!state.vitePort || type === 'vite-ready' || type === 'confirmed-ready') {
          state.vitePort = port;
          console.log('Sending Vite preview-url:', port, 'for:', project);
          ws.send(JSON.stringify({ type: 'preview-url', project, url: `http://localhost:${port}` }));
        }
      }
      break; // Only process the first matching pattern
    }
  }
}

// Detect project type and return the appropriate dev command
function detectDevCommand(projectPath) {
  const hasNetlifyToml = fs.existsSync(path.join(projectPath, 'netlify.toml'));
  const hasViteConfig = fs.existsSync(path.join(projectPath, 'vite.config.js')) ||
                        fs.existsSync(path.join(projectPath, 'vite.config.ts')) ||
                        fs.existsSync(path.join(projectPath, 'vite.config.mjs'));
  const hasPackageJson = fs.existsSync(path.join(projectPath, 'package.json'));

  let packageJson = null;
  if (hasPackageJson) {
    try {
      packageJson = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8'));
    } catch (e) {}
  }

  const hasDevScript = packageJson?.scripts?.dev;
  const hasStartScript = packageJson?.scripts?.start;

  // Priority: netlify.toml > vite config > package.json dev script
  if (hasNetlifyToml) {
    return { cmd: 'netlify', args: ['dev', '--no-open'], type: 'netlify' };
  } else if (hasViteConfig) {
    return { cmd: 'npx', args: ['vite', '--host'], type: 'vite' };
  } else if (hasDevScript) {
    return { cmd: 'npm', args: ['run', 'dev'], type: 'npm-dev' };
  } else if (hasStartScript) {
    return { cmd: 'npm', args: ['run', 'start'], type: 'npm-start' };
  }

  return null;
}

async function startNetlify(project, ws) {
  const state = getProjectState(project);

  // Stop existing process for this project
  if (state.netlifyProcess) {
    ws.send(JSON.stringify({ type: 'netlify-output', project, data: '\n⚠️ Stopper eksisterende dev server...\n' }));
    state.netlifyProcess.kill('SIGTERM');
    state.netlifyProcess = null;
    state.vitePort = null;
    state.netlifyPort = null;
    await new Promise(r => setTimeout(r, 1000));
  }

  const projectPath = path.join(GITHUB_PATH, project);

  // Detect what type of project this is
  const devCommand = detectDevCommand(projectPath);

  if (!devCommand) {
    ws.send(JSON.stringify({ type: 'netlify-output', project, data: '⚠️ Kunne ikke finde dev kommando (ingen netlify.toml, vite.config, eller package.json scripts)\n' }));
    ws.send(JSON.stringify({ type: 'netlify-output', project, data: '💡 Prøv at åbne projektet manuelt med: cd ' + projectPath + ' && npm run dev\n' }));
    return;
  }

  // Check if node_modules exists, if not install dependencies
  const nodeModulesPath = path.join(projectPath, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    ws.send(JSON.stringify({ type: 'netlify-output', project, data: '📦 node_modules mangler - installerer dependencies...\n' }));

    // Check which package manager to use
    const hasPnpmLock = fs.existsSync(path.join(projectPath, 'pnpm-lock.yaml'));
    const hasYarnLock = fs.existsSync(path.join(projectPath, 'yarn.lock'));
    const installCmd = hasPnpmLock ? 'pnpm' : (hasYarnLock ? 'yarn' : 'npm');

    ws.send(JSON.stringify({ type: 'netlify-output', project, data: `🔧 Kører ${installCmd} install...\n` }));

    try {
      const { exec } = require('child_process');
      await new Promise((resolve, reject) => {
        const installProcess = exec(`${installCmd} install`, {
          cwd: projectPath,
          maxBuffer: 50 * 1024 * 1024
        });

        installProcess.stdout.on('data', (data) => {
          ws.send(JSON.stringify({ type: 'netlify-output', project, data: data.toString() }));
        });

        installProcess.stderr.on('data', (data) => {
          ws.send(JSON.stringify({ type: 'netlify-output', project, data: data.toString() }));
        });

        installProcess.on('close', (code) => {
          if (code === 0) {
            ws.send(JSON.stringify({ type: 'netlify-output', project, data: '✅ Dependencies installeret!\n\n' }));
            resolve();
          } else {
            ws.send(JSON.stringify({ type: 'netlify-output', project, data: `❌ Installation fejlede (kode: ${code})\n` }));
            reject(new Error(`Install failed with code ${code}`));
          }
        });

        installProcess.on('error', (err) => {
          ws.send(JSON.stringify({ type: 'netlify-output', project, data: `❌ Installationsfejl: ${err.message}\n` }));
          reject(err);
        });
      });
    } catch (err) {
      ws.send(JSON.stringify({ type: 'netlify-output', project, data: `⚠️ Fortsætter uden dependencies...\n` }));
    }
  }

  const typeLabels = {
    'netlify': '🌐 Netlify Dev',
    'vite': '⚡ Vite Dev Server',
    'npm-dev': '📦 npm run dev',
    'npm-start': '📦 npm start'
  };

  const cmdLine = `${devCommand.cmd} ${devCommand.args.join(' ')}`;
  ws.send(JSON.stringify({ type: 'netlify-output', project, data: `\n${typeLabels[devCommand.type]} starter i ${project}...\n` }));
  ws.send(JSON.stringify({ type: 'netlify-output', project, data: `Kommando: ${cmdLine}\n\n` }));

  // Use exec for better compatibility with Node.js v25
  const { exec } = require('child_process');

  state.netlifyProcess = exec(cmdLine, {
    cwd: projectPath,
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '1', BROWSER: 'none' }
  });

  if (!state.netlifyProcess) {
    ws.send(JSON.stringify({ type: 'netlify-output', project, data: `\n❌ Kunne ikke starte dev server\n` }));
    return;
  }

  state.netlifyProcess.stdout.on('data', (data) => {
    const output = data.toString();
    console.log('Dev server stdout:', output.substring(0, 100));
    ws.send(JSON.stringify({ type: 'netlify-output', project, data: output }));

    // Detect ports from various patterns
    detectAndSendPort(output, project, ws);
  });

  state.netlifyProcess.stderr.on('data', (data) => {
    const output = data.toString();
    console.log('Dev server stderr:', output.substring(0, 100));
    ws.send(JSON.stringify({ type: 'netlify-output', project, data: output }));

    // Detect ports from various patterns
    detectAndSendPort(output, project, ws);
  });

  state.netlifyProcess.on('error', (err) => {
    console.log('Dev server process error:', err.message);
    ws.send(JSON.stringify({ type: 'netlify-output', project, data: `\n❌ Dev server fejl: ${err.message}\n` }));
  });

  state.netlifyProcess.on('close', (code) => {
    ws.send(JSON.stringify({ type: 'netlify-output', project, data: `\n\n📋 Dev server afsluttet med kode ${code}\n` }));
    ws.send(JSON.stringify({ type: 'netlify-stopped', project }));
    state.netlifyProcess = null;
    state.vitePort = null;
    state.netlifyPort = null;
  });

  ws.send(JSON.stringify({ type: 'netlify-started', project }));

  // Start file watcher for auto-refresh
  startFileWatcher(project);
}

function stopNetlify(project, ws) {
  const state = getProjectState(project);

  if (state.fileWatcher) {
    state.fileWatcher.close();
    state.fileWatcher = null;
  }

  if (state.netlifyProcess) {
    state.netlifyProcess.kill('SIGTERM');
    state.netlifyProcess = null;
    state.vitePort = null;
    state.netlifyPort = null;
    ws.send(JSON.stringify({ type: 'netlify-output', project, data: '\n\n🛑 Dev server stoppet.\n' }));
    ws.send(JSON.stringify({ type: 'netlify-stopped', project }));
  }
}

server.listen(PORT, () => {
  console.log(`\n🎨 Sunkez Claude Editor kører på http://localhost:${PORT}\n`);
});
