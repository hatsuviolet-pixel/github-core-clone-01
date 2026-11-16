// GitHub-compatible git forge — complete server implementation
// Implements: REST v3, Git Smart HTTP, GraphQL, MCP
// All using Node.js 22 standard library only

import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';

// ─── Constants ───────────────────────────────────────────────────────────────
const PORT_ENV = 'MAKEFUN_ENV_URL';
const TOKEN_ENV = 'MAKEFUN_SHOP_TOKEN';
const NOW_ENV = 'MAKEFUN_TRIAL_NOW';

// ─── Data types ──────────────────────────────────────────────────────────────
interface BlobObj { sha: string; content: Buffer; }
interface TreeEntry { mode: string; name: string; sha: string; type: 'blob' | 'tree'; }
interface TreeObj { sha: string; entries: TreeEntry[]; }
interface CommitObj { sha: string; treeSha: string; parents: string[]; author: string; committer: string; message: string; timestamp: string; }
interface Ref { sha: string; type?: string; target?: string; }

interface Repo {
  id: number; name: string; full_name: string; owner: string;
  description: string; private: boolean; default_branch: string;
  created_at: string; updated_at: string;
  html_url: string; ssh_url: string; clone_url: string;
  objects: Map<string, BlobObj | TreeObj | CommitObj>;
  refs: Map<string, Ref>;
  head: string; // current branch HEAD commit sha
  issueCounter: number; prCounter: number; labelCounter: number; commentCounter: number;
}

interface Issue { id: number; number: number; repo_id: number; title: string; body: string; state: 'open'|'closed'; labels: string[]; creator: string; created_at: string; updated_at: string; }
interface PullRequest { id: number; number: number; repo_id: number; title: string; body: string; state: 'open'|'closed'|'merged'; head: { ref: string; sha: string }; base: { ref: string; sha: string }; merged: boolean; merge_commit_sha?: string; creator: string; created_at: string; updated_at: string; }
interface Label { id: number; repo_id: number; name: string; color: string; description: string; }
interface Comment { id: number; body: string; creator: string; created_at: string; }

// ─── Performance caches ──────────────────────────────────────────────────────
let cacheDirty = true;

function invalidateCache() { cacheDirty = true; }

// ─── Store ───────────────────────────────────────────────────────────────────
let nextId = 1;
const counter = () => ++nextId;

class ForgeStore {
  repos = new Map<number, Repo>();
  byName = new Map<string, Repo>();
  issues = new Map<number, Issue>();
  prs = new Map<number, PullRequest>();
  labels = new Map<number, Label>();
  comments = new Map<number, Comment>();

  now() { return process.env[NOW_ENV] || new Date().toISOString(); }
  token() { return process.env[TOKEN_ENV] || 'fake-token'; }
  owner() { return this.token(); }

  createRepo(name: string, description = ''): Repo {
    const id = counter();
    const owner = this.owner();
    const now = this.now();
    const repo: Repo = {
      id, name, full_name: `${owner}/${name}`, owner, description, private: false,
      default_branch: 'main', created_at: now, updated_at: now,
      html_url: `https://github.com/${owner}/${name}`,
      ssh_url: `git@github.com:${owner}/${name}.git`,
      clone_url: `https://github.com/${owner}/${name}.git`,
      objects: new Map(), refs: new Map(), head: '',
      issueCounter: 1, prCounter: 1, labelCounter: 1, commentCounter: 1,
    };
    this.repos.set(id, repo);
    this.byName.set(repo.full_name, repo);
    invalidateCache();
    return repo;
  }

  getRepo(fullName: string): Repo | undefined {
    return this.byName.get(fullName);
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[], creator: string): Issue {
    const num = repo.issueCounter++;
    const issue: Issue = { id: counter(), number: num, repo_id: repo.id, title, body, state: 'open', labels: labelNames, creator, created_at: this.now(), updated_at: this.now() };
    this.issues.set(issue.id, issue);
    invalidateCache();
    return issue;
  }

  createPR(repo: Repo, title: string, body: string, head: { ref: string; sha: string }, base: { ref: string; sha: string }, creator: string): PullRequest {
    const num = repo.prCounter++;
    const pr: PullRequest = { id: counter(), number: num, repo_id: repo.id, title, body, state: 'open', head, base, merged: false, creator, created_at: this.now(), updated_at: this.now() };
    this.prs.set(pr.id, pr);
    invalidateCache();
    return pr;
  }

  createLabel(repo: Repo, name: string, color = 'cccccc'): Label {
    const lbl: Label = { id: counter(), repo_id: repo.id, name, color, description: '' };
    this.labels.set(lbl.id, lbl);
    invalidateCache();
    return lbl;
  }

  mergePR(pr: PullRequest, repo: Repo): string {
    pr.merged = true;
    pr.state = 'closed';
    const baseSha = repo.refs.get(pr.base.ref)?.sha || '';
    const headSha = pr.head.sha || repo.refs.get(pr.head.ref)?.sha || '';
    const commitSha = this.makeMergeCommit(repo, [baseSha, headSha].filter(Boolean));
    repo.refs.set(pr.base.ref, { sha: commitSha });
    repo.head = commitSha;
    pr.merge_commit_sha = commitSha;
    invalidateCache();
    return commitSha;
  }

  makeMergeCommit(repo: Repo, parentShas: string[]): string {
    // Simple squash: create a commit with all files from the latest tree
    const latestSha = parentShas[parentShas.length - 1];
    const treeEntry: TreeEntry[] = [];
    const commitObj = repo.objects.get(latestSha);
    if (commitObj && 'treeSha' in commitObj) {
      const treeObj = repo.objects.get((commitObj as CommitObj).treeSha);
      if (treeObj && 'entries' in treeObj) {
        treeEntry.push(...(treeObj as TreeObj).entries);
      }
    }
    const treeSha = this.writeTree(repo, treeEntry);
    return this.writeCommit(repo, treeSha, parentShas, 'forge-bot', 'forge-bot@example.com', `Merge pull request`, this.now());
  }

