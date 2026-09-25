// The apps on this computer, for a chat's workspace (src/ui/workspace.js): a
// chat that works on this server can be pointed at some of them. An app is a
// project folder (one with a package.json, a Dockerfile, a .git folder, and
// so on) in the places people keep them, or a running Docker container.
// Found fresh each time the app asks (GET /v1/apps), in a few seconds at most.

import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, join } from 'node:path';

/** Files that make a folder an app, and what they say about it (first match wins). */
const MARKERS = [
  ['docker-compose.yml', 'Docker'], ['docker-compose.yaml', 'Docker'], ['compose.yaml', 'Docker'], ['compose.yml', 'Docker'],
  ['package.json', 'Node'], ['pyproject.toml', 'Python'], ['requirements.txt', 'Python'], ['go.mod', 'Go'],
  ['Cargo.toml', 'Rust'], ['Gemfile', 'Ruby'], ['composer.json', 'PHP'], ['pom.xml', 'Java'], ['build.gradle', 'Java'],
  ['Dockerfile', 'Docker'], ['.git', 'Git'],
];
/** Folders under home where code usually lives, looked into one level deeper. */
const CODE_DIRS = ['Projects', 'projects', 'code', 'Code', 'src', 'dev', 'Dev', 'Developer', 'repos', 'Repos', 'git', 'GitHub', 'work', 'Sites',
  join('Documents', 'GitHub'), join('Documents', 'Projects'), join('source', 'repos')];
/** Folders that are never apps, or too big to look through. */
const SKIP = new Set(['node_modules', 'AppData', 'Library', 'Applications', 'Downloads', 'Desktop', 'Pictures', 'Music', 'Movies', 'Videos',
  'Public', 'OneDrive', 'snap', 'go', '.cache', '.npm', '.local', '.config', '.vscode', '.cursor', '.nvm', '.cargo', '.rustup']);
const MAX_APPS = 60;
const BUDGET_MS = 4000;

/**
 * [{ name, path, kind, repo? }] for folders, then [{ name, kind: 'Container',
 * image, status }] for running containers. `workspace`: the folder the bots
 * work in (looked through too).
 */
export async function findApps({ workspace } = {}) {
  const deadline = Date.now() + BUDGET_MS;
  const home = homedir();
  const roots = [
    ...(workspace ? [workspace] : []),
    home,
    ...CODE_DIRS.map((d) => join(home, d)),
    ...(platform() === 'linux' ? ['/srv', '/var/www', '/root'] : []),
  ];
  const seen = new Set();
  const apps = [];
  for (const dir of roots) {
    if (Date.now() > deadline || apps.length >= MAX_APPS) break;
    for (const child of await subfolders(dir)) {
      if (Date.now() > deadline || apps.length >= MAX_APPS) break;
      if (seen.has(child)) continue;
      seen.add(child);
      const app = await appAt(child);
      if (app) apps.push(app);
    }
  }
  apps.sort((a, b) => b.changed - a.changed);
  const containers = await dockerContainers(Math.max(500, deadline - Date.now()));
  return [...apps.map(({ changed, ...app }) => app), ...containers];
}

async function subfolders(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/** The app in `dir`, or null when nothing there says it's one. */
async function appAt(dir) {
  let names;
  try {
    names = new Set(await readdir(dir));
  } catch {
    return null;
  }
  const marker = MARKERS.find(([file]) => names.has(file));
  if (!marker) return null;
  const app = { name: basename(dir), path: dir, kind: marker[1], changed: 0 };
  try {
    app.changed = (await stat(dir)).mtimeMs;
  } catch { /* keep 0 */ }
  if (names.has('.git')) {
    const repo = await gitHubRepo(dir);
    if (repo) app.repo = repo;
  }
  return app;
}

/** "owner/name" of the GitHub repository a folder's git remote points at. */
async function gitHubRepo(dir) {
  try {
    const config = await readFile(join(dir, '.git', 'config'), 'utf8');
    return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/m.exec(config)?.[1] || null;
  } catch {
    return null;
  }
}

/** Running Docker containers, or none when Docker isn't there. */
function dockerContainers(timeout) {
  return new Promise((resolve) => {
    execFile('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}'], { timeout, windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout).split('\n').filter(Boolean).slice(0, 30).map((line) => {
        const [name, image, status] = line.split('\t');
        return { name, kind: 'Container', image: image || '', status: status || '' };
      }));
    });
  });
}
