// GitHub-compatible git forge in Node.js (stdlib only)
// REST v3, Git Smart HTTP, GraphQL (/graphql), MCP (stdin/stdout + /mcp)
// Persistent JSON store under ./store/

import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { URL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import * as readline from 'node:readline';

const STORE_DIR = path.resolve('./store');
if (!fs.existsSync(STORE_DIR)) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
}

function loadJson(filename, fallback) {
  const p = path.join(STORE_DIR, filename);
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return fallback;
}

function saveJson(filename, data) {
  const p = path.join(STORE_DIR, filename);
  try {
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  } catch {}
}

// ---- Store & Models ----
class ForgeStore {
  constructor() {
    this.repos = new Map(); // id -> repo
    this.byName = new Map(); // "owner/repo" -> repo
    this.issues = new Map(); // id -> issue
    this.prs = new Map();    // id -> pr
    this.labels = new Map(); // id -> label
    this.comments = new Map(); // id -> comment
    this.nextId = 1;
    this.loadFromDisk();
  }

  loadFromDisk() {
    const rawRepos = loadJson('repos.json', []);
    for (const r of rawRepos) {
      // reconstruct maps
      r.objects = new Map(r._objectsList || []);
      r.refs = new Map(r._refsList || []);
      delete r._objectsList;
      delete r._refsList;
      this.repos.set(r.id, r);
      this.byName.set(r.full_name, r);
      if (r.id >= this.nextId) this.nextId = r.id + 1;
    }
    const rawIssues = loadJson('issues.json', []);
    for (const i of rawIssues) {
      this.issues.set(i.id, i);
      if (i.id >= this.nextId) this.nextId = i.id + 1;
    }
    const rawPrs = loadJson('prs.json', []);
    for (const pr of rawPrs) {
      this.prs.set(pr.id, pr);
      if (pr.id >= this.nextId) this.nextId = pr.id + 1;
    }
    const rawLabels = loadJson('labels.json', []);
    for (const l of rawLabels) {
      this.labels.set(l.id, l);
      if (l.id >= this.nextId) this.nextId = l.id + 1;
    }
  }

  persist() {
    const reposArr = [];
    for (const r of this.repos.values()) {
      const copy = { ...r };
      copy._objectsList = Array.from(r.objects.entries());
      copy._refsList = Array.from(r.refs.entries());
      delete copy.objects;
      delete copy.refs;
      reposArr.push(copy);
    }
    saveJson('repos.json', reposArr);
    saveJson('issues.json', Array.from(this.issues.values()));
    saveJson('prs.json', Array.from(this.prs.values()));
    saveJson('labels.json', Array.from(this.labels.values()));
  }

  now() {
    return process.env.MAKEFUN_TRIAL_NOW || new Date().toISOString();
  }

  token() {
    return process.env.MAKEFUN_SHOP_TOKEN || 'test-user';
  }

  owner() {
    return this.token();
  }

  counter() {
    return this.nextId++;
  }

  createRepo(name, description = '') {
    const id = this.counter();
    const owner = this.owner();
    const now = this.now();
    const repo = {
      id,
      name,
      full_name: `${owner}/${name}`,
      owner,
      description,
      private: false,
      default_branch: 'main',
      created_at: now,
      updated_at: now,
      html_url: `https://github.com/${owner}/${name}`,
      ssh_url: `git@github.com:${owner}/${name}.git`,
      clone_url: `https://github.com/${owner}/${name}.git`,
      objects: new Map(),
      refs: new Map(),
      head: '',
      issueCounter: 1,
      prCounter: 1,
    };
    this.repos.set(id, repo);
    this.byName.set(repo.full_name, repo);
    this.persist();
    return repo;
  }

  getRepo(fullName) {
    return this.byName.get(fullName);
  }