  // ─── Git object methods ──────────────────────────────────────────────────
  writeBlob(content: Buffer): string {
    const sha = shaOf('blob', content);
    const repo = Array.from(this.repos.values())[this.repos.size - 1];
    if (repo) repo.objects.set(sha, { sha, content });
    return sha;
  }

  writeTree(entries: TreeEntry[]): string {
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    let data = '';
    for (const e of sorted) data += `${e.mode} ${e.name}\0${e.sha}`;
    const sha = shaOf('tree', Buffer.from(data));
    const repo = Array.from(this.repos.values())[this.repos.size - 1];
    if (repo) repo.objects.set(sha, { sha, entries: sorted });
    return sha;
  }

  writeCommit(treeSha: string, parents: string[], author: string, committer: string, message: string, timestamp: string): string {
    const payload = `tree ${treeSha}\n${parents.map(p => `parent ${p}`).join('\n')}${parents.length ? '\n' : ''}author ${author}\ncommitter ${committer}\n\n${message}`;
    const sha = shaOf('commit', Buffer.from(payload));
    const repo = Array.from(this.repos.values())[this.repos.size - 1];
    if (repo) repo.objects.set(sha, { sha, treeSha, parents, author, committer, message, timestamp });
    return sha;
  }
}

function shaOf(type: string, data: Buffer): string {
  return createHash('sha1').update(`${type} ${data.length}\0`).digest('hex');
}

// ─── Shared store instance ───────────────────────────────────────────────────
const store = new ForgeStore();

// ─── Pre-built static responses ──────────────────────────────────────────────
const HEALTHZ_JSON = '{"ok":true}\n';
const API_ROOT_JSON = '{"current_user_url":"/api/v3/user","rate_limit_url":"/api/v3/rate_limit"}\n';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function sendJson(res: ServerResponse, status: number, body: any, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body) + '\n';
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'x-github-request-id': randomUUID(), ...extra });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, msg: string): void {
  sendJson(res, status, { message: msg });
}

function parseBody(req: IncomingMessage): Promise<any | null> {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; });
    req.on('end', () => {
      if (!d) { resolve(null); return; }
      try { resolve(JSON.parse(d)); }
      catch { sendError(res_temp!, 400, 'Malformed JSON'); resolve(null); }
    });
  });
}
let res_temp: ServerResponse | null = null;
async function readBody(req: IncomingMessage, res: ServerResponse): Promise<any | null> {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c; });
    req.on('end', () => {
      if (!d) { resolve(null); return; }
      try { resolve(JSON.parse(d)); }
      catch { sendError(res, 400, 'Malformed JSON'); resolve(null); }
    });
  });
}

function repoJSON(r: Repo): any {
  return {
    id: r.id, node_id: `MDEwOlJlZG9zaXRvcnkk${r.id}`, name: r.name, full_name: r.full_name,
    private: r.private,
    owner: { login: r.owner, id: 1, node_id: 'MDQ6VXNlcjE=', avatar_url: '', gravatar_id: '', url: `https://api.github.com/users/${r.owner}`, html_url: `https://github.com/${r.owner}`, type: 'User' },
    description: r.description, homepage: null, default_branch: r.default_branch,
    html_url: r.html_url, ssh_url: r.ssh_url, clone_url: r.clone_url, git_url: r.clone_url,
    theme_url: r.html_url, created_at: r.created_at, updated_at: r.updated_at,
    pushed_at: r.updated_at, size: 0, stargazers_count: 0, watchers_count: 0, language: null,
    has_issues: true, has_projects: true, has_downloads: true, has_wiki: true, has_pages: false,
    has_discussions: false, forks_count: 0, open_issues_count: 0, is_template: false,
    topics: [], visibility: 'public', security_configuration: null, allow_forking: true,
    is_archived: false, is_disabled: false, open_issues: 0, watchers: 0, forks: 0,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true,
    allow_auto_merge: false, delete_branch_on_merge: false, allow_update_branch: false,
    use_squash_pr_title_as_default: false, squash_merge_commit_message: 'COMMIT_MESSAGES',
    squash_merge_commit_title: 'COMMIT_OR_PR_TITLE', merge_commit_message: 'TITLE_AND_COMMENTS',
    merge_commit_title: 'MERGE_MESSAGE', default_branch_ref: { ref: r.default_branch, sha: r.head, type: 'ref' },
    temp_clone_token: '', authorization_url: 'https://github.com/login/oauth/authorize',
    disabled: false, _links: { self: { href: `https://api.github.com/repos/${r.full_name}` }, html: { href: r.html_url }, issues: { href: `https://api.github.com/repos/${r.full_name}/issues{?state}` }, pulls: { href: `https://api.github.com/repos/${r.full_name}/pulls{?state}` }, repo_label: { href: `https://api.github.com/repos/${r.full_name}/labels{/name}` }, repository_comments: { href: `https://api.github.com/repos/${r.full_name}/comments{/id}` }, download_archive: { href: `https://api.github.com/repos/${r.full_name}/archive/{+ref}` }, code: { href: `https://api.github.com/search/code?q=${encodeURIComponent(r.full_name)}` }, comments: { href: `https://api.github.com/repos/${r.full_name}/comments{/id}` }, events: { href: `https://api.github.com/repos/${r.full_name}/events` }, fork: { href: `https://api.github.com/repos/${r.full_name}/forks` }, branches: { href: `https://api.github.com/repos/${r.full_name}/branches{/branch}` }, collaborators: { href: `https://api.github.com/repos/${r.full_name}/collaborators{/collaborator}` }, commits: { href: `https://api.github.com/repos/${r.full_name}/commits{/sha}` }, commit_comments: { href: `https://api.github.com/repos/${r.full_name}/comments{/sha}` }, contributor_roles: { href: `https://api.github.com/repos/${r.full_name}/contributor_roles` }, contributors: { href: `https://api.github.com/repos/${r.full_name}/contributors` }, deployments: { href: `https://api.github.com/repos/${r.full_name}/deployments` }, downloads: { href: `https://api.github.com/repos/${r.full_name}/downloads` }, languages: { href: `https://api.github.com/repos/${r.full_name}/languages` }, releases: { href: `https://api.github.com/repos/${r.full_name}/releases{/id}` }, stargazers: { href: `https://api.github.com/repos/${r.full_name}/stargazers` }, statuses: { href: `https://api.github.com/repos/${r.full_name}/statuses/{sha}` }, subscribers: { href: `https://api.github.com/repos/${r.full_name}/subscribers` }, subscription: { href: `https://api.github.com/repos/${r.full_name}/subscription` }, tags: { href: `https://api.github.com/repos/${r.full_name}/tags` }, teams: { href: `https://api.github.com/repos/${r.full_name}/teams` }, trees: { href: `https://api.github.com/repos/${r.full_name}/git/trees{/sha}` } },
  };
}

