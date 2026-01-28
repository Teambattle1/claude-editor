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

// Store active processes
let claudeProcess = null;
let netlifyProcess = null;
let currentProject = null;
let claudeReady = false;
let activeVitePort = null;
let activeNetlifyPort = null;
let fileWatcher = null;

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

// File watcher for auto-refresh
function startFileWatcher(project) {
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
  }

  const projectPath = path.join(GITHUB_PATH, project);

  // Watch for file changes, ignore node_modules, .git, etc.
  fileWatcher = chokidar.watch(projectPath, {
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

  fileWatcher.on('all', (event, filePath) => {
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
            event: event,
            file: relativePath
          }));
        }
      });
    }, 300); // 300ms debounce
  });

  console.log(`File watcher started for ${project}`);
}

function stopFileWatcher() {
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
    console.log('File watcher stopped');
  }
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
  currentProject = project;
  claudeReady = true;

  const projectPath = path.join(GITHUB_PATH, project);

  // Clean up old temp files when starting a new session
  cleanupTempFiles(projectPath);

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
      ws.send(JSON.stringify({ type: 'claude-output', data: `📎 ${textFiles.length} tekstfil(er) inkluderet i prompt\n` }));
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

      ws.send(JSON.stringify({ type: 'claude-output', data: `🖼️ ${imageFiles.length} billede(r) gemt i .claude-temp/ - Claude kan læse dem\n` }));
    }
  }

  ws.send(JSON.stringify({ type: 'claude-output', data: `\n💬 > ${command}\n\n` }));

  // Build arguments array - use stream-json for real-time output without TTY
  // --verbose is required when using stream-json with -p
  const args = ['-p', fullPrompt, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'];


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

// Detect port from dev server output and send to client
function detectAndSendPort(output, ws) {
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

      console.log('Detected port:', port, 'type:', type, 'from output:', output.substring(0, 50));

      // Determine if this is a Netlify proxy port or a dev server port
      if (port === '8888') {
        // Always update Netlify port and send URL
        activeNetlifyPort = port;
        console.log('Sending Netlify preview-url:', port);
        ws.send(JSON.stringify({ type: 'preview-url', url: `http://localhost:${port}` }));
      } else {
        // Only set Vite port if not already set, or if this is a confirmed ready message
        if (!activeVitePort || type === 'vite-ready' || type === 'confirmed-ready') {
          activeVitePort = port;
          console.log('Sending Vite preview-url:', port);
          ws.send(JSON.stringify({ type: 'preview-url', url: `http://localhost:${port}` }));
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
  if (netlifyProcess) {
    ws.send(JSON.stringify({ type: 'netlify-output', data: '\n⚠️ Stopper eksisterende dev server...\n' }));
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

  // Detect what type of project this is
  const devCommand = detectDevCommand(projectPath);

  if (!devCommand) {
    ws.send(JSON.stringify({ type: 'netlify-output', data: '⚠️ Kunne ikke finde dev kommando (ingen netlify.toml, vite.config, eller package.json scripts)\n' }));
    ws.send(JSON.stringify({ type: 'netlify-output', data: '💡 Prøv at åbne projektet manuelt med: cd ' + projectPath + ' && npm run dev\n' }));
    return;
  }

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

  const typeLabels = {
    'netlify': '🌐 Netlify Dev',
    'vite': '⚡ Vite Dev Server',
    'npm-dev': '📦 npm run dev',
    'npm-start': '📦 npm start'
  };

  ws.send(JSON.stringify({ type: 'netlify-output', data: `\n${typeLabels[devCommand.type]} starter i ${project}...\n` }));
  ws.send(JSON.stringify({ type: 'netlify-output', data: `Kommando: ${devCommand.cmd} ${devCommand.args.join(' ')}\n\n` }));

  netlifyProcess = spawn(devCommand.cmd, devCommand.args, {
    cwd: projectPath,
    env: { ...process.env, FORCE_COLOR: '1', BROWSER: 'none' },
    shell: true
  });

  netlifyProcess.stdout.on('data', (data) => {
    const output = data.toString();
    console.log('Dev server stdout:', output.substring(0, 100));
    ws.send(JSON.stringify({ type: 'netlify-output', data: output }));

    // Detect ports from various patterns
    detectAndSendPort(output, ws);
  });

  netlifyProcess.stderr.on('data', (data) => {
    const output = data.toString();
    console.log('Dev server stderr:', output.substring(0, 100));
    ws.send(JSON.stringify({ type: 'netlify-output', data: output }));

    // Detect ports from various patterns
    detectAndSendPort(output, ws);
  });

  netlifyProcess.on('error', (err) => {
    console.log('Dev server process error:', err.message);
    ws.send(JSON.stringify({ type: 'netlify-output', data: `\n❌ Dev server fejl: ${err.message}\n` }));
  });

  netlifyProcess.on('close', (code) => {
    ws.send(JSON.stringify({ type: 'netlify-output', data: `\n\n📋 Dev server afsluttet med kode ${code}\n` }));
    ws.send(JSON.stringify({ type: 'netlify-stopped' }));
    netlifyProcess = null;
    activeVitePort = null;
    activeNetlifyPort = null;
  });

  ws.send(JSON.stringify({ type: 'netlify-started' }));

  // Start file watcher for auto-refresh
  startFileWatcher(project);
}

function stopNetlify(ws) {
  stopFileWatcher();
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