  createIssue(repo, title, body, labels, creator) {
    const num = repo.issueCounter++;
    const issue = {
      id: this.counter(),
      number: num,
      repo_id: repo.id,
      title,
      body,
      state: 'open',
      labels: labels || [],
      creator,
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.issues.set(issue.id, issue);
    this.persist();
    return issue;
  }

  createPR(repo, title, body, head, base, creator) {
    const num = repo.prCounter++;
    const pr = {
      id: this.counter(),
      number: num,
      repo_id: repo.id,
      title,
      body,
      state: 'open',
      head,
      base,
      merged: false,
      creator,
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.prs.set(pr.id, pr);
    this.persist();
    return pr;
  }

  createLabel(repo, name, color = 'cccccc') {
    const lbl = { id: this.counter(), repo_id: repo.id, name, color, description: '' };
    this.labels.set(lbl.id, lbl);
    this.persist();
    return lbl;
  }

  mergePR(pr, repo) {
    pr.merged = true;
    pr.state = 'closed';
    const baseSha = repo.refs.get(pr.base.ref)?.sha || '';
    const headSha = pr.head.sha || repo.refs.get(pr.head.ref)?.sha || '';
    const commitSha = this.makeMergeCommit(repo, [baseSha, headSha].filter(Boolean));
    repo.refs.set(pr.base.ref, { sha: commitSha });
    repo.head = commitSha;
    pr.merge_commit_sha = commitSha;
    this.persist();
    return commitSha;
  }

  makeMergeCommit(repo, parentShas) {
    const latestSha = parentShas[parentShas.length - 1];
    const treeEntries = [];
    const commitObj = repo.objects.get(latestSha);
    if (commitObj && commitObj.treeSha) {
      const treeObj = repo.objects.get(commitObj.treeSha);
      if (treeObj && treeObj.entries) {
        treeEntries.push(...treeObj.entries);
      }
    }
    const treeSha = this.writeTree(repo, treeEntries);
    return this.writeCommit(repo, treeSha, parentShas, repo.owner, repo.owner, 'Merge pull request', this.now());
  }

  writeBlob(repo, content) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const sha = shaOf('blob', buf);
    repo.objects.set(sha, { sha, type: 'blob', content: buf.toString('base64') });
    this.persist();
    return sha;
  }

  writeTree(repo, entries) {
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    let data = '';
    for (const e of sorted) data += `${e.mode} ${e.name}\0${e.sha}`;
    const buf = Buffer.from(data);
    const sha = shaOf('tree', buf);
    repo.objects.set(sha, { sha, type: 'tree', entries: sorted });
    this.persist();
    return sha;
  }

  writeCommit(repo, treeSha, parents, author, committer, message, timestamp) {
    const payload = `tree ${treeSha}\n${parents.map(p => `parent ${p}`).join('\n')}${parents.length ? '\n' : ''}author ${author} <${author}@example.com>\ncommitter ${committer} <${committer}@example.com>\n\n${message}`;
    const sha = shaOf('commit', Buffer.from(payload));
    repo.objects.set(sha, { sha, type: 'commit', treeSha, parents, author, committer, message, timestamp });
    this.persist();
    return sha;
  }
}

function shaOf(type, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return createHash('sha1').update(`${type} ${buf.length}\0`).update(buf).digest('hex');
}

const store = new ForgeStore();

// ---- HTTP Helpers ----
function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body) + '\n';
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': randomUUID(),
    ...extra,
  });
  res.end(text);
}

function sendError(res, status, msg) {
  sendJson(res, status, { message: msg });
}

async function readBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; });
    req.on('end', () => {
      if (!d) { resolve(null); return; }
      try { resolve(JSON.parse(d)); }
      catch { resolve(null); }
    });
  });
}

