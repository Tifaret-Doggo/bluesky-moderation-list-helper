const sessionStatus = document.getElementById('sessionStatus');
const handleInput = document.getElementById('handleInput');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const listUriInput = document.getElementById('listUriInput');
const entriesInput = document.getElementById('entriesInput');
const skipDuplicatesInput = document.getElementById('skipDuplicatesInput');
const submitBtn = document.getElementById('submitBtn');
const summaryBox = document.getElementById('summaryBox');
const warningsBox = document.getElementById('warningsBox');
const resultsTableBody = document.querySelector('#resultsTable tbody');
const listPreviewName = document.getElementById('listPreviewName');
const listPreviewMeta = document.getElementById('listPreviewMeta');
const listPreviewAvatar = document.getElementById('listPreviewAvatar');
const postUrlInput = document.getElementById('postUrlInput');
const loadConversationBtn = document.getElementById('loadConversationBtn');
const conversationStatus = document.getElementById('conversationStatus');
const sourcePostContext = document.getElementById('sourcePostContext');
const sourceAuthorAvatar = document.getElementById('sourceAuthorAvatar');
const sourceAuthorName = document.getElementById('sourceAuthorName');
const sourceAuthorHandle = document.getElementById('sourceAuthorHandle');
const sourcePostText = document.getElementById('sourcePostText');
const sourcePostMedia = document.getElementById('sourcePostMedia');
const sourcePostLink = document.getElementById('sourcePostLink');
const addSourceAuthorBtn = document.getElementById('addSourceAuthorBtn');
const addSourceLikersBtn = document.getElementById('addSourceLikersBtn');
const sourceActionStatus = document.getElementById('sourceActionStatus');
const postReview = document.getElementById('postReview');
const previousPostBtn = document.getElementById('previousPostBtn');
const nextPostBtn = document.getElementById('nextPostBtn');
const postProgress = document.getElementById('postProgress');
const postAuthorAvatar = document.getElementById('postAuthorAvatar');
const postAuthorName = document.getElementById('postAuthorName');
const postAuthorHandle = document.getElementById('postAuthorHandle');
const postKind = document.getElementById('postKind');
const postText = document.getElementById('postText');
const postMedia = document.getElementById('postMedia');
const postLink = document.getElementById('postLink');
const addPostAuthorBtn = document.getElementById('addPostAuthorBtn');
const addPostLikersBtn = document.getElementById('addPostLikersBtn');
const postActionStatus = document.getElementById('postActionStatus');
let csrfToken = '';
const LS_HANDLE_KEY = 'bsky_modlist.handle';
const LS_LIST_KEY = 'bsky_modlist.list_uri';
let previewTimer = null;
let conversationPosts = [];
let conversationSource = null;
let currentPostIndex = 0;
let conversationLoading = false;
const authorActionsCompleted = new Set();
const likerActionsCompleted = new Set();

function setBusy(flag) {
  loginBtn.disabled = flag;
  logoutBtn.disabled = flag;
  submitBtn.disabled = flag;
  loadConversationBtn.disabled = flag || conversationLoading;
}

function actorKeys(actor) {
  const keys = [];
  const did = String(actor?.did || '').trim().toLowerCase();
  const handle = String(actor?.handle || '').trim().replace(/^@/, '').toLowerCase();
  if (did) keys.push(did);
  if (handle) keys.push(handle);
  return keys;
}

function inputKeys(line) {
  const value = String(line || '').trim().toLowerCase();
  if (!value) return [];
  const keys = [value.replace(/^@/, '')];
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.hostname === 'bsky.app' && parts[0] === 'profile' && parts[1]) {
      keys.push(decodeURIComponent(parts[1]).replace(/^@/, '').toLowerCase());
    }
  } catch {
    // Plain handles and DIDs are expected to fail URL parsing.
  }
  return keys;
}

function addActorsToBatch(actors) {
  const lines = entriesInput.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const existing = new Set(lines.flatMap(inputKeys));
  let added = 0;
  let skipped = 0;

  for (const actor of actors) {
    const keys = actorKeys(actor);
    if (!keys.length || keys.some((key) => existing.has(key))) {
      skipped += 1;
      continue;
    }
    const entry = String(actor?.handle || actor?.did || '').trim().replace(/^@/, '');
    if (!entry) {
      skipped += 1;
      continue;
    }
    lines.push(entry);
    keys.forEach((key) => existing.add(key));
    added += 1;
  }

  entriesInput.value = lines.join('\n');
  return { added, skipped };
}

