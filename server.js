const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Agent } = require('@atproto/api');
const { NodeOAuthClient } = require('@atproto/oauth-client-node');
const { requestLocalLock } = require('@atproto/oauth-client');
const { buildAtprotoLoopbackClientMetadata } = require('@atproto/oauth-types');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const ORIGIN = `http://${HOST}:${PORT}`;
const LOCALHOST_ORIGIN = `http://localhost:${PORT}`;
const CALLBACK_PATH = '/oauth/callback';
const CALLBACK_URL = `${ORIGIN}${CALLBACK_PATH}`;
const BSKY_APPVIEW_AUD = 'did:web:api.bsky.app%23bsky_appview';
const OAUTH_SCOPE = [
  'atproto',
  'repo:app.bsky.graph.listitem?action=create',
  `rpc:app.bsky.feed.getPostThread?aud=${BSKY_APPVIEW_AUD}`,
  `rpc:app.bsky.feed.getQuotes?aud=${BSKY_APPVIEW_AUD}`,
  `rpc:app.bsky.feed.getLikes?aud=${BSKY_APPVIEW_AUD}`,
].join(' ');
const MAX_BATCH = 250;
const SOFT_WARN_BATCH = 100;
const CSRF_COOKIE = 'csrf_token';
const PUBLIC_API_ORIGIN = 'https://public.api.bsky.app';

let DATA_DIR = path.join(__dirname, 'data');
let SESSION_FILE = path.join(DATA_DIR, 'session.json');
let STATE_FILE = path.join(DATA_DIR, 'state.json');
let CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const INDEX_FILE = path.join(__dirname, 'index.html');
const APP_FILE = path.join(__dirname, 'app.js');
const CSS_FILE = path.join(__dirname, 'styles.css');
const ASSETS_DIR = path.join(__dirname, 'assets');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
}

function canWriteDir(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    const testFile = path.join(dirPath, '.write-test.tmp');
    fs.writeFileSync(testFile, 'ok', { encoding: 'utf8', mode: 0o600 });
    fs.unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
}

function canUseDataFiles(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    const files = ['session.json', 'state.json', 'config.json'];
    for (const name of files) {
      const filePath = path.join(dirPath, name);
      const exists = fs.existsSync(filePath);
      if (!exists) {
        fs.writeFileSync(filePath, '{}', { encoding: 'utf8', mode: 0o600 });
      }
      const current = fs.readFileSync(filePath, 'utf8');
      fs.writeFileSync(filePath, current || '{}', { encoding: 'utf8', mode: 0o600 });
    }
    return true;
  } catch {
    return false;
  }
}

function resolveDataPaths() {
  const preferred = path.join(__dirname, 'data');
  if (canWriteDir(preferred) && canUseDataFiles(preferred)) {
    DATA_DIR = preferred;
  } else {
    const fallback = path.join(os.homedir(), '.bsky-modlist-tool');
    if (!(canWriteDir(fallback) && canUseDataFiles(fallback))) {
      throw new Error('Unable to find a writable data directory for session/state storage.');
    }
    DATA_DIR = fallback;
    console.warn(`Project data directory is not writable. Using fallback: ${DATA_DIR}`);
  }

  SESSION_FILE = path.join(DATA_DIR, 'session.json');
  STATE_FILE = path.join(DATA_DIR, 'state.json');
  CONFIG_FILE = path.join(DATA_DIR, 'config.json');
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function randomCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

function ensureCsrfCookie(req, res) {
  const existing = String(req.cookies?.[CSRF_COOKIE] || '');
  if (/^[a-f0-9]{64}$/i.test(existing)) return existing;

  const token = randomCsrfToken();
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    sameSite: 'strict',
    secure: false,
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
  return token;
}

function isAllowedOrigin(req) {
  const allowed = new Set([ORIGIN, LOCALHOST_ORIGIN]);

  const origin = String(req.get('origin') || '').trim();
  if (origin) return allowed.has(origin);

  const referer = String(req.get('referer') || '').trim();
  if (!referer) return false;
  try {
    const parsed = new URL(referer);
    return allowed.has(parsed.origin);
  } catch {
    return false;
  }
}

class FileSessionStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  _read() {
    return readJsonSafe(this.filePath, {});
  }

  _write(data) {
    writeJson(this.filePath, data);
  }

  async set(sub, session) {
    const data = this._read();
    data[sub] = session;
    this._write(data);
  }

  async get(sub) {
    const data = this._read();
    return data[sub];
  }

  async del(sub) {
    const data = this._read();
    delete data[sub];
    this._write(data);
  }

  listSubs() {
    return Object.keys(this._read());
  }
}

class FileStateStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  _read() {
    return readJsonSafe(this.filePath, {});
  }

  _write(data) {
    writeJson(this.filePath, data);
  }

  async set(key, state) {
    const data = this._read();
    data[key] = state;
    this._write(data);
  }

  async get(key) {
    const data = this._read();
    return data[key];
  }

  async del(key) {
    const data = this._read();
    delete data[key];
    this._write(data);
  }
}

function parseListInput(value) {
  const input = String(value || '').trim();
  if (!input) return null;

  const atMatch = /^at:\/\/([^/]+)\/app\.bsky\.graph\.list\/([^/\s?#]+)$/i.exec(input);
  if (atMatch) {
    return { kind: 'at_uri', owner: atMatch[1], rkey: atMatch[2] };
  }

  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      if (url.hostname.toLowerCase() !== 'bsky.app') return null;
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 4 && parts[0] === 'profile' && (parts[2] === 'lists' || parts[2] === 'list')) {
        return {
          kind: 'bsky_url',
          owner: decodeURIComponent(parts[1]).trim(),
          rkey: decodeURIComponent(parts[3]).trim(),
        };
      }
    } catch {
      return null;
    }
  }

  return null;
}

function parsePostInput(value) {
  const input = String(value || '').trim();
  if (!input) return null;

  const atMatch = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/\s?#]+)$/i.exec(input);
  if (atMatch) return { actor: atMatch[1], rkey: atMatch[2] };

  if (!/^https?:\/\//i.test(input)) return null;
  try {
    const url = new URL(input);
    if (url.hostname.toLowerCase() !== 'bsky.app') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 4 && parts[0] === 'profile' && parts[2] === 'post') {
      return {
        actor: decodeURIComponent(parts[1]).trim(),
        rkey: decodeURIComponent(parts[3]).trim(),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeEntry(raw) {
  const input = String(raw || '');
  const trimmed = input.trim();
  if (!trimmed) return null;
  const trimmedNoAt = stripLeadingAt(trimmed);

  if (/^did:plc:[a-z0-9]{24}$/i.test(trimmed)) {
    return { normalized: trimmed.toLowerCase(), kind: 'did' };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.hostname.toLowerCase() === 'bsky.app') {
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length >= 2 && parts[0] === 'profile') {
          const id = decodeURIComponent(parts[1]).trim();
          const idNoAt = stripLeadingAt(id);
          if (/^did:plc:[a-z0-9]{24}$/i.test(id)) {
            return { normalized: id.toLowerCase(), kind: 'did' };
          }
          if (isLikelyHandle(idNoAt)) {
            return { normalized: idNoAt.toLowerCase(), kind: 'handle' };
          }
        }
      }
    } catch {
      return { error: 'invalid_input', message: 'Invalid URL format' };
    }
  }

  if (isLikelyHandle(trimmedNoAt)) {
    return { normalized: trimmedNoAt.toLowerCase(), kind: 'handle' };
  }

  return { error: 'invalid_input', message: 'Unsupported input format' };
}

function isLikelyHandle(value) {
  return /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value);
}

function stripLeadingAt(value) {
  const input = String(value || '').trim();
  return input.startsWith('@') ? input.slice(1) : input;
}