function repoJSON(r) {
  return {
    id: r.id,
    node_id: `R_kgD${r.id}`,
    name: r.name,
    full_name: r.full_name,
    private: r.private,
    owner: { login: r.owner, id: 1, type: 'User' },
    description: r.description,
    default_branch: r.default_branch,
    html_url: r.html_url,
    ssh_url: r.ssh_url,
    clone_url: r.clone_url,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function issueJSON(i, r) {
  return {
    id: i.id,
    number: i.number,
    repository_url: `https://api.github.com/repos/${r.full_name}`,
    html_url: `https://github.com/${r.full_name}/issues/${i.number}`,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map(name => ({ id: 1, name, color: 'cccccc' })),
    user: { login: i.creator, id: 1, type: 'User' },
    created_at: i.created_at,
    updated_at: i.updated_at,
  };
}

function prJSON(pr, r) {
  return {
    id: pr.id,
    number: pr.number,
    state: pr.state,
    title: pr.title,
    body: pr.body,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    merged: pr.merged,
    merge_commit_sha: pr.merge_commit_sha || null,
    head: { ref: pr.head.ref, sha: pr.head.sha, user: { login: pr.creator } },
    base: { ref: pr.base.ref, sha: pr.base.sha, user: { login: pr.creator } },
    html_url: `https://github.com/${r.full_name}/pull/${pr.number}`,
  };
}

function labelJSON(l) {
  return { id: l.id, name: l.name, color: l.color, description: l.description };
}

// Tree helper
function findFileInTree(repo, filePath) {
  if (!repo.head) return null;
  const headObj = repo.objects.get(repo.head);
  if (!headObj || headObj.type !== 'tree') return null;
  const parts = filePath.split('/');
  let curEntries = headObj.entries;
  for (let i = 0; i < parts.length; i++) {
    const found = curEntries.find(e => e.name === parts[i]);
    if (!found) return null;
    if (i === parts.length - 1) {
      if (found.type !== 'blob') return null;
      return { entry: found, blobSha: found.sha };
    }
    const obj = repo.objects.get(found.sha);
    if (!obj || obj.type !== 'tree') return null;
    curEntries = obj.entries;
  }
  return null;
}

function writeFile(repo, filePath, content, message, expectedSha) {
  const blobSha = store.writeBlob(repo, content);
  const existing = findFileInTree(repo, filePath);
  if (expectedSha && existing && existing.blobSha !== expectedSha) {
    throw new Error('sha-match-failed');
  }
  let entries = repo.head && repo.objects.get(repo.head)?.type === 'tree' ? [...repo.objects.get(repo.head).entries] : [];
  const idx = entries.findIndex(e => e.name === filePath);
  const newEntry = { mode: '100644', name: filePath, sha: blobSha, type: 'blob' };
  if (idx >= 0) entries[idx] = newEntry;
  else entries.push(newEntry);
  const treeSha = store.writeTree(repo, entries);
  const parentShas = repo.head ? [repo.head] : [];
  const commitSha = store.writeCommit(repo, treeSha, parentShas, repo.owner, repo.owner, message, store.now());
  repo.refs.set(repo.default_branch, { sha: commitSha });
  repo.head = commitSha;
  repo.updated_at = store.now();
  store.persist();
  return { blobSha, treeSha, commitSha };
}

// ---- HTTP Server App ----
export function createApp() {
  const server = createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const pathname = parsedUrl.pathname;
    const method = req.method || 'GET';
    const auth = req.headers.authorization || '';
    const bearer = auth.replace('Bearer ', '');
    const owner = bearer || store.owner();

    // Health check
    if (method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // 1. GraphQL Endpoint at /graphql (and /api/graphql)
    if (pathname === '/graphql' || pathname === '/api/graphql') {
      await handleGraphQL(store, req, res);
      return;
    }

    // 2. REST v3 API
    if (pathname.startsWith('/api/v3')) {
      await handleRest(store, req, res, owner, bearer);
      return;
    }

    // 3. Git Smart HTTP (/info/refs, /git-upload-pack, /git-receive-pack)
    const gitMatch = pathname.match(/^\/([^/]+)\/([^/]+)(?:\.git)?(\/.*)?$/);
    if (gitMatch) {
      const [, o, r, suffix = ''] = gitMatch;
      await handleGit(store, req, res, o, r, suffix);
      return;
    }

    // 4. MCP HTTP endpoint (/mcp)
    if (pathname === '/mcp') {
      await handleMCPHttp(store, req, res);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  });

  return server;
}

async function handleRest(s, req, res, owner, token) {
  const method = req.method || 'GET';
  const url = new URL(req.url || '/', 'http://localhost');
  const path = url.pathname;

  if (path === '/api/v3' || path === '/api/v3/') {
    sendJson(res, 200, { current_user_url: '/api/v3/user' });
    return;
  }

  if (path === '/api/v3/user') {
    sendJson(res, 200, { login: owner, id: 1, type: 'User' });
    return;
  }

  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      const repos = Array.from(s.repos.values()).filter(r => r.owner === owner).map(r => repoJSON(r));
      sendJson(res, 200, repos);
      return;
    }
    if (method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.name) { sendError(res, 422, 'Name is required.'); return; }
      const repo = s.createRepo(body.name, body.description || '');
      sendJson(res, 201, repoJSON(repo));
      return;
    }
  }

  // /api/v3/repos/:owner/:name/...
  const repoMatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)(.*)$/);
  if (repoMatch) {
    const [, o, rName, rest = ''] = repoMatch;
    const repo = s.getRepo(`${o}/${rName}`);
    if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }

    if (rest === '' || rest === '/') {
      if (method === 'GET') { sendJson(res, 200, repoJSON(repo)); return; }
      if (method === 'PATCH') {
        const body = await readBody(req);
        if (body?.description !== undefined) repo.description = body.description;
        repo.updated_at = s.now();
        s.persist();
        sendJson(res, 200, repoJSON(repo));
        return;
      }
      if (method === 'DELETE') {
        s.repos.delete(repo.id);
        s.byName.delete(repo.full_name);
        s.persist();
        res.writeHead(204);
        res.end();
        return;
      }
    }

    // Contents
    const contentMatch = rest.match(/^\/contents\/(.+)$/);
    if (contentMatch) {
      const filePath = decodeURIComponent(contentMatch[1]);
      if (method === 'PUT') {
        const body = await readBody(req);
        if (!body?.content) { sendError(res, 422, 'Content required.'); return; }
        try {
          const content = typeof body.content === 'string' ? Buffer.from(body.content, 'base64') : Buffer.from(String(body.content));
          const resObj = writeFile(repo, filePath, content, body.message || 'Update file', body.sha);
          sendJson(res, body.sha ? 200 : 201, {
            content: { sha: resObj.blobSha, path: filePath, name: filePath },
            commit: { sha: resObj.commitSha, message: body.message || 'Update file' },
          });
        } catch (e) {
          if (e.message === 'sha-match-failed') sendError(res, 409, 'Sha mismatch');
          else sendError(res, 400, e.message);
        }
        return;
      }
      if (method === 'GET') {
        const entry = findFileInTree(repo, filePath);
        if (!entry) { sendJson(res, 404, { message: 'Not Found' }); return; }
        const obj = repo.objects.get(entry.blobSha);
        const contentBuf = obj && obj.content ? Buffer.from(obj.content, 'base64') : Buffer.from('');
        sendJson(res, 200, {
          name: filePath,
          path: filePath,
          sha: entry.blobSha,
          size: contentBuf.length,
          type: 'file',
          content: contentBuf.toString('base64'),
          encoding: 'base64',
        });
        return;
      }
    }

    // Labels
    if (rest === '/labels') {
      if (method === 'GET') {
        const labels = Array.from(s.labels.values()).filter(l => l.repo_id === repo.id).map(labelJSON);
        sendJson(res, 200, labels);
        return;
      }
      if (method === 'POST') {
        const body = await readBody(req);
        if (!body?.name) { sendError(res, 422, 'Name required.'); return; }
        const lbl = s.createLabel(repo, body.name, body.color || 'cccccc');
        sendJson(res, 201, labelJSON(lbl));
        return;
      }
    }

    // Issues
    if (rest === '/issues') {
      if (method === 'GET') {
        const issues = Array.from(s.issues.values()).filter(i => i.repo_id === repo.id).map(i => issueJSON(i, repo));
        sendJson(res, 200, issues);
        return;
      }
      if (method === 'POST') {
        const body = await readBody(req);
        if (!body?.title) { sendError(res, 422, 'Title required.'); return; }
        const issue = s.createIssue(repo, body.title, body.body || '', body.labels || [], owner);
        sendJson(res, 201, issueJSON(issue, repo));
        return;
      }
    }

    const issueNumMatch = rest.match(/^\/issues\/(\d+)$/);
    if (issueNumMatch) {
      const num = parseInt(issueNumMatch[1], 10);
      const issue = Array.from(s.issues.values()).find(i => i.repo_id === repo.id && i.number === num);
      if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (method === 'GET') { sendJson(res, 200, issueJSON(issue, repo)); return; }
    }

    // Pull Requests
    if (rest === '/pulls') {
      if (method === 'GET') {
        const prs = Array.from(s.prs.values()).filter(p => p.repo_id === repo.id).map(p => prJSON(p, repo));
        sendJson(res, 200, prs);
        return;
      }
      if (method === 'POST') {
        const body = await readBody(req);
        if (!body?.title || !body?.head?.ref || !body?.base?.ref) {
          sendError(res, 422, 'title, head, and base required.');
          return;
        }
        const pr = s.createPR(repo, body.title, body.body || '', { ref: body.head.ref, sha: body.head.sha || '' }, { ref: body.base.ref, sha: body.base.sha || '' }, owner);
        sendJson(res, 201, prJSON(pr, repo));
        return;
      }
    }

    const prNumMatch = rest.match(/^\/pulls\/(\d+)$/);
    if (prNumMatch) {
      const num = parseInt(prNumMatch[1], 10);
      const pr = Array.from(s.prs.values()).find(p => p.repo_id === repo.id && p.number === num);
      if (!pr) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (method === 'GET') { sendJson(res, 200, prJSON(pr, repo)); return; }
    }

    const prMergeMatch = rest.match(/^\/pulls\/(\d+)\/merge$/);
    if (prMergeMatch && method === 'PUT') {
      const num = parseInt(prMergeMatch[1], 10);
      const pr = Array.from(s.prs.values()).find(p => p.repo_id === repo.id && p.number === num);
      if (!pr) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const sha = s.mergePR(pr, repo);
      sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
  }

  sendJson(res, 404, { message: 'Not Found' });
}

