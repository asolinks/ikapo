/* =========================================================================
   Get-Gitty Memes Workshop — COMPLETE app.js
   - Frontend wired to Cloud Functions v2 backend (no client Firestore writes)
   - Works with event.html IDs, includes Enhanced Quiz + Career
   ========================================================================= */

/* ====================== 1) CONFIG ====================== */
/**
 * Set your deployed Cloud Functions base URL here.
 * You can override at runtime via: window.API_BASE = 'https://.../api'
 * We strip trailing slashes to avoid // in requests.
 */
const API_BASE = (window.API_BASE || 'https://us-central1-get-gitty-memes-a8c99.cloudfunctions.net/api').replace(/\/+$/, '');

// Polling interval (ms) for refreshing teams/stats
const REFRESH_MS = 5000;

// Global state for countdown + admin
let competitionState = { status: 'setup', endTime: null, timerHandle: null };
let ADMIN_SECRET = '';   // set via loginAdmin()


/* ====================== 2) STARTUP ====================== */
document.addEventListener('DOMContentLoaded', () => {
  wireUpRegistration();
  wireUpAdminControls();
  wireUpNavAndQR();
  wireUpQuizAndCareerButtons(); // ensures quiz/career work even if inline onclick is blocked

  // initial load + polling
  fetchTeamsAndStats();
  setInterval(fetchTeamsAndStats, REFRESH_MS);
});


/* ====================== 3) API HELPERS ====================== */
async function apiGet(path) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  const json = await safeJson(res);
  if (!res.ok || !json.ok) throw new Error(json?.error || `GET ${path} failed`);
  return json.data;
}

async function apiPost(path, body, headers = {}) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...headers },
    body: JSON.stringify(body || {})
  });
  const json = await safeJson(res);
  if (!res.ok || !json.ok) throw new Error(json?.error || `POST ${path} failed`);
  return json.data;
}

async function safeJson(res) { try { return await res.json(); } catch { return {}; } }


/* ====================== 4) MAIN REFRESH ====================== */
async function fetchTeamsAndStats() {
  try {
    const [teams, stats] = await Promise.all([apiGet('/teams'), apiGet('/stats')]);
    renderTeams(teams);
    updateLeaderboardFromArray(teams);
    updateMemeCountFromArray(teams);
    updateStats(stats);
    updateAdminPanels(teams, stats);
  } catch (e) {
    console.error(e);
    showToast('Failed to fetch latest data. Retrying...', 'warning');
  }
}


/* ====================== 5) TEAMS GRID ====================== */
function renderTeams(teams) {
  const grid = byId('teamsGrid');
  if (!grid) return;
  grid.innerHTML = '';
  teams.forEach(t => {
    const card = createTeamCard(t.id, {
      name: t.name,
      votes: Number(t.votes || 0),
      lastUpdated: t.lastUpdated,
      staged: t.gitStages?.staged,
      committed: t.gitStages?.committed,
      pushed: t.gitStages?.pushed,
      repoUrl: t.repoUrl,
      githubUsername: t.githubUsername,
      repoName: t.repoName
    });
    grid.appendChild(card);
  });
}

function createTeamCard(teamId, team) {
  const card = el('div', { class: 'team-card', id: `team-${teamId}` });
  const pushed = !!team.pushed;
  const staged = !!team.staged;
  const committed = !!team.committed;

  const url = repoUrlOf(team);
  const iframeHtml = pushed && url ? `
    <iframe id="iframe-${teamId}" class="meme-iframe" src="${url}"
      sandbox="allow-scripts allow-same-origin" loading="lazy" title="${esc(team.name)} Meme"></iframe>
    <div class="iframe-overlay">
      <div class="iframe-controls">
        <button class="iframe-btn" data-action="fullscreen" data-team="${teamId}" data-url="${escAttr(url)}">🔍 View Full</button>
        <button class="iframe-btn" data-action="refresh" data-team="${teamId}">🔄 Refresh</button>
      </div>
    </div>` : `
    <div class="meme-placeholder">
      <div>
        <h3>🚧 Meme Loading...</h3>
        <p>Team hasn't pushed their meme yet!</p>
        <p style="font-size: 0.9em; opacity: 0.8;">Check back in a few minutes</p>
      </div>
    </div>`;

  card.innerHTML = `
    <div class="team-header">
      <div class="team-name">${esc(team.name)}</div>
      <div class="team-status">
        ${staged ? '<span class="status-badge staged">Staged</span>' : ''}
        ${committed ? '<span class="status-badge committed">Committed</span>' : ''}
        ${pushed ? '<span class="status-badge pushed">Pushed</span>' : ''}
      </div>
    </div>
    <div class="meme-iframe-container">${iframeHtml}</div>
    <div class="team-stats">
      <div class="vote-section">
        <button class="vote-button" data-action="vote" data-team="${teamId}">Vote 👍</button>
        <span class="vote-count" id="votes-${teamId}">${Number(team.votes || 0)}</span>
      </div>
      <div class="last-updated">${getTimeAgo(team.lastUpdated)}</div>
    </div>`;

  // delegate button actions
  card.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    const action = btn.getAttribute('data-action'); const tId = btn.getAttribute('data-team');
    if (action === 'vote') voteForTeam(tId);
    if (action === 'refresh') refreshIframe(tId);
    if (action === 'fullscreen') { const u = btn.getAttribute('data-url'); openFullscreen(tId, u); }
  });

  return card;
}