function currentConversationPost() {
  return conversationPosts[currentPostIndex] || null;
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

function renderPostMedia(container, media, fallbackPostUrl) {
  container.replaceChildren();
  const items = Array.isArray(media) ? media : [];

  for (const item of items) {
    if (item?.type === 'image') {
      const imageUrl = safeHttpUrl(item.fullsize || item.thumb);
      if (!imageUrl) {
        const unavailable = document.createElement('div');
        unavailable.className = 'media-unavailable';
        unavailable.textContent = 'An attached image is unavailable.';
        container.appendChild(unavailable);
        continue;
      }
      const link = document.createElement('a');
      link.className = 'media-item media-image';
      link.href = imageUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const image = document.createElement('img');
      image.src = safeHttpUrl(item.thumb) || imageUrl;
      image.alt = item.alt || 'Attached image';
      image.loading = 'lazy';
      link.appendChild(image);
      container.appendChild(link);
      continue;
    }

    if (item?.type === 'video') {
      const wrapper = document.createElement('div');
      wrapper.className = 'media-item media-video';
      const playlist = safeHttpUrl(item.playlist);
      const thumbnail = safeHttpUrl(item.thumbnail);
      if (playlist) {
        const video = document.createElement('video');
        video.controls = true;
        video.preload = 'metadata';
        if (thumbnail) video.poster = thumbnail;
        video.setAttribute('aria-label', item.alt || 'Attached video');
        const source = document.createElement('source');
        source.src = playlist;
        source.type = 'application/vnd.apple.mpegurl';
        video.appendChild(source);
        wrapper.appendChild(video);
      } else if (thumbnail) {
        const image = document.createElement('img');
        image.src = thumbnail;
        image.alt = item.alt || 'Video preview';
        image.loading = 'lazy';
        wrapper.appendChild(image);
      }
      const note = document.createElement('div');
      note.className = 'media-video-note';
      const postUrl = safeHttpUrl(fallbackPostUrl);
      if (postUrl) {
        const link = document.createElement('a');
        link.href = postUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = playlist ? 'Video attached — open on Bluesky if it does not play here.' : 'Video attached — open on Bluesky to play.';
        note.appendChild(link);
      } else {
        note.textContent = 'A video is attached but cannot be played here.';
      }
      wrapper.appendChild(note);
      container.appendChild(wrapper);
      continue;
    }

    if (item?.type === 'external') {
      const externalUrl = safeHttpUrl(item.uri);
      if (!externalUrl) continue;
      const link = document.createElement('a');
      link.className = 'media-item external-card';
      link.href = externalUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const thumb = safeHttpUrl(item.thumb);
      if (thumb) {
        const image = document.createElement('img');
        image.src = thumb;
        image.alt = '';
        image.loading = 'lazy';
        link.appendChild(image);
      }
      const text = document.createElement('div');
      text.className = 'external-card-text';
      const title = document.createElement('div');
      title.className = 'external-card-title';
      title.textContent = item.title || externalUrl;
      text.appendChild(title);
      if (item.description) {
        const description = document.createElement('div');
        description.className = 'external-card-description';
        description.textContent = item.description;
        text.appendChild(description);
      }
      link.appendChild(text);
      container.appendChild(link);
      continue;
    }

    const unavailable = document.createElement('div');
    unavailable.className = 'media-unavailable';
    unavailable.textContent = item?.label || 'Attached media cannot be displayed here.';
    container.appendChild(unavailable);
  }
}

function renderSourcePost(post) {
  conversationSource = post || null;
  if (!post) {
    sourcePostContext.hidden = true;
    sourcePostMedia.replaceChildren();
    return;
  }

  sourcePostContext.hidden = false;
  sourceAuthorName.textContent = post.author?.displayName || post.author?.handle || 'Unknown account';
  sourceAuthorHandle.textContent = post.author?.handle ? `@${post.author.handle}` : post.author?.did || '';
  sourcePostText.textContent = post.text || '(This post has no text.)';
  renderPostMedia(sourcePostMedia, post.media, post.url);
  sourcePostLink.href = post.url || '#';
  sourcePostLink.hidden = !post.url;
  if (post.author?.avatar) {
    sourceAuthorAvatar.src = post.author.avatar;
    sourceAuthorAvatar.style.visibility = 'visible';
  } else {
    sourceAuthorAvatar.removeAttribute('src');
    sourceAuthorAvatar.style.visibility = 'hidden';
  }
  const authorDone = authorActionsCompleted.has(post.uri);
  const likersDone = likerActionsCompleted.has(post.uri);
  addSourceAuthorBtn.disabled = authorDone;
  addSourceAuthorBtn.textContent = authorDone ? 'Author added to batch' : 'Add post author to batch';
  addSourceLikersBtn.disabled = likersDone;
  addSourceLikersBtn.textContent = likersDone ? 'Likers added to batch' : 'Add everyone who liked this post';
  sourceActionStatus.textContent = '';
}

function renderConversationPost() {
  const post = currentConversationPost();
  if (!post) {
    postReview.hidden = true;
    return;
  }

  postReview.hidden = false;
  postProgress.textContent = `${currentPostIndex + 1} of ${conversationPosts.length}`;
  previousPostBtn.disabled = currentPostIndex === 0;
  nextPostBtn.disabled = currentPostIndex === conversationPosts.length - 1;
  postAuthorName.textContent = post.author?.displayName || post.author?.handle || 'Unknown account';
  postAuthorHandle.textContent = post.author?.handle ? `@${post.author.handle}` : post.author?.did || '';
  postKind.textContent = post.kind === 'quote' ? 'Quote post' : 'Reply';
  postText.textContent = post.text || '(This post has no text.)';
  renderPostMedia(postMedia, post.media, post.url);
  postLink.href = post.url || '#';
  postLink.hidden = !post.url;
  if (post.author?.avatar) {
    postAuthorAvatar.src = post.author.avatar;
    postAuthorAvatar.style.visibility = 'visible';
  } else {
    postAuthorAvatar.removeAttribute('src');
    postAuthorAvatar.style.visibility = 'hidden';
  }

  const authorDone = authorActionsCompleted.has(post.uri);
  const likersDone = likerActionsCompleted.has(post.uri);
  addPostAuthorBtn.disabled = authorDone;
  addPostAuthorBtn.textContent = authorDone ? 'Author added to batch' : 'Add post author to batch';
  addPostLikersBtn.disabled = likersDone;
  addPostLikersBtn.textContent = likersDone ? 'Likers added to batch' : 'Add everyone who liked this post';
  postActionStatus.textContent = '';
}

async function addLikersForPost(post, button, statusElement, isStillCurrent) {
  if (!post) return;
  button.disabled = true;
  button.textContent = 'Gathering likers...';
  statusElement.textContent = 'Gathering everyone who liked this post...';
  try {
    const res = await fetch(`/api/post-likes?uri=${encodeURIComponent(post.uri)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to gather likers.');
    const result = addActorsToBatch(Array.isArray(data.actors) ? data.actors : []);
    likerActionsCompleted.add(post.uri);
    if (isStillCurrent()) {
      button.textContent = 'Likers added to batch';
      statusElement.textContent = `Added ${result.added} ${result.added === 1 ? 'account' : 'accounts'} to the batch` +
        (result.skipped ? `; ${result.skipped} already present or unavailable.` : '.');
    }
  } catch (error) {
    if (isStillCurrent()) {
      button.disabled = false;
      button.textContent = 'Add everyone who liked this post';
      statusElement.textContent = error.message;
    }
  }
}

async function loadConversation() {
  if (conversationLoading) return;
  const postUrl = postUrlInput.value.trim();
  if (!postUrl) {
    conversationPosts = [];
    renderSourcePost(null);
    postReview.hidden = true;
    conversationStatus.textContent = 'No post loaded.';
    return;
  }

  conversationLoading = true;
  loadConversationBtn.disabled = true;
  conversationStatus.textContent = 'Gathering direct replies and quote posts...';
  renderSourcePost(null);
  postReview.hidden = true;
  try {
    const res = await fetch(`/api/post-conversation?postUrl=${encodeURIComponent(postUrl)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to gather the conversation.');
    conversationPosts = Array.isArray(data.posts) ? data.posts : [];
    currentPostIndex = 0;
    authorActionsCompleted.clear();
    likerActionsCompleted.clear();
    renderSourcePost(data.source);
    const replies = Number(data.counts?.replies || 0);
    const quotes = Number(data.counts?.quotes || 0);
    const visibility = data.visibility === 'signed_in'
      ? 'using the signed-in account’s visibility'
      : 'using public visibility';
    conversationStatus.textContent = conversationPosts.length
      ? `Gathered ${replies} direct ${replies === 1 ? 'reply' : 'replies'} and ${quotes} quote ${quotes === 1 ? 'post' : 'posts'}, ${visibility}.`
      : `No direct replies or quote posts were found ${visibility}.`;
    renderConversationPost();
  } catch (error) {
    conversationPosts = [];
    renderSourcePost(null);
    postReview.hidden = true;
    conversationStatus.textContent = error.message;
  } finally {
    conversationLoading = false;
    loadConversationBtn.disabled = false;
  }
}

function renderResults(payload) {
  if (!payload) {
    summaryBox.textContent = 'No run yet.';
    warningsBox.textContent = '';
    resultsTableBody.innerHTML = '';
    return;
  }

  const s = payload.summary;
  summaryBox.textContent = [
    `Submitted: ${s.submitted}`,
    `Normalized: ${s.normalized}`,
    `Added: ${s.added}`,
    `Already present: ${s.alreadyPresent}`,
    `Invalid: ${s.invalid}`,
    `Failed: ${s.failed}`,
  ].join('\n');

  warningsBox.textContent = (payload.warnings || []).join(' | ');
  resultsTableBody.innerHTML = '';

  for (const row of payload.results || []) {
    const tr = document.createElement('tr');

    const tdInput = document.createElement('td');
    tdInput.textContent = row.input || '';

    const tdNorm = document.createElement('td');
    tdNorm.textContent = row.normalized || '';

    const tdDid = document.createElement('td');
    tdDid.textContent = row.did || '';

    const tdStatus = document.createElement('td');
    tdStatus.textContent = row.status || '';
    tdStatus.className = `status-${row.status || ''}`;

    const tdMessage = document.createElement('td');
    tdMessage.textContent = row.message || '';

    tr.append(tdInput, tdNorm, tdDid, tdStatus, tdMessage);
    resultsTableBody.appendChild(tr);
  }
}

async function readSession() {
  const res = await fetch('/api/session');
  if (!res.ok) throw new Error('Failed to fetch session');
  const data = await res.json();

  if (data.signedIn) {
    sessionStatus.textContent = `Signed in as ${data.handle || data.did}`;
  } else {
    sessionStatus.textContent = 'Not signed in';
  }
  csrfToken = data.csrfToken || '';

  if (data.lastListUri && !listUriInput.value.trim()) {
    listUriInput.value = data.lastListUri;
  }
}

function loadPersistedInputs() {
  const savedHandle = localStorage.getItem(LS_HANDLE_KEY);
  const savedList = localStorage.getItem(LS_LIST_KEY);
  if (savedHandle && !handleInput.value.trim()) handleInput.value = savedHandle;
  if (savedList && !listUriInput.value.trim()) listUriInput.value = savedList;
}

function wireInputPersistence() {
  handleInput.addEventListener('input', () => {
    localStorage.setItem(LS_HANDLE_KEY, handleInput.value.trim());
  });
  listUriInput.addEventListener('input', () => {
    localStorage.setItem(LS_LIST_KEY, listUriInput.value.trim());
    scheduleListPreview();
  });
}

function renderListPreviewIdle(message = 'Paste a list URL/URI to preview it.') {
  listPreviewName.textContent = 'No list loaded';
  listPreviewMeta.textContent = message;
  listPreviewAvatar.removeAttribute('src');
  listPreviewAvatar.style.visibility = 'hidden';
}

function renderListPreviewLoading() {
  listPreviewName.textContent = 'Loading list...';
  listPreviewMeta.textContent = 'Fetching list metadata';
  listPreviewAvatar.removeAttribute('src');
  listPreviewAvatar.style.visibility = 'hidden';
}

function renderListPreviewData(data) {
  listPreviewName.textContent = data.name || '(untitled list)';
  const owner = data.ownerHandle || data.ownerDid || 'unknown owner';
  const purpose = data.purpose ? ` • ${data.purpose}` : '';
  listPreviewMeta.textContent = `${owner}${purpose}`;
  if (data.avatar) {
    listPreviewAvatar.src = data.avatar;
    listPreviewAvatar.style.visibility = 'visible';
  } else {
    listPreviewAvatar.removeAttribute('src');
    listPreviewAvatar.style.visibility = 'hidden';
  }
}

function renderListPreviewError(message) {
  listPreviewName.textContent = 'List preview unavailable';
  listPreviewMeta.textContent = message || 'Could not load list metadata.';
  listPreviewAvatar.removeAttribute('src');
  listPreviewAvatar.style.visibility = 'hidden';
}

async function loadListPreviewNow() {
  const listInput = listUriInput.value.trim();
  if (!listInput) {
    renderListPreviewIdle();
    return;
  }

  renderListPreviewLoading();
  try {
    const url = `/api/list-preview?listInput=${encodeURIComponent(listInput)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load list preview');
    renderListPreviewData(data);
  } catch (error) {
    renderListPreviewError(error.message);
  }
}

function scheduleListPreview() {
  if (previewTimer) {
    clearTimeout(previewTimer);
  }
  previewTimer = setTimeout(() => {
    loadListPreviewNow();
  }, 300);
}

loginBtn.addEventListener('click', async () => {
  setBusy(true);
  try {
    const handle = handleInput.value.trim();
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ handle }),
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Login failed');
    }

    window.location.href = data.url;
  } catch (error) {
    alert(error.message);
    setBusy(false);
  }
});

logoutBtn.addEventListener('click', async () => {
  setBusy(true);
  try {
    const res = await fetch('/api/logout', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken },
    });
    if (!res.ok) throw new Error('Sign out failed');
    await readSession();
  } catch (error) {
    alert(error.message);
  } finally {
    setBusy(false);
  }
});

submitBtn.addEventListener('click', async () => {
  setBusy(true);
  try {
    const listUri = listUriInput.value.trim();
    const entries = entriesInput.value.split(/\r?\n/);
    const skipDuplicates = skipDuplicatesInput.checked;

    const res = await fetch('/api/add-to-list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ listUri, entries, skipDuplicates }),
    });

    const payload = await res.json();
    if (!res.ok) {
      throw new Error(payload.error || 'Batch failed');
    }

    renderResults(payload);
    await readSession();
  } catch (error) {
    alert(error.message);
  } finally {
    setBusy(false);
  }
});

loadConversationBtn.addEventListener('click', loadConversation);

postUrlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') loadConversation();
});

previousPostBtn.addEventListener('click', () => {
  if (currentPostIndex > 0) {
    currentPostIndex -= 1;
    renderConversationPost();
  }
});

nextPostBtn.addEventListener('click', () => {
  if (currentPostIndex < conversationPosts.length - 1) {
    currentPostIndex += 1;
    renderConversationPost();
  }
});

addPostAuthorBtn.addEventListener('click', () => {
  const post = currentConversationPost();
  if (!post) return;
  const result = addActorsToBatch([post.author]);
  authorActionsCompleted.add(post.uri);
  addPostAuthorBtn.disabled = true;
  addPostAuthorBtn.textContent = 'Author added to batch';
  postActionStatus.textContent = result.added
    ? 'Added the post author to the batch.'
    : 'The post author was already in the batch.';
});

addSourceAuthorBtn.addEventListener('click', () => {
  const post = conversationSource;
  if (!post) return;
  const result = addActorsToBatch([post.author]);
  authorActionsCompleted.add(post.uri);
  addSourceAuthorBtn.disabled = true;
  addSourceAuthorBtn.textContent = 'Author added to batch';
  sourceActionStatus.textContent = result.added
    ? 'Added the source-post author to the batch.'
    : 'The source-post author was already in the batch.';
});

addSourceLikersBtn.addEventListener('click', () => {
  const post = conversationSource;
  addLikersForPost(
    post,
    addSourceLikersBtn,
    sourceActionStatus,
    () => conversationSource?.uri === post?.uri,
  );
});

addPostLikersBtn.addEventListener('click', () => {
  const post = currentConversationPost();
  addLikersForPost(
    post,
    addPostLikersBtn,
    postActionStatus,
    () => currentConversationPost()?.uri === post?.uri,
  );
});

(async function init() {
  try {
    loadPersistedInputs();
    wireInputPersistence();
    await readSession();
    await loadListPreviewNow();
    renderResults(null);
  } catch (error) {
    sessionStatus.textContent = 'Session check failed';
    renderListPreviewIdle('Session check failed.');
  }
})();