function summarizeResults(results, submittedCount, normalizedCount) {
  const summary = {
    submitted: submittedCount,
    normalized: normalizedCount,
    added: 0,
    alreadyPresent: 0,
    heldForReview: 0,
    invalid: 0,
    failed: 0,
  };

  for (const row of results) {
    if (row.status === 'added') summary.added += 1;
    else if (row.status === 'already_present') summary.alreadyPresent += 1;
    else if (row.status === 'relationship_review') summary.heldForReview += 1;
    else if (row.status === 'invalid_input') summary.invalid += 1;
    else summary.failed += 1;
  }

  return summary;
}

async function resolveDid(agent, entry) {
  if (entry.kind === 'did') return entry.normalized;
  const resolved = await agent.com.atproto.identity.resolveHandle({ handle: entry.normalized });
  return resolved.data.did;
}

async function resolveActorToDid(agent, actor) {
  const value = stripLeadingAt(String(actor || '').trim().toLowerCase());
  if (!value) throw new Error('List owner is missing.');
  if (/^did:plc:[a-z0-9]{24}$/i.test(value)) return value;
  if (!isLikelyHandle(value)) {
    throw new Error('List owner must be a DID or handle.');
  }
  const resolved = await agent.com.atproto.identity.resolveHandle({ handle: value });
  return resolved.data.did.toLowerCase();
}

async function normalizeListUriFromInput(agent, value) {
  const parsed = parseListInput(value);
  if (!parsed || !parsed.rkey) {
    throw new Error(
      'List must be either an AT URI (at://.../app.bsky.graph.list/...) or a Bluesky list URL (https://bsky.app/profile/.../lists/...).',
    );
  }

  const ownerDid = await resolveActorToDid(agent, parsed.owner);
  return {
    listUri: `at://${ownerDid}/app.bsky.graph.list/${parsed.rkey}`,
    ownerDid,
  };
}

async function resolveHandleViaPublicApi(handle) {
  const url = new URL('https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle');
  url.searchParams.set('handle', handle);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not resolve handle "${handle}"`);
  }
  const data = await response.json();
  if (!data?.did) throw new Error(`Could not resolve handle "${handle}"`);
  return String(data.did).toLowerCase();
}

async function normalizePostUriFromInputPublic(value) {
  const parsed = parsePostInput(value);
  if (!parsed?.actor || !parsed?.rkey) {
    throw new Error('Enter a Bluesky post URL such as https://bsky.app/profile/example.com/post/3abc...');
  }

  let actorDid = stripLeadingAt(parsed.actor).toLowerCase();
  if (!/^did:(?:plc|web):[^\s/]+$/i.test(actorDid)) {
    if (!isLikelyHandle(actorDid)) throw new Error('The post URL contains an invalid account handle.');
    actorDid = await resolveHandleViaPublicApi(actorDid);
  }
  if (!/^[a-zA-Z0-9._~:-]+$/.test(parsed.rkey)) throw new Error('The post URL contains an invalid post identifier.');
  return `at://${actorDid}/app.bsky.feed.post/${parsed.rkey}`;
}

async function fetchPublicXrpc(method, params) {
  const url = new URL(`/xrpc/${method}`, PUBLIC_API_ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url);
  if (!response.ok) {
    let message = '';
    try {
      const body = await response.json();
      message = body?.message || body?.error || '';
    } catch {
      message = await response.text();
    }
    throw new Error(message || `Bluesky request failed (${response.status}).`);
  }
  return response.json();
}

async function fetchRelationships(actorDid, otherDids) {
  const relationships = new Map();
  const uniqueDids = [...new Set(otherDids.map((did) => String(did || '').toLowerCase()).filter(Boolean))];

  for (let index = 0; index < uniqueDids.length; index += 30) {
    const data = await fetchPublicXrpc('app.bsky.graph.getRelationships', {
      actor: actorDid,
      others: uniqueDids.slice(index, index + 30),
    });
    for (const relationship of Array.isArray(data?.relationships) ? data.relationships : []) {
      const did = String(relationship?.did || '').toLowerCase();
      if (!did) continue;
      relationships.set(did, {
        following: Boolean(relationship?.following),
        followedBy: Boolean(relationship?.followedBy),
      });
    }
  }

  return relationships;
}