function repoUrlOf(team) {
  if (team.repoUrl) return sanitizeUrl(team.repoUrl);
  // fallback to old scheme
  if (team.githubUsername && team.repoName) {
    return sanitizeUrl(`https://${team.githubUsername}.github.io/${team.repoName}/`);
  }
  return '';
}


/* ====================== 6) LEADERBOARD & STATS ====================== */
function updateLeaderboardFromArray(teams) {
  const elb = byId('leaderboard'); if (!elb) return;
  const sorted = [...teams].sort((a,b) => (Number(b.votes||0) - Number(a.votes||0))).slice(0, 10);
  elb.innerHTML = '';
  sorted.forEach((team, i) => {
    const row = el('div', { class: 'leaderboard-entry' + (i===0?' gold':i===1?' silver':i===2?' bronze':'') });
    row.innerHTML = `
      <div class="leaderboard-rank">#${i+1}</div>
      <div class="leaderboard-team">${esc(team.name)}</div>
      <div class="leaderboard-votes">${Number(team.votes||0)} votes</div>`;
    elb.appendChild(row);
  });
}

function updateMemeCountFromArray(teams) {
  const target = byId('memeCount'); if (!target) return;
  const count = teams.filter(t => t.gitStages?.pushed).length;
  target.textContent = String(count);
}

function updateStats(data) {
  const teamCountEl = byId('teamCount');
  const voteCountEl = byId('voteCount');
  if (teamCountEl) teamCountEl.textContent = data.teamCount ?? '--';
  if (voteCountEl)  voteCountEl.textContent  = data.voteCount ?? '--';

  // status + indicator
  const indicator = byId('statusIndicator');
  const text = byId('statusText');
  if (indicator && text) {
    indicator.className = 'status-indicator';
    if (data.status === 'running') { indicator.classList.add('active'); text.textContent = 'Competition Active!'; }
    else if (data.status === 'paused') { text.textContent = 'Competition Paused'; }
    else if (data.status === 'ended') { indicator.classList.add('ended'); text.textContent = 'Competition Ended'; }
    else { text.textContent = 'Waiting to Start'; }
  }

  // timer
  const endMs = toMillis(data.endTime);
  competitionState.status = data.status;
  competitionState.endTime = endMs;
  restartCountdown();
}


/* ====================== 7) VOTING ====================== */
async function voteForTeam(teamId) {
  if (!teamId) return;
  try {
    await apiPost('/vote', { teamId });
    showToast('Vote recorded! 🎉', 'success');
    fetchTeamsAndStats();
  } catch (e) {
    const msg = e.message || 'Vote failed';
    showToast(msg, /already voted/i.test(msg) ? 'warning' : 'error');
  }
}


/* ====================== 8) REGISTRATION ====================== */
function wireUpRegistration() {
  const form = byId('registrationForm'); if (!form) return;
  form.addEventListener('submit', handleRegistration);

  // Auto repo name preview
  const teamNameInput = byId('teamName');
  const repoPreview = byId('repoName');
  if (teamNameInput && repoPreview) {
    teamNameInput.addEventListener('input', () => {
      repoPreview.textContent = `${slugify(teamNameInput.value)}-meme-war`;
    });
  }
}

async function handleRegistration(e) {
  e.preventDefault();
  const payload = {
    teamName: val('teamName'),
    department: val('department'),
    faculty: val('faculty'),
    githubUsername: val('githubUsername'),
    members: [
      { name: val('member1'), email: val('email1') },
      { name: val('member2'), email: val('email2') },
      { name: val('member3'), email: val('email3') }
    ]
  };

  // Simple validation
  if (!payload.teamName || !payload.department || !payload.faculty || !payload.githubUsername ||
      payload.members.some(m => !m.name || !m.email)) {
    showToast('Please fill all required fields.', 'warning');
    return;
  }

  try {
    const data = await apiPost('/registerTeam', payload);
    setVisible('registrationForm', false);
    setVisible('registrationSuccess', true);
    setText('finalRepoName', data.repoName || '');
    showToast('Team registered successfully! 🎉', 'success');
    fetchTeamsAndStats();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Registration failed.', 'error');
  }
}


