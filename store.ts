// GitHub-compatible git forge — data model and store
// In-memory key-value store backed by deterministic serialization

import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

// ---- Types ----
export interface GitBlob { sha: string; content: Buffer; size: number; }
export interface GitTreeEntry { mode: string; name: string; sha: string; type: 'blob' | 'tree'; }
export interface GitTree { sha: string; entries: GitTreeEntry[]; }
export interface GitCommit {
  sha: string;
  treeSha: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  timestamp: string;
}
export interface GitRef { sha: string; }

export interface Repo {
  id: number;
  name: string;
  full_name: string;
  owner: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  ssh_url: string;
  clone_url: string;
  git_url: string;
  theme_url: string;
  // Internal
  objects: Map<string, GitBlob | GitTree | GitCommit>;
  refs: Map<string, GitRef>;  // branch -> {sha}
  head: string; // current HEAD sha
}

export interface IssueLabel {
  id: number;
  repo_id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  repo_id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: IssueLabel[];
  creator: string;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export interface PullRequest {
  id: number;
  number: number;
  repo_id: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  head: { ref: string; sha: string; repo?: string; };
  base: { ref: string; sha: string; };
  merged: boolean;
  merge_commit_sha?: string;
  creator: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  files?: PRFile[];
}

export interface PRFile {
  sha: string;
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface Comment {
  id: number;
  body: string;
  creator: string;
  created_at: string;
  updated_at: string;
}

// ---- Store ----
let nextId = 1;
const counter = () => nextId++;

export class ForgeStore {
  repos: Map<number, Repo> = new Map();
  reposByName: Map<string, Repo> = new Map(); // "owner/repo" -> Repo
  issues: Map<number, Issue> = new Map();
  prs: Map<number, PullRequest> = new Map();
  labels: Map<number, IssueLabel> = new Map();
  comments: Map<number, Comment> = new Map();
  nextIssueNumber: Map<number, number> = new Map();
  nextPrNumber: Map<number, number> = new Map();
  nextCommentId = 1;
  nextLabelId = 1;
  nextIssueId = 1;
  nextPrId = 1;
  gitCounter = 0; // monotonically increasing for deterministic SHA generation

  now(): string {
    return process.env.MAKEFUN_TRIAL_NOW || new Date().toISOString();
  }

  createRepo(owner: string, name: string, description = ''): Repo {
    const id = counter();
    const now = this.now();
    const repo: Repo = {
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
      theme_url: `https://github.com/${owner}/${name}`,
      objects: new Map(),
      refs: new Map(),
      head: '',
    };
    this.repos.set(id, repo);
    this.reposByName.set(repo.full_name, repo);
    this.nextIssueNumber.set(id, 1);
    this.nextPrNumber.set(id, 1);
    return repo;
  }

  getRepo(owner: string, repo: string): Repo | undefined {
    return this.reposByName.get(`${owner}/${repo}`);
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[], creator: string): Issue {
    const num = this.nextIssueNumber.get(repo.id)!;
    this.nextIssueNumber.set(repo.id, num + 1);
    const labelObjs: IssueLabel[] = [];
    for (const lname of labels) {
      let lbl = Array.from(this.labels.values()).find(l => l.repo_id === repo.id && l.name === lname);
      if (!lbl) {
        lbl = { id: counter(), repo_id: repo.id, name: lname, color: 'cccccc', description: '' };
        this.labels.set(lbl.id, lbl);
      }
      labelObjs.push(lbl);
    }
    const now = this.now();
    const issue: Issue = {
      id: counter(),
      number: num,
      repo_id: repo.id,
      title,
      body,
      state: 'open',
      labels: labelObjs,
      creator,
      created_at: now,
      updated_at: now,
      html_url: `https://github.com/${repo.full_name}/issues/${num}`,
    };
    this.issues.set(issue.id, issue);
    return issue;
  }

  createPullRequest(repo: Repo, title: string, body: string, head: { ref: string; sha: string }, base: { ref: string; sha: string }, creator: string): PullRequest {
    const num = this.nextPrNumber.get(repo.id)!;
    this.nextPrNumber.set(repo.id, num + 1);
    const now = this.now();
    const pr: PullRequest = {
      id: counter(),
      number: num,
      repo_id: repo.id,
      title,
      body,
      state: 'open',
      head,
      base,
      merged: false,
      creator,
      created_at: now,
      updated_at: now,
      html_url: `https://github.com/${repo.full_name}/pull/${num}`,
      files: [],
    };
    this.prs.set(pr.id, pr);
    return pr;
  }

  createLabel(repo: Repo, name: string, color = 'cccccc'): IssueLabel {
    const lbl: IssueLabel = { id: counter(), repo_id: repo.id, name, color, description: '' };
    this.labels.set(lbl.id, lbl);
    return lbl;
  }

  createComment(body: string, creator: string): Comment {
    const id = this.nextCommentId++;
    const comment: Comment = { id, body, creator, created_at: this.now(), updated_at: this.now() };
    this.comments.set(id, comment);
    return comment;
  }