function relationshipLabel(relationship) {
  if (relationship?.following && relationship?.followedBy) return 'Mutual follows';
  if (relationship?.following) return 'Followed by you';
  if (relationship?.followedBy) return 'Follows you';
  return null;
}

async function fetchFeedXrpc(agent, method, params) {
  if (!agent) return fetchPublicXrpc(`app.bsky.feed.${method}`, params);
  const response = await agent.app.bsky.feed[method](params);
  return response.data;
}

function postUrlFromUri(uri, handle) {
  const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/i.exec(String(uri || ''));
  if (!match) return '';
  return `https://bsky.app/profile/${encodeURIComponent(handle || match[1])}/post/${encodeURIComponent(match[2])}`;
}

function serializePostMedia(embed) {
  if (!embed || typeof embed !== 'object') return [];
  const type = String(embed.$type || '');

  if (type === 'app.bsky.embed.recordWithMedia#view') {
    return serializePostMedia(embed.media);
  }

  if (type === 'app.bsky.embed.images#view') {
    const images = Array.isArray(embed.images) ? embed.images : [];
    if (!images.length) return [{ type: 'unavailable', label: 'Attached images are unavailable.' }];
    return images.map((image) => ({
      type: 'image',
      thumb: String(image?.thumb || ''),
      fullsize: String(image?.fullsize || ''),
      alt: String(image?.alt || ''),
      aspectRatio: image?.aspectRatio || null,
    }));
  }

  if (type === 'app.bsky.embed.video#view') {
    return [{
      type: 'video',
      playlist: String(embed.playlist || ''),
      thumbnail: String(embed.thumbnail || ''),
      alt: String(embed.alt || ''),
      aspectRatio: embed.aspectRatio || null,
    }];
  }

  if (type === 'app.bsky.embed.external#view') {
    const external = embed.external || {};
    return [{
      type: 'external',
      uri: String(external.uri || ''),
      title: String(external.title || ''),
      description: String(external.description || ''),
      thumb: String(external.thumb || ''),
    }];
  }

  // A plain record embed is the quoted post itself, not additional media.
  if (type === 'app.bsky.embed.record#view') return [];
  return [{ type: 'unavailable', label: 'Attached media cannot be displayed here.' }];
}

function serializePost(post, kind) {
  const author = post?.author || {};
  const record = post?.record || {};
  return {
    uri: String(post?.uri || ''),
    cid: String(post?.cid || ''),
    kind,
    text: typeof record?.text === 'string' ? record.text : '',
    createdAt: record?.createdAt || null,
    likeCount: Number(post?.likeCount || 0),
    replyCount: Number(post?.replyCount || 0),
    media: serializePostMedia(post?.embed),
    url: postUrlFromUri(post?.uri, author?.handle),
    author: {
      did: String(author?.did || ''),
      handle: String(author?.handle || ''),
      displayName: String(author?.displayName || ''),
      avatar: String(author?.avatar || ''),
    },
  };
}

function collectDirectReplyPosts(thread, output, seen) {
  for (const reply of Array.isArray(thread?.replies) ? thread.replies : []) {
    const post = reply?.post;
    if (post?.uri && !seen.has(post.uri)) {
      seen.add(post.uri);
      output.push(serializePost(post, 'reply'));
    }
  }
}

function feedReadErrorMessage(error, fallback) {
  const message = String(error?.message || fallback);
  if (/scope|permission/i.test(message)) {
    return 'The current sign-in predates the new Bluesky read permissions. Sign out and sign in again, then retry.';
  }
  return message;
}

