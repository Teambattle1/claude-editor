const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { spawn, exec, execSync } = require('child_process');
const chokidar = require('chokidar');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3333;
const isWindows = process.platform === 'win32';
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Load or create config
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      // Ensure projectPorts exists
      if (!cfg.projectPorts) {
        cfg.projectPorts = {};
      }
      return cfg;
    }
  } catch (e) {
    console.log('Could not load config:', e.message);
  }
  return { projectsPath: null, projectPorts: {} };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let config = loadConfig();

// Get projects path from config
function getProjectsPath() {
  return config.projectsPath;
}

// Claude CLI path (assumes it's in PATH on both platforms)
const CLAUDE_PATH = 'claude';

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

// Cross-platform: Find next available port
async function findAvailablePort(basePort) {
  const net = require('net');
  for (let port = basePort; port < basePort + 100; port++) {
    const available = await new Promise(resolve => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close();
        resolve(true);
      });
      server.listen(port);
    });
    if (available) return port;
  }
  return basePort;
}

// Get or assign a fixed port for a project
async function getOrAssignProjectPort(projectName) {
  // Check if project already has a fixed port
  if (config.projectPorts[projectName]) {
    const assignedPort = config.projectPorts[projectName];
    console.log(`Project ${projectName} has fixed port: ${assignedPort}`);
    return assignedPort;
  }

  // Find all already assigned ports
  const usedPorts = new Set(Object.values(config.projectPorts));

  // Find next available port starting from 5173, skipping already assigned ones
  const net = require('net');
  for (let port = 5173; port < 5273; port++) {
    // Skip if already assigned to another project
    if (usedPorts.has(port)) continue;

    // Check if port is actually available
    const available = await new Promise(resolve => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close();
        resolve(true);
      });
      server.listen(port);
    });

    if (available) {
      // Assign this port permanently to the project
      config.projectPorts[projectName] = port;
      saveConfig(config);
      console.log(`Assigned fixed port ${port} to project ${projectName}`);
      return port;
    }
  }

  // Fallback if no port found
  const fallbackPort = 5173 + Object.keys(config.projectPorts).length;
  config.projectPorts[projectName] = fallbackPort;
  saveConfig(config);
  return fallbackPort;
}