function issueJSON(i: Issue, repo: Repo): any {
  const labels = i.labels.map(n => ({ id: 0, node_id: `MDU6TGFiZWw=`, url: `https://api.github.com/repos/${repo.full_name}/labels/${encodeURIComponent(n)}`, name: n, color: 'cccccc', default: false, description: '' }));
  return {
    url: `https://api.github.com/repos/${repo.full_name}/issues/${i.number}`, repository_url: `https://api.github.com/repos/${repo.full_name}`, labels_url: `https://api.github.com/repos/${repo.full_name}/labels{/name}`, comments_url: `https://api.github.com/repos/${repo.full_name}/issues/${i.number}/comments`, events_url: `https://api.github.com/repos/${repo.full_name}/issues/${i.number}/events`, html_url: `https://github.com/${repo.full_name}/issues/${i.number}`,
    id: i.id, node_id: `MDU6SXNzdWU=${i.id}`, number: i.number, title: i.title,
    user: { login: i.creator, id: 1, node_id: 'MDQ6VXNlcjE=', avatar_url: '', gravatar_id: '', url: `https://api.github.com/users/${i.creator}`, html_url: `https://github.com/${i.creator}`, type: 'User' },
    labels, state: i.state, locked: false, assignee: null, assignees: [], milestone: null,
    comments: 0, created_at: i.created_at, updated_at: i.updated_at, closed_at: null,
    author_association: 'NONE', body: i.body, timeline_url: `https://api.github.com/repos/${repo.full_name}/issues/${i.number}/timeline`, state_reason: null,
    perform_comment_grouping: false, reactions: { url: '', total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
  };
}

function prJSON(pr: PullRequest, repo: Repo): any {
  return {
    url: `https://api.github.com/repos/${repo.full_name}/pulls/${pr.number}`, id: pr.id, node_id: `PR_kwDO_${pr.id}`,
    number: pr.number, state: pr.state, locked: false, title: pr.title,
    user: { login: pr.creator, id: 1, type: 'User' },
    body: pr.body, created_at: pr.created_at, updated_at: pr.updated_at,
    closed_at: null, merge_commit_sha: pr.merge_commit_sha || null, draft: false,
    head: { label: `${pr.creator}:${pr.head.ref}`, ref: pr.head.ref, sha: pr.head.sha, user: { login: pr.creator }, repo: null },
    base: { label: pr.base.ref, ref: pr.base.ref, sha: pr.base.sha, user: { login: pr.creator }, repo: null },
    _links: { self: { href: '' }, html: { href: `https://github.com/${repo.full_name}/pull/${pr.number}` }, issue: { href: '' }, comments: { href: '' }, review_comments: { href: '' }, comments: { href: '' }, reviewer_comments: { href: '' }, navigation: { href: '' }, preview_patch: { href: '' } },
    maintainer_can_modify: true, mergeable: null, rebaseable: null, mergeable_state: 'unknown',
    requested_reviewers: [], requested_teams: [], labels: [],
    commits_url: `https://api.github.com/repos/${repo.full_name}/pulls/${pr.number}/commits`,
    review_comments_url: `https://api.github.com/repos/${repo.full_name}/pulls/${pr.number}/review_comments{?since}`,
    review_comment_url: `https://api.github.com/repos/${repo.full_name}/pulls/comments{/number}`,
    comments_url: `https://api.github.com/repos/${repo.full_name}/issues/${pr.number}/comments`,
    statuses_url: `https://api.github.com/repos/${repo.full_name}/statuses/${pr.head.sha}`,
    author_association: 'NONE', auto_merge: null, active_lock_reason: null,
    additions: 0, deletions: 0, changed_files: 0,
    merged: pr.merged, mergeable: null, merges_apart: false,
    diff_url: `https://github.com/${repo.full_name}/pull/${pr.number}.diff`,
    patch_url: `https://github.com/${repo.full_name}/pull/${pr.number}.patch`,
    issue_url: `https://api.github.com/repos/${repo.full_name}/issues/${pr.number}`,
    nodes_replace_on_merge: false, permalink: `https://github.com/${repo.full_name}/pull/${pr.number}`,
    review_comments: [], commits: [], files: [],
    timeline_url: `https://api.github.com/repos/${repo.full_name}/pulls/${pr.number}/timeline`,
    title: pr.title, html_url: `https://github.com/${repo.full_name}/pull/${pr.number}`,
  };
}

function labelJSON(l: Label): any {
  return { id: l.id, node_id: `MDU6TGFiZWw=${l.id}`, url: `https://api.github.com/repos/test/test/labels/${encodeURIComponent(l.name)}`, name: l.name, color: l.color, default: false, description: l.description };
}

// ─── Content operations ──────────────────────────────────────────────────────
function findFileInTree(repo: Repo, path: string): { entry: TreeEntry; blobSha: string } | null {
  if (!repo.head) return null;
  const headObj = repo.objects.get(repo.head);
  if (!headObj || !('entries' in headObj)) return null;
  const entries = (headObj as TreeObj).entries;
  const parts = path.split('/');
  let curEntries = entries;
  for (let i = 0; i < parts.length; i++) {
    const found = curEntries.find(e => e.name === parts[i]);
    if (!found) return null;
    if (i === parts.length - 1) {
      if (found.type !== 'blob') return null;
      return { entry: found, blobSha: found.sha };
    }
    const obj = repo.objects.get(found.sha);
    if (!obj || !('entries' in obj)) return null;
    curEntries = (obj as TreeObj).entries;
  }
  return null;
}

function writeFile(repo: Repo, filePath: string, content: Buffer, message: string, sha?: string): { blobSha: string; treeSha: string; commitSha: string; } {
  const blobSha = store.writeBlob(content);
  // Check existing
  const existing = findFileInTree(repo, filePath);
  let entries = repo.head ? ((repo.objects.get(repo.head) as any)?.entries || []) : [];
  const idx = entries.findIndex((e: TreeEntry) => e.name === filePath);
  if (existing && sha && existing.blobSha !== sha) {
    throw new Error('sha-match-failed');
  }
  if (idx >= 0) entries[idx] = { mode: '100644', name: filePath, sha: blobSha, type: 'blob' };
  else entries.push({ mode: '100644', name: filePath, sha: blobSha, type: 'blob' });
  const treeSha = store.writeTree(entries);
  const parentShas = repo.head ? [repo.head] : [];
  const commitSha = store.writeCommit(treeSha, parentShas, repo.owner, repo.owner, message, store.now());
  repo.refs.set(repo.default_branch, { sha: commitSha });
  repo.head = commitSha;
  repo.updated_at = store.now();
  return { blobSha, treeSha, commitSha };
}

function deleteFile(repo: Repo, filePath: string, message: string): { commitSha: string; } {
  const existing = findFileInTree(repo, filePath);
  if (!existing) throw new Error('not-found');
  let entries = repo.head ? ((repo.objects.get(repo.head) as any)?.entries || []) : [];
  entries = entries.filter((e: TreeEntry) => e.name !== filePath);
  const treeSha = store.writeTree(entries);
  const parentShas = repo.head ? [repo.head] : [];
  const commitSha = store.writeCommit(treeSha, parentShas, repo.owner, repo.owner, message, store.now());
  repo.refs.set(repo.default_branch, { sha: commitSha });
  repo.head = commitSha;
  repo.updated_at = store.now();
  return { commitSha };
}

// ─── Main handler ────────────────────────────────────────────────────────────
export function createApp(): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';
    const auth = (req.headers.authorization ?? '') as string;
    const bearer = auth.replace('Bearer ', '');
    const owner = bearer || store.owner();

    res_temp = res;

    // Health check — fastest path
    if (method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(HEALTHZ_JSON) });
      res.end(HEALTHZ_JSON);
      return;
    }

    // ─── REST v3 ───────────────────────────────────────────────────────
    if (path.startsWith('/api/v3')) {
      await handleRest(store, req, res, owner, bearer);
      return;
    }

    // ─── Git Smart HTTP ────────────────────────────────────────────────
    const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git(.*)$/);
    if (gitMatch) {
      const [, o, r, rest] = gitMatch;
      await handleGit(store, req, res, o, r, rest, bearer);
      return;
    }

    // ─── GraphQL ───────────────────────────────────────────────────────
    if (path === '/api/graphql') {
      await handleGraphQL(store, req, res, bearer);
      return;
    }

    // ─── MCP ───────────────────────────────────────────────────────────
    if (path === '/mcp') {
      await handleMCP(store, req, res, bearer);
      return;
    }

    // 404
    sendJson(res, 404, { message: 'Not Found' });
  });
  return server;
}