async function normalizeListUriFromInputPublic(value) {
  const parsed = parseListInput(value);
  if (!parsed || !parsed.rkey) {
    throw new Error(
      'List must be either an AT URI (at://.../app.bsky.graph.list/...) or a Bluesky list URL (https://bsky.app/profile/.../lists/...).',
    );
  }

  let ownerDid = String(parsed.owner || '').trim().toLowerCase();
  if (!/^did:plc:[a-z0-9]{24}$/i.test(ownerDid)) {
    if (!isLikelyHandle(ownerDid)) throw new Error('List owner must be a DID or handle.');
    ownerDid = await resolveHandleViaPublicApi(ownerDid);
  }

  return `at://${ownerDid}/app.bsky.graph.list/${parsed.rkey}`;
}

async function fetchAllExistingMembers(agent, listUri) {
  const existing = new Set();
  const ownerMatch = /^at:\/\/([^/]+)\/app\.bsky\.graph\.list\/[^/\s?#]+$/i.exec(String(listUri || ''));
  if (!ownerMatch) {
    throw new Error('Invalid list URI.');
  }
  const ownerDid = ownerMatch[1];
  let cursor;

  do {
    const res = await agent.com.atproto.repo.listRecords({
      repo: ownerDid,
      collection: 'app.bsky.graph.listitem',
      limit: 100,
      cursor,
    });

    const data = res?.data || {};
    const records = Array.isArray(data?.records) ? data.records : [];
    for (const item of records) {
      const record = item?.value || item?.record || {};
      if (String(record?.list || '').toLowerCase() !== String(listUri).toLowerCase()) continue;
      const subjectDid = String(record?.subject || '').toLowerCase();
      if (subjectDid) existing.add(subjectDid);
    }

    cursor = data?.cursor;
  } while (cursor);

  return existing;
}

function normalizeLines(entries) {
  const parsed = [];
  const results = [];
  const dedupeSet = new Set();

  for (const raw of entries) {
    const line = String(raw || '');
    const normalized = normalizeEntry(line);

    if (!normalized) continue;

    if (normalized.error) {
      results.push({
        input: line,
        normalized: null,
        did: null,
        status: normalized.error,
        message: normalized.message,
      });
      continue;
    }

    if (dedupeSet.has(normalized.normalized)) {
      results.push({
        input: line,
        normalized: normalized.normalized,
        did: normalized.kind === 'did' ? normalized.normalized : null,
        status: 'already_present',
        message: 'Duplicate in submitted batch',
      });
      continue;
    }

    dedupeSet.add(normalized.normalized);
    parsed.push({ input: line, ...normalized });
  }

  return { parsed, preResults: results };
}

resolveDataPaths();
ensureDataDir();
if (!fs.existsSync(CONFIG_FILE)) {
  writeJson(CONFIG_FILE, { lastListUri: '' });
}

const sessionStore = new FileSessionStore(SESSION_FILE);
const stateStore = new FileStateStore(STATE_FILE);

const oauthClient = new NodeOAuthClient({
  clientMetadata: {
    ...buildAtprotoLoopbackClientMetadata({
      redirect_uris: [CALLBACK_URL],
      scope: OAUTH_SCOPE,
    }),
    client_name: 'Bluesky Modlist Local Tool',
  },
  stateStore,
  sessionStore,
  requestLock: requestLocalLock,
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.get('/', (_req, res) => res.sendFile(INDEX_FILE));
app.get('/app.js', (_req, res) => res.sendFile(APP_FILE));
app.get('/styles.css', (_req, res) => res.sendFile(CSS_FILE));
app.use('/assets', express.static(ASSETS_DIR, { index: false, fallthrough: false }));

app.use('/api', (req, res, next) => {
  ensureCsrfCookie(req, res);

  if (req.method !== 'POST') return next();

  if (!isAllowedOrigin(req)) {
    return res.status(403).json({ error: 'Blocked by origin policy.' });
  }

  const cookieToken = String(req.cookies?.[CSRF_COOKIE] || '');
  const headerToken = String(req.get('x-csrf-token') || '');
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'CSRF validation failed.' });
  }

  return next();
});