/* ====================== 9) ADMIN CONTROLS ====================== */
function wireUpAdminControls() {
  // Basic login button (adminLogin contains a button)
  const adminLoginBtn = document.querySelector('#adminLogin button');
  if (adminLoginBtn) adminLoginBtn.addEventListener('click', loginAdmin);

  // Also try to wire known button IDs if present
  const s = byId('adminStart'); if (s && !s._wired) { s.addEventListener('click', startCompetition); s._wired = true; }
  const p = byId('adminPause'); if (p && !p._wired) { p.addEventListener('click', pauseCompetition); p._wired = true; }
  const e = byId('adminEnd');   if (e && !e._wired) { e.addEventListener('click', endCompetition);   e._wired = true; }
  const r = byId('adminResetVotes'); if (r && !r._wired) { r.addEventListener('click', resetVotes); r._wired = true; }
}

function loginAdmin() {
  const pwd = val('adminPassword');
  if (!pwd) return showToast('Enter admin password', 'warning');
  ADMIN_SECRET = pwd;
  setVisible('adminLogin', false);
  setVisible('adminPanel', true);
  showToast('Admin logged in.', 'success');

  // When panel shows, wire generic buttons if they exist (by class)
  const btnStart = document.querySelector('#adminPanel .btn.btn-success');
  const btnPause = document.querySelector('#adminPanel .btn.btn-warning');
  const btnEnd   = document.querySelector('#adminPanel .btn.btn-danger');
  if (btnStart && !btnStart._wired) { btnStart.addEventListener('click', startCompetition); btnStart._wired = true; }
  if (btnPause && !btnPause._wired) { btnPause.addEventListener('click', pauseCompetition); btnPause._wired = true; }
  if (btnEnd && !btnEnd._wired)     { btnEnd.addEventListener('click', endCompetition);     btnEnd._wired = true; }
}

function updateAdminPanels(teams, stats) {
  if (!isVisible('adminPanel')) return;

  const adminStats = byId('adminStats');
  if (adminStats) {
    adminStats.innerHTML = `
      <ul class="admin-stats-list">
        <li><strong>Status:</strong> ${esc(competitionState.status)}</li>
        <li><strong>Teams:</strong> ${stats?.teamCount ?? teams?.length ?? 0}</li>
        <li><strong>Total Votes:</strong> ${stats?.voteCount ?? 0}</li>
        <li><strong>Memes Submitted:</strong> ${teams.filter(t => t.gitStages?.pushed).length}</li>
      </ul>`;
  }

  const adminTeams = byId('adminTeams');
  if (adminTeams) {
    adminTeams.innerHTML = '';
    const sorted = [...teams].sort((a,b)=> (Number(b.votes||0)-Number(a.votes||0)));
    sorted.forEach((t, i) => {
      const row = el('div', { class: 'admin-team-row' });
      row.innerHTML = `#${i+1} — <strong>${esc(t.name)}</strong> — ${Number(t.votes||0)} votes`;
      adminTeams.appendChild(row);
    });
  }
}

async function startCompetition() {
  try {
    await apiPost('/admin/start', { durationMinutes: 60 }, { 'x-admin-secret': ADMIN_SECRET });
    showToast('Competition started!', 'success');
    fetchTeamsAndStats();
  } catch (e) { showToast(e.message || 'Failed to start.', 'error'); }
}
async function pauseCompetition() {
  try {
    await apiPost('/admin/pause', {}, { 'x-admin-secret': ADMIN_SECRET });
    showToast('Competition paused.', 'success');
    fetchTeamsAndStats();
  } catch (e) { showToast(e.message || 'Failed to pause.', 'error'); }
}
async function endCompetition() {
  try {
    await apiPost('/admin/end', {}, { 'x-admin-secret': ADMIN_SECRET });
    showToast('Competition ended.', 'success');
    fetchTeamsAndStats();
  } catch (e) { showToast(e.message || 'Failed to end.', 'error'); }
}
async function resetVotes() {
  try {
    await apiPost('/admin/resetVotes', {}, { 'x-admin-secret': ADMIN_SECRET });
    showToast('Votes reset.', 'success');
    fetchTeamsAndStats();
  } catch (e) { showToast(e.message || 'Failed to reset votes.', 'error'); }
}