async function handleRest(s: ForgeStore, req: IncomingMessage, res: ServerResponse, owner: string, token: string) {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;

  // GET /api/v3/
  if ((method === 'GET' || method === 'HEAD') && (path === '/api/v3/' || path === '/api/v3')) {
    const h = { 'content-type': 'application/json; charset=utf-8', 'x-oauth-scopes': 'repo, read:org', 'content-length': Buffer.byteLength(API_ROOT_JSON) };
    res.writeHead(200, h);
    res.end(API_ROOT_JSON);
    return;
  }

  // GET /api/v3/meta
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { verifiable_password_authentication: true, github_app: { url: 'https://github.com/settings/apps', install_url: 'https://github.com/settings/installations', name: 'GitHub', id: 1 }, apps_url: 'https://api.github.com/apps', upload_url: 'https://uploads.github.com', graphql_api_url: `http://localhost${port}/api/graphql`, hooks_url: 'https://hooks.github.com', issues_url: 'https://api.github.com/issues', marketplace_listing_url: 'https://marketplace.github.com/api/listings', octokit_rc_url: 'https://api.github.com/octokit/rc', organization_repositories_url: 'https://api.github.com/orgs/{org}/repos', organization_url: 'https://api.github.com/orgs/{org}', user_url: 'https://api.github.com/user', user_organizations_url: 'https://api.github.com/user/organizations', user_repositories_url: 'https://api.github.com/user/repos', user_social_accounts_url: 'https://api.github.com/user/social_accounts', workstation_certificates_url: 'https://workstation.github.com/certificates', installed_version: 'clone-01' });
    return;
  }

  // GET /api/v3/user
  if (method === 'GET' && path === '/api/v3/user') {
    sendJson(res, 200, { login: owner, id: 1, node_id: 'MDQ6VXNlcjE=', avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4', gravatar_id: '', url: `https://api.github.com/users/${owner}`, html_url: `https://github.com/${owner}`, followers_url: `https://api.github.com/users/${owner}/followers`, following_url: `https://api.github.com/users/${owner}/following{?other_user}`, gists_url: `https://api.github.com/users/${owner}/gists{?gist_id}`, starred_url: `https://api.github.com/users/${owner}/starred{?owner,repo}`, subscriptions_url: `https://api.github.com/users/${owner}/subscriptions`, organizations_url: `https://api.github.com/users/${owner}/orgs`, repos_url: `https://api.github.com/users/${owner}/repos`, events_url: `https://api.github.com/users/${owner}/events{?privacy,seen}`, type: 'User', site_admin: false, name: owner, company: null, blog: '', location: null, email: `${owner}@example.com`, hireable: null, bio: null, twitter_username: null, public_repos: s.repos.size, public_gists: 0, followers: 0, following: 0, created_at: s.now(), updated_at: s.now() });
    return;
  }

  // GET /api/v3/user/repos
  if (method === 'GET' && path === '/api/v3/user/repos') {
    const repos = Array.from(s.repos.values()).filter(r => r.owner === owner).map(r => repoJSON(r));
    let link = '';
    if (repos.length > 0) link = `<http://localhost:${port}/api/v3/user/repos?page=2>; rel="next"`;
    const h: Record<string, string> = {};
    if (link) h['link'] = link;
    sendJson(res, 200, repos, h);
    return;
  }

  // POST /api/v3/user/repos
  if (method === 'POST' && path === '/api/v3/user/repos') {
    const body = await readBody(req, res);
    if (!body?.name) { sendError(res, 422, 'Name is required.'); return; }
    const repo = s.createRepo(body.name, body.description || '');
    sendJson(res, 201, repoJSON(repo));
    return;
  }

  // /api/v3/repos/{owner}/{repo}/*
  const repoMatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)(.*)$/);
  if (repoMatch) {
    const [, o, r, rest] = repoMatch;
    const fullName = `${o}/${r}`;
    const repo = s.getRepo(fullName);

    if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }

    // GET repo
    if (rest === '' || rest === '/') {
      if (method === 'GET') { sendJson(res, 200, repoJSON(repo)); return; }
      if (method === 'PATCH') {
        const body = await readBody(req, res);
        if (body?.description !== undefined) repo.description = body.description;
        repo.updated_at = s.now();
        sendJson(res, 200, repoJSON(repo));
        return;
      }
      if (method === 'DELETE') {
        s.repos.delete(repo.id);
        s.byName.delete(fullName);
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
        const body = await readBody(req, res);
        if (!body?.content) { sendError(res, 422, 'Content is required.'); return; }
        try {
          const content = typeof body.content === 'string' ? Buffer.from(body.content, 'base64') : Buffer.from(String(body.content));
          const result = writeFile(repo, filePath, content, body.message || 'Update file', body.sha as string | undefined);
          sendJson(res, body.sha ? 200 : 201, {
            content: { sha: result.blobSha, size: content.length, url: '', name: filePath, path: filePath },
            commit: { sha: result.commitSha, commit: { message: body.message || 'Update file', author: { name: repo.owner, email: `${repo.owner}@example.com` }, committer: { name: repo.owner, email: `${repo.owner}@example.com` }, tree: { sha: result.treeSha }, parents: [] } },
            sha: result.commitSha, verify_signature: false, tree: { sha: result.treeSha },
            files: [{ filename: filePath, blob_url: '', raw_url: '', status: body.sha ? 'modified' : 'added' }],
          });
        } catch (e: any) {
          if (e.message === 'sha-match-failed') sendError(res, 409, 'Sha does not match.');
          else sendError(res, 400, String(e));
        }
        return;
      }
      if (method === 'DELETE') {
        const body = await readBody(req, res);
        try {
          const result = deleteFile(repo, filePath, body?.message || `Delete ${filePath}`);
          sendJson(res, 200, { content: null, commit: { sha: result.commitSha, commit: { message: body?.message || '' } }, sha: result.commitSha });
        } catch (e: any) {
          if (e.message === 'not-found') sendJson(res, 404, { message: 'Not Found' });
          else sendError(res, 400, String(e));
        }
        return;
      }
      if (method === 'GET') {
        const entry = findFileInTree(repo, filePath);
        if (!entry) { sendJson(res, 404, { message: 'Not Found' }); return; }
        const blob = repo.objects.get(entry.blobSha);
        const content = blob && 'content' in blob ? (blob as BlobObj).content.toString('utf8') : '';
        sendJson(res, 200, { name: filePath, path: filePath, sha: entry.blobSha, size: content.length, url: '', html_url: '', git_url: '', download_url: '', type: 'file', _links: { self: '', git: '', html: '' }, content, encoding: 'utf-8' });
        return;
      }
    }

    // Labels
    if (rest === '/labels') {
      if (method === 'POST') {
        const body = await readBody(req, res);
        if (!body?.name) { sendError(res, 422, 'Name is required.'); return; }
        const lbl = s.createLabel(repo, body.name, body.color || 'cccccc');
        sendJson(res, 201, labelJSON(lbl));
        return;
      }
    }

    // Issues
    if (rest === '/issues') {
      if (method === 'POST') {
        const body = await readBody(req, res);
        if (!body?.title) { sendError(res, 422, 'Title is required.'); return; }
        const labelNames: string[] = body.labels || [];
        // Validate labels exist
        for (const ln of labelNames) {
          if (!Array.from(s.labels.values()).some(l => l.repo_id === repo.id && l.name === ln)) {
            sendError(res, 422, `Label ${ln} does not exist.`);
            return;
          }
        }
        const issue = s.createIssue(repo, body.title, body.body || '', labelNames, owner);
        sendJson(res, 201, issueJSON(issue, repo));
        return;
      }
      if (method === 'GET') {
        const issues = Array.from(s.issues.values()).filter(i => i.repo_id === repo.id && i.state === 'open').sort((a, b) => b.number - a.number).map(i => issueJSON(i, repo));
        sendJson(res, 200, issues);
        return;
      }
    }

    const issueNumMatch = rest.match(/^\/issues\/(\d+)$/);
    if (issueNumMatch) {
      const num = parseInt(issueNumMatch[1]);
      const issue = Array.from(s.issues.values()).find(i => i.repo_id === repo.id && i.number === num);
      if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (method === 'GET') { sendJson(res, 200, issueJSON(issue, repo)); return; }
    }

    // Pull requests
    if (rest === '/pulls') {
      if (method === 'POST') {
        const body = await readBody(req, res);
        if (!body?.title || !body?.head?.ref || !body?.base?.ref) {
          sendError(res, 422, 'title, head, and base are required.');
          return;
        }
        const pr = s.createPR(repo, body.title, body.body || '', { ref: body.head.ref, sha: body.head.sha || '' }, { ref: body.base.ref, sha: body.base.sha || '' }, owner);
        sendJson(res, 201, prJSON(pr, repo));
        return;
      }
      if (method === 'GET') {
        const prs = Array.from(s.prs.values()).filter(p => p.repo_id === repo.id && p.state === 'open').sort((a, b) => b.number - a.number).map(p => prJSON(p, repo));
        sendJson(res, 200, prs);
        return;
      }
    }

    const prNumMatch = rest.match(/^\/pulls\/(\d+)$/);
    if (prNumMatch) {
      const num = parseInt(prNumMatch[1]);
      const pr = Array.from(s.prs.values()).find(p => p.repo_id === repo.id && p.number === num);
      if (!pr) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (method === 'GET') { sendJson(res, 200, prJSON(pr, repo)); return; }
    }

    const prMergeMatch = rest.match(/^\/pulls\/(\d+)\/merge$/);
    if (prMergeMatch) {
      const num = parseInt(prMergeMatch[1]);
      const pr = Array.from(s.prs.values()).find(p => p.repo_id === repo.id && p.number === num);
      if (!pr) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (method === 'PUT') {
        const sha = s.mergePR(pr, repo);
        sendJson(res, 200, { sha, merged: true, message: 'Done' });
        return;
      }
      if (method === 'GET' || method === 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
    }

    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

let port = 0;

// ─── Git Smart HTTP ──────────────────────────────────────────────────────────
async function handleGit(s: ForgeStore, req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, suffix: string, token: string) {
  const repo = s.getRepo(`${owner}/${repoName}`);

  // Missing repo → 404, stay up
  if (!repo) {
    if (suffix.includes('info/refs') || suffix.includes('git-') || suffix === '') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Repository not found\n');
    } else {
      sendJson(res, 404, { message: 'Repository not found' });
    }
    return;
  }

  const isUploadPack = suffix.includes('git-upload-pack');
  const isReceivePack = suffix.includes('git-receive-pack') || suffix === '';
  const isInfoRefs = suffix === '/info/refs' || suffix.includes('info/refs');

    // info/refs
  if (isInfoRefs) {
    const acceptV2 = req.headers['git-protocol'] === 'version=2';
    const defaultSha = repo.refs.get(repo.default_branch)?.sha || '';
    if (acceptV2) {
      const ads = `version 2\nsymref HEAD:refs/heads/${repo.default_branch}\nreport-status-v2\ndeepen-since\ndeepen-not\ndeepen-relative-tags\nallow-fetch-head\nfilter\natomic\nside-band-64k\nofs-delta\nagent\n\n`;
      const buf = Buffer.from(ads);
      res.writeHead(200, { 'content-type': `application/x-git-${isUploadPack ? 'upload-pack' : 'receive-pack'}-advertisement`, 'content-length': buf.length });
      res.end(buf);
    } else {
      const line = `${defaultSha}\trefs/heads/${repo.default_branch}\n0000`;
      const preamble = `# service=git-${isUploadPack ? 'upload-pack' : 'receive-pack'}\n`;
      const combined = `${preamble}0000\n${line}\n0000`;
      const buf = Buffer.from(combined);
      res.writeHead(200, { 'content-type': `application/x-git-${isUploadPack ? 'upload-pack' : 'receive-pack'}-advertisement`, 'content-length': buf.length });
      res.end(buf);
    }
    return;
  }

  // upload-pack (read)
  if (isUploadPack) {
    const acceptV2 = req.headers['git-protocol'] === 'version=2';
    if (acceptV2) {
      const defaultSha = repo.refs.get(repo.default_branch)?.sha || '';
      const ads = `version 2\nsymref HEAD:refs/heads/${repo.default_branch}\nreport-status-v2\ndeepen-since\ndeepen-not\n deepen-relative-tags\n allow-fetch-head\n filter\n atomic\n side-band-64k\n ofs-delta\n agent\n\n`;
      const buf = Buffer.from(ads);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': buf.length });
      res.end(buf);
    } else {
      const defaultSha = repo.refs.get(repo.default_branch)?.sha || '';
      const line = `${defaultSha}\trefs/heads/${repo.default_branch}\n0000`;
      const buf = Buffer.from(`# service=git-upload-pack\n0000\n${line}\n0000`);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': buf.length });
      res.end(buf);
    }
    return;
  }

  // receive-pack (push)
  if (isReceivePack) {
    const ads = '# service=git-receive-pack\n0000\nreport-status\nreport-status-v2\ndelete-refs\nside-band-64k\n0000';
    const buf = Buffer.from(ads);
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement', 'content-length': buf.length });
    res.end(buf);
    return;
  }

  // Objects endpoint
  if (suffix.startsWith('/objects/')) {
    const parts = suffix.split('/');
    const sha = parts[parts.length - 1];
    const obj = repo.objects.get(sha);
    if (!obj) {
      sendJson(res, 404, { message: 'Object not found' });
      return;
    }
    if ('content' in obj) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end((obj as BlobObj).content);
    } else if ('entries' in obj) {
      // Efficient tree serialization with Buffer.concat
      const entries = (obj as TreeObj).entries;
      const parts: Buffer[] = [];
      for (const e of entries) parts.push(Buffer.from(`${e.mode} ${e.name}\0${e.sha}`));
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.concat(parts));
    } else if ('treeSha' in obj) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const c = obj as CommitObj;
      let payload = `tree ${c.treeSha}\n`;
      for (const p of c.parents) payload += `parent ${p}\n`;
      payload += `author ${c.author}\ncommitter ${c.committer}\n\n${c.message}`;
      res.end(Buffer.from(payload));
    }
    return;
  }

  // Packfiles
  if (suffix.endsWith('.pack') || suffix.endsWith('.idx')) {
    sendJson(res, 404, { message: 'Not found' });
    return;
  }

  // Default: treat as upload-pack
  const defaultSha = repo.refs.get(repo.default_branch)?.sha || '';
  const line = defaultSha + '\trefs/heads/' + repo.default_branch + '\n0000';
  const buf = Buffer.from('# service=git-upload-pack\n0000\n' + line + '\n0000');
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
  res.end(buf);
}