// Cross-platform: Kill process by PID
function killProcess(pid) {
  try {
    if (isWindows) {
      execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch (e) {
    // Process may already be dead
  }
}

// Cross-platform: Check if process is running
function isProcessRunning(pid) {
  try {
    if (isWindows) {
      const result = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf8' });
      return result.includes(pid.toString());
    } else {
      process.kill(pid, 0);
      return true;
    }
  } catch (e) {
    return false;
  }
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Get config
app.get('/api/config', (req, res) => {
  res.json({
    projectsPath: config.projectsPath,
    isConfigured: !!config.projectsPath,
    platform: process.platform,
    projectPorts: config.projectPorts || {}
  });
});

// Get assigned port for a specific project
app.get('/api/project-port/:project', async (req, res) => {
  const projectName = req.params.project;
  const port = await getOrAssignProjectPort(projectName);
  res.json({ project: projectName, port });
});

// Set projects path
app.post('/api/config', (req, res) => {
  const { projectsPath } = req.body;

  if (!projectsPath) {
    return res.status(400).json({ error: 'projectsPath is required' });
  }

  // Verify the path exists and is a directory
  try {
    const stats = fs.statSync(projectsPath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'Path does not exist' });
  }

  config.projectsPath = projectsPath;
  saveConfig(config);
  res.json({ success: true, projectsPath });
});

// Browse directory (for folder picker)
app.get('/api/browse', (req, res) => {
  const requestedPath = req.query.path || (isWindows ? 'C:\\' : '/');

  try {
    const items = fs.readdirSync(requestedPath, { withFileTypes: true });
    const dirs = items
      .filter(item => item.isDirectory() && !item.name.startsWith('.'))
      .map(item => ({
        name: item.name,
        path: path.join(requestedPath, item.name)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      current: requestedPath,
      parent: path.dirname(requestedPath),
      directories: dirs
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get list of projects (sorted by most recently modified)
app.get('/api/projects', (req, res) => {
  const projectsPath = getProjectsPath();

  if (!projectsPath) {
    return res.status(400).json({ error: 'Projects path not configured' });
  }

  try {
    const items = fs.readdirSync(projectsPath, { withFileTypes: true });
    const projects = items
      .filter(item => item.isDirectory() && !item.name.startsWith('.'))
      .map(item => {
        const fullPath = path.join(projectsPath, item.name);
        let mtime = 0;
        try {
          mtime = fs.statSync(fullPath).mtimeMs;
        } catch (e) {}
        return { name: item.name, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime) // Sort by most recent first
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
  // Get the fixed assigned port from config (if any)
  const assignedPort = config.projectPorts[projectName] || null;

  if (state) {
    ws.send(JSON.stringify({
      type: 'project-state',
      project: projectName,
      claudeReady: state.claudeReady,
      netlifyRunning: !!state.netlifyProcess,
      vitePort: state.vitePort || assignedPort,
      assignedPort: assignedPort,
      netlifyPort: state.netlifyPort,
      queueLength: state.commandQueue.length
    }));
  } else {
    // Even if no state exists, send the assigned port info
    ws.send(JSON.stringify({
      type: 'project-state',
      project: projectName,
      claudeReady: false,
      netlifyRunning: false,
      vitePort: assignedPort,
      assignedPort: assignedPort,
      netlifyPort: null,
      queueLength: 0
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

  const projectPath = path.join(getProjectsPath(), project);

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

  const projectPath = path.join(getProjectsPath(), project);

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

  const projectPath = path.join(getProjectsPath(), project);
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

  console.log('Starting Claude in:', projectPath);
  ws.send(JSON.stringify({ type: 'claude-output', project, data: '⏳ Claude starter...\n' }));

  // Spawn Claude process directly (cross-platform)
  const claudeArgs = ['-p', fullPrompt, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'];

  const claudeProcess = spawn(CLAUDE_PATH, claudeArgs, {
    cwd: projectPath,
    shell: true,
    env: { ...process.env }
  });

  if (!claudeProcess.pid) {
    ws.send(JSON.stringify({ type: 'claude-output', project, data: `\n❌ Kunne ikke starte Claude\n` }));
    return;
  }

  ws.send(JSON.stringify({ type: 'claude-output', project, data: `⏳ Claude arbejder (PID: ${claudeProcess.pid})...\n` }));

  let buffer = '';
  let checkCount = 0;
  const maxChecks = 600; // 10 minutes max

  // Handle stdout
  claudeProcess.stdout.on('data', (data) => {
    buffer = processClaudeOutput(data.toString(), project, ws, buffer);
  });

  // Handle stderr
  claudeProcess.stderr.on('data', (data) => {
    buffer = processClaudeOutput(data.toString(), project, ws, buffer);
  });

  // Handle process exit
  claudeProcess.on('close', (code) => {
    if (state.claudeProcess?.interval) {
      clearInterval(state.claudeProcess.interval);
    }
    ws.send(JSON.stringify({ type: 'claude-output', project, data: `\n\n✅ Kommando færdig (kode: ${code}).\n` }));
    state.claudeProcess = null;
    processNextInQueue(project, ws);
  });

  claudeProcess.on('error', (err) => {
    ws.send(JSON.stringify({ type: 'claude-output', project, data: `\n❌ Fejl: ${err.message}\n` }));
    state.claudeProcess = null;
  });

  // Timeout check
  const timeoutInterval = setInterval(() => {
    checkCount++;
    if (checkCount >= maxChecks) {
      clearInterval(timeoutInterval);
      killProcess(claudeProcess.pid);
      ws.send(JSON.stringify({ type: 'claude-output', project, data: `\n\n⏱️ Timeout efter 10 minutter.\n` }));
      state.claudeProcess = null;
    }
  }, 1000);

  // Store process so we can stop it
  state.claudeProcess = { pid: claudeProcess.pid, process: claudeProcess, interval: timeoutInterval };
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

  if (state.claudeProcess) {
    // Stop the polling interval
    if (state.claudeProcess.interval) {
      clearInterval(state.claudeProcess.interval);
    }
    // Kill the Claude process
    if (state.claudeProcess.pid) {
      killProcess(state.claudeProcess.pid);
    }
    if (state.claudeProcess.process) {
      state.claudeProcess.process.kill();
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

  if (state.claudeProcess) {
    // Stop the polling interval
    if (state.claudeProcess.interval) {
      clearInterval(state.claudeProcess.interval);
    }
    // Kill the Claude process
    if (state.claudeProcess.pid) {
      killProcess(state.claudeProcess.pid);
    }
    if (state.claudeProcess.process) {
      state.claudeProcess.process.kill();
    }
    state.claudeProcess = null;
    ws.send(JSON.stringify({ type: 'claude-output', project, data: '\n\n⬛ Kommando stoppet.\n' }));
  }
}

async function killProcessOnPort(port) {
  try {
    if (isWindows) {
      // Windows: find and kill process using the port
      const result = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      const lines = result.split('\n').filter(l => l.includes('LISTENING'));
      const pids = [...new Set(lines.map(l => l.trim().split(/\s+/).pop()).filter(p => p && p !== '0'))];
      pids.forEach(pid => {
        try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); } catch (e) {}
      });
    } else {
      // Unix: use lsof
      const pids = execSync(`lsof -ti :${port} 2>/dev/null`, { encoding: 'utf8' }).trim();
      if (pids) {
        pids.split('\n').filter(p => p).forEach(pid => {
          try { process.kill(parseInt(pid), 'SIGKILL'); } catch (e) {}
        });
      }
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

// Detect package manager from lockfiles
function detectPackageManager(projectPath) {
  if (fs.existsSync(path.join(projectPath, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  } else if (fs.existsSync(path.join(projectPath, 'yarn.lock'))) {
    return 'yarn';
  }
  return 'npm';
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

  // Detect package manager (pnpm, yarn, npm)
  const pm = detectPackageManager(projectPath);
  // Use npx for pnpm since it might not be globally installed
  const pmCmd = pm === 'pnpm' ? 'npx pnpm' : pm;

  // Priority: package.json scripts first (uses project's installed packages)
  if (hasDevScript) {
    return { cmd: pmCmd, args: ['run', 'dev'], type: `${pm}-dev` };
  } else if (hasViteConfig) {
    return { cmd: 'npx', args: ['vite', '--host'], type: 'vite' };
  } else if (hasStartScript) {
    return { cmd: pmCmd, args: ['run', 'start'], type: `${pm}-start` };
  } else if (hasNetlifyToml) {
    return { cmd: 'npx', args: ['netlify', 'dev', '--no-open'], type: 'netlify' };
  }

  return null;
}

async function startNetlify(project, ws) {
  console.log('startNetlify called for:', project);
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

  const projectPath = path.join(getProjectsPath(), project);
  console.log('Project path:', projectPath);

  // Detect what type of project this is
  const devCommand = detectDevCommand(projectPath);
  console.log('Dev command:', devCommand);

  if (!devCommand) {
    ws.send(JSON.stringify({ type: 'netlify-output', project, data: '⚠️ Kunne ikke finde dev kommando (ingen netlify.toml, vite.config, eller package.json scripts)\n' }));
    ws.send(JSON.stringify({ type: 'netlify-output', project, data: '💡 Prøv at åbne projektet manuelt med: cd ' + projectPath + ' && npm run dev\n' }));
    return;
  }

  // Check if node_modules exists, if not install dependencies
  const nodeModulesPath = path.join(projectPath, 'node_modules');
  const hasNodeModules = fs.existsSync(nodeModulesPath);
  console.log('node_modules path:', nodeModulesPath, 'exists:', hasNodeModules);

  if (!hasNodeModules) {
    ws.send(JSON.stringify({ type: 'netlify-output', project, data: '📦 node_modules mangler - installerer dependencies...\n' }));

    // Check which package manager to use (use npx for pnpm/yarn if not globally installed)
    const hasPnpmLock = fs.existsSync(path.join(projectPath, 'pnpm-lock.yaml'));
    const hasYarnLock = fs.existsSync(path.join(projectPath, 'yarn.lock'));
    const installCmd = hasPnpmLock ? 'npx pnpm' : (hasYarnLock ? 'npx yarn' : 'npm');

    ws.send(JSON.stringify({ type: 'netlify-output', project, data: `🔧 Kører ${installCmd} install...\n` }));

    try {
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
    'npm-start': '📦 npm start',
    'pnpm-dev': '📦 pnpm run dev',
    'pnpm-start': '📦 pnpm start',
    'yarn-dev': '📦 yarn dev',
    'yarn-start': '📦 yarn start'
  };

  // Get or assign a fixed port for this project
  const assignedPort = await getOrAssignProjectPort(project);
  state.vitePort = assignedPort;
  console.log('Using fixed port:', assignedPort, 'for project:', project);

  // Kill any process that might be using this port
  await killProcessOnPort(assignedPort);

  // Build command with port argument
  let cmdLine = `${devCommand.cmd} ${devCommand.args.join(' ')}`;

  // Add --port flag for vite/npm dev commands
  // For npm/pnpm run dev, we need to pass the port to the underlying script
  if (devCommand.type === 'vite') {
    // Direct vite command
    cmdLine += ` --port ${assignedPort}`;
  } else if (devCommand.type.includes('dev')) {
    // npm/pnpm/yarn run dev - pass through with --
    cmdLine += ` -- --port ${assignedPort}`;
  }

  const label = typeLabels[devCommand.type] || `📦 ${devCommand.type}`;
  ws.send(JSON.stringify({ type: 'netlify-output', project, data: `\n${label} starter i ${project}...\n` }));
  ws.send(JSON.stringify({ type: 'netlify-output', project, data: `Kommando: ${cmdLine}\n` }));
  ws.send(JSON.stringify({ type: 'netlify-output', project, data: `🔌 Port: ${assignedPort}\n\n` }));
  console.log('Running command:', cmdLine, 'in', projectPath);

  // Send preview URL immediately with assigned port
  ws.send(JSON.stringify({ type: 'preview-url', project, url: `http://localhost:${assignedPort}` }));

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