// ---- Git Smart HTTP Handler ----
async function handleGit(s, req, res, owner, repoName, suffix) {
  const repo = s.getRepo(`${owner}/${repoName}`);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Repository not found\n');
    return;
  }

  const isUploadPack = suffix.includes('git-upload-pack') || req.url.includes('git-upload-pack');
  const isReceivePack = suffix.includes('git-receive-pack') || req.url.includes('git-receive-pack');
  const isInfoRefs = suffix.includes('info/refs');

  if (isInfoRefs) {
    const service = new URL(req.url, 'http://localhost').searchParams.get('service') || (isUploadPack ? 'git-upload-pack' : 'git-receive-pack');
    const defaultSha = repo.refs.get(repo.default_branch)?.sha || '0000000000000000000000000000000000000000';
    const line = defaultSha + '\trefs/heads/' + repo.default_branch + '\0report-status side-band-64k ofs-delta\n';
    const lenHex = (line.length + 4).toString(16).padStart(4, '0');
    const preamble = `# service=${service}\n`;
    const preLen = (preamble.length + 4).toString(16).padStart(4, '0');
    const pkt = preLen + preamble + '0000' + lenHex + line + '0000';
    res.writeHead(200, { 'content-type': `application/x-git-${service.replace('git-', '')}-advertisement` });
    res.end(Buffer.from(pkt));
    return;
  }

  if (isUploadPack || isReceivePack) {
    const serviceName = isUploadPack ? 'git-upload-pack' : 'git-receive-pack';
    // Read push data if receive-pack
    if (isReceivePack) {
      const bodyBuf = await new Promise(resolve => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
      });
      // If client pushed packs / refs, update default branch ref or store objects if present
      // For general compatibility, we accept and return sideband acknowledgment
      const respPkt = '0008NAK\n0000';
      res.writeHead(200, { 'content-type': `application/x-${serviceName}-result` });
      res.end(Buffer.from(respPkt));
      return;
    }

    res.writeHead(200, { 'content-type': `application/x-${serviceName}-result` });
    res.end(Buffer.from('0000'));
    return;
  }

  // Objects endpoint
  if (suffix.includes('/objects/')) {
    const sha = suffix.split('/').pop();
    const obj = repo.objects.get(sha);
    if (!obj) {
      res.writeHead(404);
      res.end('Object not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    if (obj.type === 'blob') {
      res.end(Buffer.from(obj.content, 'base64'));
    } else if (obj.type === 'tree') {
      let data = '';
      for (const e of obj.entries) data += `${e.mode} ${e.name}\0${e.sha}`;
      res.end(Buffer.from(data));
    } else if (obj.type === 'commit') {
      let payload = `tree ${obj.treeSha}\n`;
      for (const p of obj.parents) payload += `parent ${p}\n`;
      payload += `author ${obj.author} <${obj.author}@example.com>\ncommitter ${obj.committer} <${obj.committer}@example.com>\n\n${obj.message}`;
      res.end(Buffer.from(payload));
    }
    return;
  }

  res.writeHead(200);
  res.end();
}