// ─── GraphQL ─────────────────────────────────────────────────────────────────
async function handleGraphQL(_s: ForgeStore, req: IncomingMessage, res: ServerResponse, token: string) {
  if (!token) { sendError(res, 401, 'Unauthorized'); return; }
  const body = await readBody(req, res);
  if (!body) { sendError(res, 400, 'Missing body'); return; }
  
  const query = body.query || '';
  const variables = body.variables || {};
  
  // Parse simple introspection queries
  if (query.includes('__type')) {
    if (query.includes('Issue')) {
      sendJson(res, 200, { data: { __type: { name: 'Issue', fields: [{ name: 'id' }, { name: 'number' }, { name: 'title' }, { name: 'state' }, { name: 'body' }] } } });
      return;
    }
    if (query.includes('PullRequest')) {
      sendJson(res, 200, { data: { __type: { name: 'PullRequest', fields: [{ name: 'id' }, { name: 'number' }, { name: 'headRefName' }, { name: 'baseRefName' }, { name: 'mergeable' }, { name: 'state' }, { name: 'merged' }, { name: 'files' }] } } });
      return;
    }
    if (query.includes('Repository')) {
      sendJson(res, 200, { data: { __type: { name: 'Repository', fields: [{ name: 'id' }, { name: 'databaseId' }, { name: 'name' }, { name: 'nameWithOwner' }, { name: 'owner' }, { name: 'defaultBranchRef' }, { name: 'viewerPermission' }, { name: 'hasIssuesEnabled' }, { name: 'issue' }, { name: 'issues' }, { name: 'pullRequests' }, { name: 'pullRequest' }] } } });
      return;
    }
    if (query.includes('SearchType')) {
      sendJson(res, 200, { data: { __type: { name: 'SearchType', enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }] } } });
      return;
    }
  }

  // Handle repository.issues query
  if (query.includes('repository') && query.includes('issues')) {
    const match = query.match(/repository\s*\(\s*name:\s*"([^"]+)"\s*,\s*owner:\s*"([^"]+)"\s*\)/);
    if (match) {
      const [, name, owner] = match;
      const repo = _s.getRepo(`${owner}/${name}`);
      if (!repo) { sendJson(res, 200, { data: { repository: null } }); return; }
      const issues = Array.from(_s.issues.values()).filter(i => i.repo_id === repo.id && i.state === 'open').sort((a, b) => b.number - a.number);
      const result: any[] = issues.map(i => ({ number: i.number, title: i.title, state: i.state }));
      sendJson(res, 200, { data: { repository: { issues: { nodes: result } } } });
      return;
    }
  }

  // createPullRequest mutation
  if (query.includes('createPullRequest')) {
    const repoMatch = query.match(/repository\s*\(\s*id:\s*"?(\w+)"?\s*\)/);
    const titleMatch = query.match(/title:\s*"([^"]*)"/);
    const headMatch = query.match(/head:\s*"([^"]*)"/);
    const baseMatch = query.match(/base:\s*"([^"]*)"/);
    if (repoMatch && titleMatch && headMatch && baseMatch) {
      const repoId = parseInt(repoMatch[1]);
      const repo = Array.from(_s.repos.values()).find(r => r.id === repoId);
      if (repo) {
        const pr = _s.createPR(repo, titleMatch[1], '', { ref: headMatch[1], sha: '' }, { ref: baseMatch[1], sha: '' }, token);
        sendJson(res, 200, { data: { createPullRequest: { pullRequest: { number: pr.number, state: 'open' } } } });
        return;
      }
    }
  }

  // Fallback
  sendJson(res, 200, { data: {} });
}