/* ====================== 10) NAVIGATION & QR ====================== */
function wireUpNavAndQR() {
  try {
    const qrEl = byId('voteQRCode');
    const urlEl = byId('voteURL');
    if (qrEl) {
      const href = `${location.origin}${location.pathname}#vote`;
      if (urlEl) urlEl.textContent = href;
      if (window.QRCode) {
        qrEl.innerHTML = '';
        new QRCode(qrEl, { text: href, width: 160, height: 160 });
      }
    }
  } catch (_) {}
}


/* ====================== 11) TIMER / COUNTDOWN ====================== */
function restartCountdown() {
  if (competitionState.timerHandle) clearInterval(competitionState.timerHandle);
  updateCountdown();
  competitionState.timerHandle = setInterval(updateCountdown, 1000);
}

function updateCountdown() {
  const elA = byId('countdown');      // optional new id
  const elB = byId('timeRemaining');  // event.html uses this id
  const setTxt = (t) => { if (elA) elA.textContent = t; if (elB) elB.textContent = t; };

  if (competitionState.status !== 'running' || !competitionState.endTime) {
    setTxt('--:--:--');
    return;
  }
  const ms = Math.max(competitionState.endTime - Date.now(), 0);
  const { h, m, s } = msToHMS(ms);
  setTxt(`${pad(h)}:${pad(m)}:${pad(s)}`);
}


/* ====================== 12) IFRAMES & SMALL UTILS ====================== */
function refreshIframe(teamId) {
  const iframe = byId(`iframe-${teamId}`);
  if (!iframe) return;
  const base = iframe.src.split('?')[0];
  iframe.src = `${base}?t=${Date.now()}`;
}