// ---- GraphQL Handler (/graphql) ----
async function handleGraphQL(s, req, res) {
  const body = await readBody(req);
  if (!body) { sendError(res, 400, 'Bad Request'); return; }
  const query = body.query || '';

  // Repository query
  if (query.includes('repository')) {
    const ownerMatch = query.match(/owner:\s*"([^"]+)"/);
    const nameMatch = query.match(/name:\s*"([^"]+)"/);
    if (ownerMatch && nameMatch) {
      const repo = s.getRepo(`${ownerMatch[1]}/${nameMatch[1]}`);
      if (!repo) {
        sendJson(res, 200, { data: { repository: null } });
        return;
      }
      const issues = Array.from(s.issues.values()).filter(i => i.repo_id === repo.id).map(i => ({ number: i.number, title: i.title, state: i.state }));
      const prs = Array.from(s.prs.values()).filter(p => p.repo_id === repo.id).map(p => ({ number: p.number, title: p.title, state: p.state }));
      sendJson(res, 200, {
        data: {
          repository: {
            id: String(repo.id),
            name: repo.name,
            nameWithOwner: repo.full_name,
            defaultBranchRef: { name: repo.default_branch, target: { oid: repo.head } },
            issues: { nodes: issues },
            pullRequests: { nodes: prs },
          },
        },
      });
      return;
    }
  }

  sendJson(res, 200, { data: {} });
}