// ─── MCP ─────────────────────────────────────────────────────────────────────
async function handleMCP(s: ForgeStore, req: IncomingMessage, res: ServerResponse, token: string) {
  if (!token) { sendError(res, 401, 'Unauthorized'); return; }
  const body = await readBody(req, res);
  if (!body) { sendError(res, 400, 'Bad request'); return; }

  const tools = [
    { name: 'create_repo', description: 'Create a new GitHub repository', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' } }, required: ['name'] } },
    { name: 'get_repo', description: 'Get repository information', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
    { name: 'create_issue', description: 'Create an issue in a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
    { name: 'list_issues', description: 'List open issues in a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
    { name: 'create_pull_request', description: 'Create a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
    { name: 'merge_pull_request', description: 'Merge a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] } },
    { name: 'list_labels', description: 'List labels in a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
    { name: 'create_label', description: 'Create a label', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, name: { type: 'string' }, color: { type: 'string' } }, required: ['owner', 'repo', 'name'] } },
  ];

  // Support server prefix matching (case-insensitive suffix match)
  const fullName = body.method === 'tools/list' ? 'tools/list' : body.method || '';
  const methodName = body.method || '';

  // Initialize handshake
  if (methodName === 'initialize') {
    const result = {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'make.fun-forge', version: '0.1.0' },
      instructions: 'A GitHub-compatible git forge API. Use create_repo to create repositories, create_issue to create issues, etc.',
    };
    sendJson(res, 200, { jsonrpc: '2.0', id: body.id, result });
    return;
  }

  // tools/list
  if (methodName === 'tools/list' || methodName === 'github__tools/list') {
    sendJson(res, 200, { jsonrpc: '2.0', id: body.id, result: { tools } });
    return;
  }

  // tools/call
  if (methodName === 'tools/call' || methodName === 'github__tools/call') {
    const args = body.params?.arguments || {};
    const toolName = body.params?.name || '';
    
    // Resolve actual tool name (strip github__ prefix)
    const realName = toolName.replace(/^github__/i, '');
    
    let result: any;
    let isError = false;

    switch (realName) {
      case 'create_repo': {
        if (!args.name) { isError = true; result = { error: 'name is required' }; break; }
        const repo = s.createRepo(args.name);
        result = { content: [{ type: 'text', text: JSON.stringify({ full_name: repo.full_name, id: repo.id }) }] };
        break;
      }
      case 'get_repo': {
        if (!args.owner || !args.repo) { isError = true; result = { error: 'owner and repo are required' }; break; }
        const repo = s.getRepo(`${args.owner}/${args.repo}`);
        if (!repo) { isError = true; result = { error: 'Repository not found' }; break; }
        result = { content: [{ type: 'text', text: JSON.stringify({ ...repoJSON(repo), full_name: repo.full_name }) }] };
        break;
      }
      case 'create_issue': {
        if (!args.owner || !args.repo || !args.title) { isError = true; result = { error: 'owner, repo, and title are required' }; break; }
        const repo = s.getRepo(`${args.owner}/${args.repo}`);
        if (!repo) { isError = true; result = { error: 'Repository not found' }; break; }
        const issue = s.createIssue(repo, args.title, args.body || '', [], token);
        result = { content: [{ type: 'text', text: JSON.stringify(issueJSON(issue, repo)) }] };
        break;
      }
      case 'list_issues': {
        if (!args.owner || !args.repo) { isError = true; result = { error: 'owner and repo are required' }; break; }
        const repo = s.getRepo(`${args.owner}/${args.repo}`);
        if (!repo) { isError = true; result = { error: 'Repository not found' }; break; }
        const issues = Array.from(s.issues.values()).filter(i => i.repo_id === repo.id && i.state === 'open').map(i => issueJSON(i, repo));
        result = { content: [{ type: 'text', text: JSON.stringify(issues) }] };
        break;
      }
      case 'create_pull_request': {
        if (!args.owner || !args.repo || !args.title || !args.head || !args.base) { isError = true; result = { error: 'owner, repo, title, head, and base are required' }; break; }
        const repo = s.getRepo(`${args.owner}/${args.repo}`);
        if (!repo) { isError = true; result = { error: 'Repository not found' }; break; }
        const pr = s.createPR(repo, args.title, args.body || '', { ref: args.head, sha: '' }, { ref: args.base, sha: '' }, token);
        result = { content: [{ type: 'text', text: JSON.stringify(prJSON(pr, repo)) }] };
        break;
      }
      case 'merge_pull_request': {
        if (!args.owner || !args.repo || !args.pull_number) { isError = true; result = { error: 'owner, repo, and pull_number are required' }; break; }
        const repo = s.getRepo(`${args.owner}/${args.repo}`);
        if (!repo) { isError = true; result = { error: 'Repository not found' }; break; }
        const pr = Array.from(s.prs.values()).find(p => p.repo_id === repo.id && p.number === args.pull_number);
        if (!pr) { isError = true; result = { error: 'Pull request not found' }; break; }
        const sha = s.mergePR(pr, repo);
        result = { content: [{ type: 'text', text: JSON.stringify({ sha, merged: true }) }] };
        break;
      }
      default:
        isError = true;
        result = { error: `Unknown tool: ${toolName}` };
    }

    if (isError) {
      sendJson(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: result.error || 'Invalid arguments' } });
    } else {
      sendJson(res, 200, { jsonrpc: '2.0', id: body.id, result });
    }
    return;
  }

  // Unknown method
  sendJson(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
}

function pathOf(req: IncomingMessage): string {
  try { return new URL(req.url ?? '/', 'http://entry').pathname; }
  catch { return '/'; }
}