function openFullscreen(_teamId, url) {
  if (!url) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

// Friendly “x minutes ago”
function getTimeAgo(ts) {
  const ms = toMillis(ts);
  if (!ms) return '—';
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}


/* ====================== 13) ENHANCED QUIZ LOGIC ====================== */
const quizQuestions = [
  {
    q: "Your code works but you have no idea why. What's your move?",
    options: [
      { text: "Ship it! If it works, it works! 🚀", score: 0 },
      { text: "Add a comment: // Magic happens here ✨", score: 1 },
      { text: "Spend 3 hours debugging to understand it", score: 3 },
      { text: "Ask ChatGPT to explain your own code", score: 2 }
    ]
  },
  {
    q: "You accidentally pushed secrets to GitHub. Your reaction?",
    options: [
      { text: "Change your name and move to another country", score: 0 },
      { text: "git push --force and pretend nothing happened", score: 1 },
      { text: "Immediately rotate keys and use BFG Repo-Cleaner", score: 3 },
      { text: "Tweet about it for the engagement", score: 2 }
    ]
  },
  {
    q: "Your PR has 47 comments. What's your strategy?",
    options: [
      { text: "Mark all as resolved without reading", score: 0 },
      { text: "Reply 'Good point!' to everything", score: 1 },
      { text: "Address each comment thoughtfully", score: 3 },
      { text: "Start a flame war about tabs vs spaces", score: 2 }
    ]
  },
  {
    q: "git blame shows your code caused the bug. You...",
    options: [
      { text: "Blame cosmic rays affecting the CPU", score: 1 },
      { text: "Quick! Rewrite history with rebase", score: 0 },
      { text: "Own it, fix it, write tests, become legend", score: 3 },
      { text: "That was past me. I don't know that person", score: 2 }
    ]
  },
  {
    q: "Your commit history looks like:",
    options: [
      { text: "fix, fix2, fix3, please work, PLEASE, IT WORKS!", score: 0 },
      { text: "feat: Add feature | fix: Fix bug | docs: Update", score: 3 },
      { text: "Inspirational quotes for each commit", score: 1 },
      { text: "One massive commit: 'Did stuff'", score: 2 }
    ]
  },
  {
    q: "Production is down and it's Friday 5 PM. You:",
    options: [
      { text: "Already logged off, not your problem", score: 0 },
      { text: "Post 'F' in the team chat and help", score: 2 },
      { text: "Roll up sleeves, debug, fix, document, hero mode", score: 3 },
      { text: "Blame DNS. It's always DNS", score: 1 }
    ]
  },
  {
    q: "Your code review strategy is:",
    options: [
      { text: "LGTM! (didn't actually look)", score: 0 },
      { text: "Nitpick every semicolon and variable name", score: 1 },
      { text: "Focus on logic, security, and helpful suggestions", score: 3 },
      { text: "Only review if there's free pizza", score: 2 }
    ]
  },
  {
    q: "Merge conflict resolution technique:",
    options: [
      { text: "Accept all incoming changes, YOLO", score: 0 },
      { text: "Accept all current changes, my code is perfect", score: 1 },
      { text: "Carefully review and merge both versions", score: 3 },
      { text: "Delete everything, start fresh", score: 2 }
    ]
  }
];

let quizIndex = 0;
let quizScore = 0;

function startQuiz() {
  quizIndex = 0;
  quizScore = 0;
  showEl('quizQuestions', true);
  showEl('quizStart', false);
  showEl('quizResults', false);
  renderQuizQuestion();
}

function renderQuizQuestion() {
  const q = quizQuestions[quizIndex];
  setText('questionText', q.q);
  const box = byId('optionsContainer');
  if (box) {
    box.innerHTML = '';
    q.options.forEach((opt, i) => {
      const btn = el('button', { class: 'btn btn-option', 'data-i': String(i) });
      btn.textContent = opt.text;
      btn.addEventListener('click', () => selectAnswer(i));
      box.appendChild(btn);
    });
  }
  setProgress();
  setText('questionCounter', `Question ${quizIndex + 1} of ${quizQuestions.length}`);
}

function selectAnswer(i) {
  quizScore += quizQuestions[quizIndex].options[i].score;
  quizIndex++;
  if (quizIndex >= quizQuestions.length) return showQuizResults();
  renderQuizQuestion();
}

function setProgress() {
  const pct = Math.round(((quizIndex) / quizQuestions.length) * 100);
  const fill = byId('progressFill');
  if (fill) fill.style.width = pct + '%';
}

function showQuizResults() {
  showEl('quizQuestions', false);
  showEl('quizResults', true);

  let title = 'Git Newbie';
  let desc = 'You\'re just starting your journey. Every master was once a disaster!';
  let emoji = '🌱';
  if (quizScore >= 20) { title = 'Git Wizard'; desc = 'You are the chosen one. Teams fight to have you review their PRs.'; emoji = '🧙‍♂️'; }
  else if (quizScore >= 15) { title = 'Merge Master'; desc = 'Conflicts fear you. Your commits are poetry.'; emoji = '⚔️'; }
  else if (quizScore >= 10) { title = 'Branch Manager'; desc = 'Solid Git game! You know your way around version control.'; emoji = '🌳'; }
  else if (quizScore >= 5) { title = 'Commit Apprentice'; desc = 'You\'re learning the ways of Git. Future is bright!'; emoji = '📚'; }

  setText('resultBadge', `${emoji} ${title}`);

  const roles = {
    'Git Newbie': ['Bug Creator', 'Chaos Coordinator', 'YOLO Developer'],
    'Commit Apprentice': ['Junior Dev', 'Stack Overflow Scholar', 'Documentation Reader'],
    'Branch Manager': ['Code Reviewer', 'Merge Conflict Mediator', 'Pipeline Guardian'],
    'Merge Master': ['Tech Lead', 'Architecture Astronaut', 'PR Approval Gatekepeer'],
    'Git Wizard': ['10x Developer', 'Git Whisperer', 'Production Savior']
  };

  const rolesList = roles[title] || ['Future Developer'];
  const chips = rolesList.map(r => `<span class="role-chip">${esc(r)}</span>`).join('');

  const roleBox = byId('resultRoles') || byId('resultDescription');
  if (roleBox) {
    roleBox.innerHTML = `
      <p>${desc}</p>
      <div style="margin-top: 1rem;">
        <strong>Your potential roles:</strong><br>
        ${chips}
      </div>
      <p style="margin-top: 1rem; font-size: 0.9em; opacity: 0.8;">
        Score: ${quizScore}/${quizQuestions.length * 3} points
      </p>
    `;
  }
}

function retakeQuiz() {
  showEl('quizResults', false);
  showEl('quizStart', true);
}


/* ====================== 14) ENHANCED CAREER PATH DISCOVERY ====================== */
const careerQuestions = [
  {
    q: "Your ideal Friday night involves:",
    answers: [
      { text: "Debugging that one weird CSS animation", points: { frontend: 3, backend: 0, devops: 0, ux: 1, data: 0 } },
      { text: "Optimizing database queries for fun", points: { frontend: 0, backend: 3, devops: 1, ux: 0, data: 2 } },
      { text: "Setting up a home Kubernetes cluster", points: { frontend: 0, backend: 1, devops: 3, ux: 0, data: 0 } },
      { text: "Redesigning your favorite app (it needs help)", points: { frontend: 1, backend: 0, devops: 0, ux: 3, data: 0 } },
      { text: "Creating graphs of your Netflix viewing habits", points: { frontend: 0, backend: 0, devops: 0, ux: 0, data: 3 } }
    ]
  },
  {
    q: "Your browser has 73 tabs open. Most of them are:",
    answers: [
      { text: "CSS tricks and CodePen demos", points: { frontend: 3, backend: 0, devops: 0, ux: 1, data: 0 } },
      { text: "Stack Overflow and API documentation", points: { frontend: 0, backend: 3, devops: 0, ux: 0, data: 1 } },
      { text: "Server monitoring dashboards and logs", points: { frontend: 0, backend: 0, devops: 3, ux: 0, data: 1 } },
      { text: "Dribbble and Behance for 'inspiration'", points: { frontend: 1, backend: 0, devops: 0, ux: 3, data: 0 } },
      { text: "Kaggle competitions and Jupyter notebooks", points: { frontend: 0, backend: 1, devops: 0, ux: 0, data: 3 } }
    ]
  },
  {
    q: "Your code breaks. Your first instinct:",
    answers: [
      { text: "Check if it looks broken or actually IS broken", points: { frontend: 3, backend: 0, devops: 0, ux: 2, data: 0 } },
      { text: "Console.log EVERYTHING until you find it", points: { frontend: 1, backend: 3, devops: 0, ux: 0, data: 1 } },
      { text: "Check the CI/CD pipeline and server logs", points: { frontend: 0, backend: 1, devops: 3, ux: 0, data: 0 } },
      { text: "Ask users what they were trying to do", points: { frontend: 0, backend: 0, devops: 0, ux: 3, data: 1 } },
      { text: "Plot error frequency to find patterns", points: { frontend: 0, backend: 0, devops: 1, ux: 0, data: 3 } }
    ]
  },
  {
    q: "Your favorite error message is:",
    answers: [
      { text: "undefined is not a function", points: { frontend: 3, backend: 1, devops: 0, ux: 0, data: 0 } },
      { text: "NullPointerException", points: { frontend: 0, backend: 3, devops: 0, ux: 0, data: 1 } },
      { text: "Connection refused on port 443", points: { frontend: 0, backend: 1, devops: 3, ux: 0, data: 0 } },
      { text: "Users don't see errors if the UI is good enough", points: { frontend: 1, backend: 0, devops: 0, ux: 3, data: 0 } },
      { text: "ValueError: Shape mismatch", points: { frontend: 0, backend: 0, devops: 0, ux: 0, data: 3 } }
    ]
  },
  {
    q: "Your superpower would be:",
    answers: [
      { text: "Making divs perfectly centered every time", points: { frontend: 3, backend: 0, devops: 0, ux: 1, data: 0 } },
      { text: "Writing SQL queries in your sleep", points: { frontend: 0, backend: 3, devops: 0, ux: 0, data: 2 } },
      { text: "Never having downtime ever", points: { frontend: 0, backend: 1, devops: 3, ux: 0, data: 0 } },
      { text: "Reading users' minds for perfect UX", points: { frontend: 1, backend: 0, devops: 0, ux: 3, data: 0 } },
      { text: "Predicting the future with 99.9% accuracy", points: { frontend: 0, backend: 0, devops: 0, ux: 0, data: 3 } }
    ]
  },
  {
    q: "The Matrix is real. You see:",
    answers: [
      { text: "Cascading <div> tags and flexbox containers", points: { frontend: 3, backend: 0, devops: 0, ux: 1, data: 0 } },
      { text: "RESTful endpoints and JSON responses", points: { frontend: 0, backend: 3, devops: 1, ux: 0, data: 0 } },
      { text: "Docker containers and load balancers", points: { frontend: 0, backend: 0, devops: 3, ux: 0, data: 0 } },
      { text: "User journeys and conversion funnels", points: { frontend: 1, backend: 0, devops: 0, ux: 3, data: 0 } },
      { text: "Correlation matrices and neural networks", points: { frontend: 0, backend: 0, devops: 0, ux: 0, data: 3 } }
    ]
  },
  {
    q: "Your coffee order says:",
    answers: [
      { text: "Fancy latte with custom CSS... I mean foam art", points: { frontend: 3, backend: 0, devops: 0, ux: 2, data: 0 } },
      { text: "Black coffee, strongly typed", points: { frontend: 0, backend: 3, devops: 1, ux: 0, data: 1 } },
      { text: "Whatever keeps the servers running", points: { frontend: 0, backend: 1, devops: 3, ux: 0, data: 0 } },
      { text: "Something Instagram-worthy", points: { frontend: 1, backend: 0, devops: 0, ux: 3, data: 0 } },
      { text: "Precisely 237ml at 67°C (I have the data)", points: { frontend: 0, backend: 0, devops: 0, ux: 0, data: 3 } }
    ]
  }
];

const careerPaths = {
  frontend: {
    title: '🎨 Frontend Wizard',
    description: 'You bring websites to life and make buttons irresistibly clickable. CSS fears you, JavaScript obeys you, and users love you.',
    skills: ['React/Vue Mastery', 'CSS Wizardry', 'Animation Magic', 'Browser Whispering', 'Responsive Design'],
    funFact: 'You can center a div in 17 different ways and have strong opinions about each method.'
  },
  backend: {
    title: '⚙️ Backend Architect',
    description: 'You are the puppet master pulling the strings behind the curtain. APIs sing your praise, databases bow to your queries.',
    skills: ['API Design', 'Database Optimization', 'Security Fortification', 'Microservices', 'Caching Strategies'],
    funFact: 'You name your variables properly and your documentation actually exists.'
  },
  devops: {
    title: '🚀 DevOps Superhero',
    description: 'You are the guardian of uptime, the keeper of pipelines. When production breaks, you don\'t panic—you already have three backup plans.',
    skills: ['CI/CD Mastery', 'Container Orchestration', 'Infrastructure as Code', 'Monitoring & Alerts', 'Disaster Recovery'],
    funFact: 'Your idea of fun is automating things that don\'t need to be automated... yet.'
  },
  ux: {
    title: '✨ UX/UI Enchanter',
    description: 'You see the world in user flows and color palettes. Every pixel has purpose, every interaction tells a story.',
    skills: ['User Research', 'Wireframe Wizardry', 'Prototype Magic', 'Accessibility Advocacy', 'Design Systems'],
    funFact: 'You have more design iterations saved than photos on your phone.'
  },
  data: {
    title: '📊 Data Sorcerer',
    description: 'You find patterns where others see chaos. Numbers speak to you, and you translate their secrets for mere mortals.',
    skills: ['Statistical Analysis', 'Machine Learning', 'Data Visualization', 'Predictive Modeling', 'Big Data Wrangling'],
    funFact: 'You\'ve calculated the optimal time to have lunch based on 6 months of productivity data.'
  }
};

let careerQuizIndex = 0;
let careerScores = { frontend: 0, backend: 0, devops: 0, ux: 0, data: 0 };

function startCareerQuiz() {
  careerQuizIndex = 0;
  careerScores = { frontend: 0, backend: 0, devops: 0, ux: 0, data: 0 };
  showEl('careerQuiz', false);
  showEl('careerResult', false);
  
  // Create quiz container if it doesn't exist
  const container = byId('careerQuiz').parentElement;
  let quizContainer = byId('careerQuizContainer');
  if (!quizContainer) {
    quizContainer = el('div', { id: 'careerQuizContainer', class: 'career-quiz-container' });
    container.appendChild(quizContainer);
  }
  
  quizContainer.style.display = 'block';
  renderCareerQuestion();
}

function renderCareerQuestion() {
  const container = byId('careerQuizContainer');
  const q = careerQuestions[careerQuizIndex];
  
  container.innerHTML = `
    <div class="career-question-card">
      <div class="career-progress">
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${(careerQuizIndex / careerQuestions.length) * 100}%"></div>
        </div>
        <span>Question ${careerQuizIndex + 1} of ${careerQuestions.length}</span>
      </div>
      <h3>${q.q}</h3>
      <div class="career-options" id="careerOptionsContainer"></div>
    </div>
  `;
  
  const optionsContainer = byId('careerOptionsContainer');
  q.answers.forEach((answer, i) => {
    const btn = el('button', { class: 'btn btn-option career-option' });
    btn.textContent = answer.text;
    btn.addEventListener('click', () => selectCareerAnswer(i));
    optionsContainer.appendChild(btn);
  });
}

function selectCareerAnswer(i) {
  const answer = careerQuestions[careerQuizIndex].answers[i];
  // Add points to each category
  Object.entries(answer.points).forEach(([key, value]) => {
    careerScores[key] += value;
  });
  careerQuizIndex++;
  if (careerQuizIndex >= careerQuestions.length) {
    showCareerResults();
  } else {
    renderCareerQuestion();
  }
}

function showCareerResults() {
  const container = byId('careerQuizContainer');
  if (container) container.style.display = 'none';
  
  // Find the highest scoring path
  let maxScore = -Infinity;
  let topPath = 'frontend';
  Object.entries(careerScores).forEach(([path, score]) => {
    if (score > maxScore) { maxScore = score; topPath = path; }
  });
  
  const result = careerPaths[topPath];
  showEl('careerResult', true);
  setText('careerTitle', result.title);
  setText('careerDescription', result.description);
  
  const skillsBox = byId('careerSkills');
  if (skillsBox) {
    const skillsHtml = result.skills.map(s => `<span class="skill-chip">${esc(s)}</span>`).join('');
    skillsBox.innerHTML = `
      ${skillsHtml}
      <div style="margin-top: 1.5rem; padding: 1rem; background: rgba(0,0,0,0.05); border-radius: 8px;">
        <strong>Fun Fact:</strong> ${result.funFact}
      </div>
      <div style="margin-top: 1rem;">
        <button class="btn btn-secondary" onclick="startCareerQuiz()">Try Again</button>
      </div>
    `;
  }
  console.log('Career Quiz Scores:', careerScores);
}


/* ====================== 15) DOM/UTIL HELPERS ====================== */
function byId(id) { return document.getElementById(id); }
function query(sel) { return document.querySelector(sel); }
function el(tag, attrs = {}) { const n = document.createElement(tag); Object.entries(attrs).forEach(([k,v]) => n.setAttribute(k, v)); return n; }
function val(id) { const n = byId(id); return n ? n.value.trim() : ''; }
function setVisible(id, on) { const n = byId(id); if (n) n.style.display = on ? '' : 'none'; }
function isVisible(id) { const n = (typeof id==='string') ? byId(id) : id; if (!n) return false; const s = getComputedStyle(n); return s.display !== 'none'; }
function setText(id, text) { const n = byId(id); if (n) n.textContent = String(text); }
function esc(s='') { return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function escAttr(s='') { return String(s).replace(/"/g, '&quot;'); }
function slugify(str='') { return str.toString().normalize('NFKD').replace(/[\u0300-\u036F]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase(); }
function sanitizeUrl(u='') { try { const url = new URL(u); if (!/^https?:$/.test(url.protocol)) return ''; return url.href; } catch { return ''; } }
function toMillis(ts) {
  if (!ts) return null;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') { const d = Date.parse(ts); return Number.isFinite(d) ? d : null; }
  if (typeof ts === 'object') {
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if ('_seconds' in ts) return ts._seconds * 1000 + (ts._nanoseconds ? Math.floor(ts._nanoseconds/1e6) : 0);
    if ('seconds' in ts) return ts.seconds * 1000 + (ts.nanoseconds ? Math.floor(ts.nanoseconds/1e6) : 0);
  }
  return null;
}
function msToHMS(ms) { const total = Math.floor(ms/1000); const h = Math.floor(total/3600); const m = Math.floor((total%3600)/60); const s = total%60; return { h, m, s }; }
function pad(n) { return String(n).padStart(2,'0'); }

function showToast(message, type = 'info') {
  // Minimal toast; customize if you have a #toast element
  if (type === 'error') console.error(message);
  else if (type === 'warning') console.warn(message);
  else console.log(message);
}

function showEl(id, on) { const n = byId(id); if (n) n.style.display = on ? '' : 'none'; }

function wireUpQuizAndCareerButtons() {
  const startBtn  = document.querySelector('#quizStart .btn, #quizStart button');
  const retakeBtn = document.querySelector('#quizResults .btn.btn-secondary, #quizResults button');
  const careerBtn = document.querySelector('#careerQuiz .btn, #careerQuiz button');

  if (startBtn && !startBtn._wired)  { startBtn.addEventListener('click', startQuiz);        startBtn._wired = true; }
  if (retakeBtn && !retakeBtn._wired){ retakeBtn.addEventListener('click', retakeQuiz);      retakeBtn._wired = true; }
  if (careerBtn && !careerBtn._wired){ careerBtn.addEventListener('click', startCareerQuiz); careerBtn._wired = true; }
}


/* ====================== 16) EXPORT FOR INLINE ONCLICK ====================== */
window.voteForTeam = voteForTeam;
window.loginAdmin = loginAdmin;
window.startCompetition = startCompetition;
window.pauseCompetition = pauseCompetition;
window.endCompetition = endCompetition;
window.startQuiz = startQuiz;
window.retakeQuiz = retakeQuiz;
window.startCareerQuiz = startCareerQuiz;
window.refreshIframe = refreshIframe;
window.openFullscreen = openFullscreen;