  mergePullRequest(pr: PullRequest, repo: Repo): string {
    pr.merged = true;
    pr.state = 'closed';
    // Create a squash commit on the base branch
    const baseRef = pr.base.ref;
    const baseSha = repo.refs.get(baseRef)?.sha;
    if (!baseSha) throw new Error('Base ref not found');
    
    // Build a minimal tree for the merge commit
    const commitSha = this.makeDeterministicCommit(baseSha, pr.head.sha, repo);
    repo.refs.set(baseRef, { sha: commitSha });
    repo.head = commitSha;
    return commitSha;
  }

  makeDeterministicCommit(parentShas: string[], repo: Repo): string {
    // Create a simple squash commit
    const treeEntries: GitTreeEntry[] = [];
    // Collect all files from parent trees
    for (const ps of parentShas) {
      const obj = repo.objects.get(ps);
      if (obj && obj instanceof GitCommitObj) {
        const treeObj = repo.objects.get(obj.treeSha);
        if (treeObj && treeObj instanceof GitTreeObj) {
          for (const entry of treeObj.entries) {
            if (!treeEntries.find(e => e.name === entry.name)) {
              treeEntries.push(entry);
            }
          }
        }
      }
    }
    const treeSha = this.writeTree(repo, treeEntries);
    const now = this.now();
    const msg = `Merge pull request #${undefined} from ${repo.full_name}`;
    const commit = new GitCommitObj(treeSha, parentShas, 'forge-bot', 'forge-bot@example.com', msg, now);
    const sha = commit.sha;
    repo.objects.set(sha, commit);
    return sha;
  }

  // ---- Git object operations ----
  writeBlob(repo: Repo, content: Buffer): string {
    const sha = blobSha(content);
    repo.objects.set(sha, new GitBlobObj(sha, content));
    return sha;
  }

  writeTree(repo: Repo, entries: GitTreeEntry[]): string {
    // Sort entries by name for determinism
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    let data = '';
    for (const e of sorted) {
      data += `${e.mode} ${e.name}\0${e.sha}`;
    }
    const sha = treeSha(data);
    repo.objects.set(sha, new GitTreeObj(sha, sorted));
    return sha;
  }

  writeCommit(repo: Repo, treeSha: string, parents: string[], author: string, committer: string, message: string, timestamp: string): string {
    const commit = new GitCommitObj(treeSha, parents, author, committer, message, timestamp);
    repo.objects.set(commit.sha, commit);
    return commit.sha;
  }

  getGitObject(repo: Repo, sha: string): GitBlobObj | GitTreeObj | GitCommitObj | undefined {
    return repo.objects.get(sha) as any;
  }
}

// ---- Git object classes ----
class GitBlobObj {
  constructor(public sha: string, public content: Buffer) {}
  type = 'blob' as const;
  payload(): Buffer { return this.content; }
}

class GitTreeObj {
  constructor(public sha: string, public entries: GitTreeEntry[]) {}
  type = 'tree' as const;
  payload(): Buffer {
    let s = '';
    const sorted = [...this.entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const e of sorted) {
      s += `${e.mode} ${e.name}\0${e.sha}`;
    }
    return Buffer.from(s);
  }
}

class GitCommitObj {
  sha: string;
  constructor(public treeSha: string, public parents: string[], public author: string, public committer: string, public message: string, public timestamp: string) {
    this.sha = commitSha(treeSha, parents, author, committer, message, timestamp);
  }
  type = 'commit' as const;
  payload(): Buffer {
    let s = `tree ${this.treeSha}\n`;
    for (const p of this.parents) s += `parent ${p}\n`;
    s += `author ${this.author}\n`;
    s += `committer ${this.committer}\n`;
    s += `\n${this.message}`;
    return Buffer.from(s);
  }
}

// ---- Git SHA utilities ----
function blobSha(content: Buffer): string {
  return sha1('blob ' + content.length + '\0', content);
}

function treeSha(data: string): string {
  const buf = Buffer.from(data);
  return sha1('tree ' + buf.length + '\0', buf);
}

function commitSha(tree: string, parents: string[], author: string, committer: string, message: string, timestamp: string): string {
  let payload = `tree ${tree}\n`;
  for (const p of parents) payload += `parent ${p}\n`;
  payload += `author ${author}\n`;
  payload += `committer ${committer}\n\n${message}`;
  return sha1(payload);
}

function sha1(...buffers: (string | Buffer)[]): string {
  const h = createHash('sha1');
  for (const b of buffers) {
    if (typeof b === 'string') h.update(Buffer.from(b));
    else h.update(b);
  }
  return h.digest('hex');
}

export function parseGitPackHeader(buf: Buffer): { version: number; numObjects: number; } | null {
  if (buf.length < 12) return null;
  const sig = buf.toString('ascii', 0, 4);
  if (sig !== 'PACK') return null;
  const version = buf.readUInt32BE(4);
  const numObjects = buf.readUInt32BE(8);
  return { version, numObjects };
}

// Pack decoding stubs (minimal implementation)
export function decodePackVariable(buf: Buffer, offset: number): { value: number; consumed: number } {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i++];
    result |= (byte & 0x7F) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result, consumed: i - offset };
}