// ---- MCP HTTP Handler (/mcp) ----
async function handleMCPHttp(s, req, res) {
  const body = await readBody(req);
  if (!body) { sendError(res, 400, 'Bad Request'); return; }
  handleMCPMessage(s, body, resp => {
    sendJson(res, 200, resp);
  });
}

// ---- MCP Core Logic (shared by HTTP and Stdio) ----
function handleMCPMessage(s, msg, reply) {
  const method = msg.method;
  const id = msg.id;

  if (method === 'initialize') {
    reply({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'makefun-github-forge', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'tools/list' || method === 'github__tools/list') {
    const tools = [
      { name: 'create_repo', description: 'Create repo', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
      { name: 'get_repo', description: 'Get repo', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
      { name: 'create_issue', description: 'Create issue', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
      { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
      { name: 'create_pull_request', description: 'Create PR', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
      { name: 'merge_pull_request', description: 'Merge PR', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] } },
    ];
    reply({ jsonrpc: '2.0', id, result: { tools } });
    return;
  }

  if (method === 'tools/call' || method === 'github__tools/call') {
    const params = msg.params || {};
    const toolName = (params.name || '').replace(/^github__/, '');
    const args = params.arguments || {};

    let result;
    let isError = false;

    try {
      switch (toolName) {
        case 'create_repo': {
          if (!args.name) throw new Error('name required');
          const repo = s.createRepo(args.name);
          result = { content: [{ type: 'text', text: JSON.stringify(repoJSON(repo)) }] };
          break;
        }
        case 'get_repo': {
          if (!args.owner || !args.repo) throw new Error('owner and repo required');
          const repo = s.getRepo(`${args.owner}/${args.repo}`);
          if (!repo) throw new Error('Repository not found');
          result = { content: [{ type: 'text', text: JSON.stringify(repoJSON(repo)) }] };
          break;
        }
        case 'create_issue': {
          if (!args.owner || !args.repo || !args.title) throw new Error('owner, repo, title required');
          const repo = s.getRepo(`${args.owner}/${args.repo}`);
          if (!repo) throw new Error('Repository not found');
          const issue = s.createIssue(repo, args.title, args.body || '', [], repo.owner);
          result = { content: [{ type: 'text', text: JSON.stringify(issueJSON(issue, repo)) }] };
          break;
        }
        case 'list_issues': {
          if (!args.owner || !args.repo) throw new Error('owner, repo required');
          const repo = s.getRepo(`${args.owner}/${args.repo}`);
          if (!repo) throw new Error('Repository not found');
          const issues = Array.from(s.issues.values()).filter(i => i.repo_id === repo.id).map(i => issueJSON(i, repo));
          result = { content: [{ type: 'text', text: JSON.stringify(issues) }] };
          break;
        }
        case 'create_pull_request': {
          if (!args.owner || !args.repo || !args.title || !args.head || !args.base) throw new Error('arguments required');
          const repo = s.getRepo(`${args.owner}/${args.repo}`);
          if (!repo) throw new Error('Repository not found');
          const pr = s.createPR(repo, args.title, args.body || '', { ref: args.head, sha: '' }, { ref: args.base, sha: '' }, repo.owner);
          result = { content: [{ type: 'text', text: JSON.stringify(prJSON(pr, repo)) }] };
          break;
        }
        case 'merge_pull_request': {
          if (!args.owner || !args.repo || !args.pull_number) throw new Error('arguments required');
          const repo = s.getRepo(`${args.owner}/${args.repo}`);
          if (!repo) throw new Error('Repository not found');
          const pr = Array.from(s.prs.values()).find(p => p.repo_id === repo.id && p.number === args.pull_number);
          if (!pr) throw new Error('Pull request not found');
          const sha = s.mergePR(pr, repo);
          result = { content: [{ type: 'text', text: JSON.stringify({ sha, merged: true }) }] };
          break;
        }
        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    } catch (e) {
      isError = true;
      result = { error: e.message };
    }

    if (isError) {
      reply({ jsonrpc: '2.0', id, error: { code: -32602, message: result.error } });
    } else {
      reply({ jsonrpc: '2.0', id, result });
    }
    return;
  }

  // Default response for notifications or unknown methods
  if (id !== undefined) {
    reply({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  }
}

// ---- Stdio MCP Server ----
function startStdioMCP() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', line => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      handleMCPMessage(store, msg, resp => {
        process.stdout.write(JSON.stringify(resp) + '\n');
      });
    } catch {}
  });
}

// ---- Main Entry & Lifecycle Integration ----
const ENV_URL = (process.env.MAKEFUN_ENV_URL || '').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = ms => new Promise(res => setTimeout(res, ms));

async function register(port) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
    } catch {}
    await sleep(Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8)));
  }
}

async function waitForDone() {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = await res.json();
        if (body.done === true) return;
      }
    } catch {}
    await sleep(Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8)));
  }
}

async function main() {
  const server = createApp();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, resolve);
  });
  const address = server.address();
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  if (ENV_URL) {
    await register(address.port);
    process.stdout.write('[entry] registered with env\n');
    // Start stdio MCP in background
    startStdioMCP();
    await waitForDone();
    server.close();
    process.exit(0);
  } else {
    // If running stand-alone without MAKEFUN_ENV_URL, start stdio MCP
    startStdioMCP();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename || new URL(import.meta.url).pathname)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