async function getActiveSession(req, res) {
  const fromCookie = req.cookies.bsky_did;
  if (fromCookie) {
    try {
      const session = await oauthClient.restore(fromCookie);
      return session;
    } catch {
      res.clearCookie('bsky_did');
    }
  }

  const subs = sessionStore.listSubs();
  if (subs.length === 0) return null;

  try {
    const session = await oauthClient.restore(subs[0]);
    res.cookie('bsky_did', session.did, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 30,
    });
    return session;
  } catch {
    return null;
  }
}

app.get('/api/session', async (req, res) => {
  try {
    const csrfToken = ensureCsrfCookie(req, res);
    const config = readJsonSafe(CONFIG_FILE, { lastListUri: '' });
    const session = await getActiveSession(req, res);

    if (!session) {
      return res.json({
        signedIn: false,
        did: null,
        handle: null,
        lastListUri: config.lastListUri || '',
        csrfToken,
      });
    }

    const agent = new Agent(session);
    const me = await agent.com.atproto.server.getSession();

    return res.json({
      signedIn: true,
      did: session.did,
      handle: me?.data?.handle || null,
      lastListUri: config.lastListUri || '',
      csrfToken,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Unable to read session status' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const handle = stripLeadingAt(String(req.body?.handle || '').trim().toLowerCase());
    if (!handle || !isLikelyHandle(handle)) {
      return res.status(400).json({ error: 'A valid handle is required to sign in (example: user.bsky.social).' });
    }

    const url = await oauthClient.authorize(handle, { scope: OAUTH_SCOPE });
    return res.json({ url: String(url) });
  } catch (error) {
    return res.status(500).json({ error: `Failed to start OAuth flow: ${error.message || 'unknown error'}` });
  }
});

app.get(CALLBACK_PATH, async (req, res) => {
  try {
    const authError = String(req.query?.error || '');
    if (authError) {
      const authErrorDescription = String(req.query?.error_description || 'No error description provided.');
      return res
        .status(400)
        .send(`OAuth authorization failed: ${authError}. ${authErrorDescription}`);
    }

    const params = new URLSearchParams(req.url.split('?')[1] || '');
    const callbackResult = await oauthClient.callback(params);
    const session = callbackResult?.session;

    if (!session?.did) {
      return res.status(400).send('OAuth callback did not return a session DID.');
    }

    res.cookie('bsky_did', session.did, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 30,
    });

    return res.redirect('/');
  } catch (error) {
    return res.status(500).send(`OAuth callback failed: ${error.message || 'unknown error'}`);
  }
});

app.post('/api/logout', async (req, res) => {
  try {
    const did = req.cookies.bsky_did;
    if (did) {
      await sessionStore.del(did);
      res.clearCookie('bsky_did');
    }
    const allSubs = sessionStore.listSubs();
    for (const sub of allSubs) {
      await sessionStore.del(sub);
    }
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to sign out' });
  }
});

app.post('/api/add-to-list', async (req, res) => {
  const listUriInput = req.body?.listUri;
  const entriesInput = Array.isArray(req.body?.entries) ? req.body.entries : [];
  const skipDuplicates = req.body?.skipDuplicates !== false;
  const bypassRelationshipCheck = req.body?.bypassRelationshipCheck === true;

  if (entriesInput.length > MAX_BATCH) {
    return res.status(400).json({ error: `Batch size exceeds hard cap (${MAX_BATCH}).` });
  }

  let session;
  try {
    session = await getActiveSession(req, res);
  } catch {
    return res.status(401).json({ error: 'Not signed in.' });
  }

  if (!session) {
    return res.status(401).json({ error: 'Not signed in.' });
  }

  const agent = new Agent(session);

  let targetList;
  try {
    targetList = await normalizeListUriFromInput(agent, listUriInput);
  } catch (error) {
    return res.status(400).json({ error: String(error?.message || 'Invalid list input.') });
  }

  if (targetList.ownerDid !== session.did) {
    return res.status(400).json({ error: 'Target list URI does not belong to the currently signed-in DID.' });
  }

  const config = readJsonSafe(CONFIG_FILE, { lastListUri: '' });
  config.lastListUri = targetList.listUri;
  writeJson(CONFIG_FILE, config);

  const { parsed, preResults } = normalizeLines(entriesInput);

  const results = [...preResults];
  const warnings = [];
  if (entriesInput.length > SOFT_WARN_BATCH) {
    warnings.push(`Large batch: ${entriesInput.length} entries submitted.`);
  }

  let existingDids;
  try {
    existingDids = await fetchAllExistingMembers(agent, targetList.listUri);
  } catch (error) {
    return res.status(400).json({ error: `Unable to fetch list members: ${String(error?.message || 'unknown error')}` });
  }

  const resolvedEntries = [];
  const resolvedDids = new Set();
  for (const entry of parsed) {
    let did = null;
    try {
      did = (await resolveDid(agent, entry)).toLowerCase();

      if (skipDuplicates && existingDids.has(did)) {
        results.push({
          input: entry.input,
          normalized: entry.normalized,
          did,
          status: 'already_present',
          message: 'Already on list',
        });
        continue;
      }

      if (resolvedDids.has(did)) {
        results.push({
          input: entry.input,
          normalized: entry.normalized,
          did,
          status: 'already_present',
          message: 'Duplicate account in submitted batch',
        });
        continue;
      }

      resolvedDids.add(did);
      resolvedEntries.push({ entry, did });
    } catch (error) {
      results.push({
        input: entry.input,
        normalized: entry.normalized,
        did: entry.kind === 'did' ? entry.normalized : null,
        status: entry.kind === 'handle' ? 'resolve_failed' : 'write_failed',
        message: String(error?.message || 'Unable to resolve account'),
      });
    }
  }

  let relationships = new Map();
  if (!bypassRelationshipCheck && resolvedEntries.length) {
    try {
      relationships = await fetchRelationships(session.did, resolvedEntries.map(({ did }) => did));
    } catch (error) {
      return res.status(400).json({
        error: `Unable to check follow relationships: ${String(error?.message || 'unknown error')}`,
      });
    }
  }

  const relationshipReview = [];
  for (const { entry, did } of resolvedEntries) {
    const relationship = relationships.get(did);
    const relationshipStatus = relationshipLabel(relationship);
    if (relationshipStatus) {
      relationshipReview.push({
        input: entry.input,
        normalized: entry.normalized,
        did,
        relationship: relationshipStatus,
      });
      results.push({
        input: entry.input,
        normalized: entry.normalized,
        did,
        status: 'relationship_review',
        message: relationshipStatus,
      });
      continue;
    }

    try {
      await agent.com.atproto.repo.createRecord({
        repo: session.did,
        collection: 'app.bsky.graph.listitem',
        record: {
          subject: did,
          list: targetList.listUri,
          createdAt: new Date().toISOString(),
        },
      });

      existingDids.add(did);
      results.push({
        input: entry.input,
        normalized: entry.normalized,
        did,
        status: 'added',
        message: 'Added to list',
      });
    } catch (error) {
      const rawMessage = String(error?.message || 'Unknown error');
      const message = /Missing required scope/i.test(rawMessage)
        ? 'Missing OAuth scope for this operation. Sign out and sign in again, then retry.'
        : rawMessage;
      results.push({
        input: entry.input,
        normalized: entry.normalized,
        did,
        status: 'write_failed',
        message,
      });
    }
  }

  const response = {
    summary: summarizeResults(results, entriesInput.length, parsed.length),
    warnings,
    results,
    relationshipReview,
  };

  return res.json(response);
});

app.get('/api/list-preview', async (req, res) => {
  try {
    const listInput = String(req.query?.listInput || '').trim();
    if (!listInput) {
      return res.status(400).json({ error: 'List input is required.' });
    }

    const listUri = await normalizeListUriFromInputPublic(listInput);
    const previewUrl = new URL('https://public.api.bsky.app/xrpc/app.bsky.graph.getList');
    previewUrl.searchParams.set('list', listUri);
    previewUrl.searchParams.set('limit', '1');

    const response = await fetch(previewUrl);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Failed to load list (${response.status})`);
    }

    const data = await response.json();
    const list = data?.list || {};
    return res.json({
      listUri,
      name: list?.name || '(untitled list)',
      purpose: list?.purpose || null,
      avatar: list?.avatar || null,
      description: list?.description || '',
      ownerHandle: list?.creator?.handle || null,
      ownerDid: list?.creator?.did || null,
    });
  } catch (error) {
    return res.status(400).json({ error: String(error?.message || 'Failed to load list preview.') });
  }
});

app.get('/api/post-conversation', async (req, res) => {
  try {
    const postInput = String(req.query?.postUrl || '').trim();
    if (!postInput) return res.status(400).json({ error: 'A Bluesky post URL is required.' });

    const session = await getActiveSession(req, res);
    const agent = session ? new Agent(session) : null;
    const postUri = await normalizePostUriFromInputPublic(postInput);
    const threadData = await fetchFeedXrpc(agent, 'getPostThread', {
      uri: postUri,
      depth: 1,
      parentHeight: 0,
    });

    if (!threadData?.thread?.post) {
      return res.status(404).json({ error: 'That post is unavailable, deleted, or blocked from public view.' });
    }

    const posts = [];
    const seen = new Set([postUri]);
    const seenQuoteCursors = new Set();
    collectDirectReplyPosts(threadData.thread, posts, seen);

    let cursor;
    do {
      const quoteData = await fetchFeedXrpc(agent, 'getQuotes', {
        uri: postUri,
        limit: 100,
        cursor,
      });
      for (const post of Array.isArray(quoteData?.posts) ? quoteData.posts : []) {
        if (!post?.uri || seen.has(post.uri)) continue;
        seen.add(post.uri);
        posts.push(serializePost(post, 'quote'));
      }
      const nextCursor = quoteData?.cursor;
      cursor = nextCursor && !seenQuoteCursors.has(nextCursor) ? nextCursor : undefined;
      if (cursor) seenQuoteCursors.add(cursor);
    } while (cursor);

    return res.json({
      source: serializePost(threadData.thread.post, 'source'),
      posts,
      visibility: agent ? 'signed_in' : 'public',
      counts: {
        replies: posts.filter((post) => post.kind === 'reply').length,
        quotes: posts.filter((post) => post.kind === 'quote').length,
      },
    });
  } catch (error) {
    return res.status(400).json({ error: feedReadErrorMessage(error, 'Failed to gather direct replies and quotes.') });
  }
});

app.get('/api/post-likes', async (req, res) => {
  try {
    const uri = String(req.query?.uri || '').trim();
    if (!/^at:\/\/[^/]+\/app\.bsky\.feed\.post\/[^/\s?#]+$/i.test(uri)) {
      return res.status(400).json({ error: 'A valid Bluesky post URI is required.' });
    }

    const session = await getActiveSession(req, res);
    const agent = session ? new Agent(session) : null;
    const actors = [];
    const seen = new Set();
    const seenCursors = new Set();
    let cursor;
    do {
      const likesData = await fetchFeedXrpc(agent, 'getLikes', { uri, limit: 100, cursor });
      for (const like of Array.isArray(likesData?.likes) ? likesData.likes : []) {
        const actor = like?.actor || {};
        const key = String(actor?.did || actor?.handle || '').toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        actors.push({
          did: String(actor?.did || ''),
          handle: String(actor?.handle || ''),
          displayName: String(actor?.displayName || ''),
        });
      }
      const nextCursor = likesData?.cursor;
      cursor = nextCursor && !seenCursors.has(nextCursor) ? nextCursor : undefined;
      if (cursor) seenCursors.add(cursor);
    } while (cursor);

    return res.json({ actors, visibility: agent ? 'signed_in' : 'public' });
  } catch (error) {
    return res.status(400).json({ error: feedReadErrorMessage(error, 'Failed to gather likes.') });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Bluesky Modlist tool listening at ${ORIGIN}`);
});
