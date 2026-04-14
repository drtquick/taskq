/**
 * TaskQ — Firebase Cloud Functions v1.7
 * Daily email report via MXRoute SMTP (nodemailer)
 * Inbound email-to-task via HTTP endpoint
 *
 * SETUP:
 *   1. cd functions && npm install
 *   2. firebase functions:secrets:set SMTP_PASSWORD
 *      (paste your MXRoute mailbox password when prompted)
 *   3. firebase deploy --only functions
 *   4. Copy the sendEmailNow URL into TaskQ → Email settings
 *   5. Set up MXRoute forwarding: taskq@qponent.com → inboundEmail Cloud Function URL
 */

const { onSchedule }  = require('firebase-functions/v2/scheduler');
const { onRequest }   = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin            = require('firebase-admin');
const nodemailer       = require('nodemailer');
const { ImapFlow }     = require('imapflow');
const { simpleParser } = require('mailparser');
const ical             = require('node-ical');
const chrono           = require('chrono-node');
const { authenticate } = require('mailauth');

const DEFAULT_TZ = 'America/Chicago';

admin.initializeApp();
const db = admin.database();

const SMTP_PASSWORD = defineSecret('SMTP_PASSWORD');

// SMTP config for MXRoute
const SMTP_HOST = 'chocobo.mxrouting.net';
const SMTP_PORT = 465;
const SMTP_USER = 'taskq@qponent.com';

function createTransport(password) {
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true,
    auth: { user: SMTP_USER, pass: password }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric'
  });
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true
  });
}

function fmtDateTime(ts, allDay) {
  if (allDay) return fmtDate(ts);
  return fmtDate(ts) + ' ' + fmtTime(ts);
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Get assignee display string from task or event (handles both legacy and multi-assignee)
function getAssigneeStr(item) {
  if (item.assignees && item.assignees.length) return item.assignees.join(', ');
  if (item.assignee && item.assignee !== '—') return item.assignee;
  return null;
}

// Get all assignee names from task or event as array
function getAssigneeArr(item) {
  if (item.assignees && item.assignees.length) return item.assignees;
  if (item.assignee && item.assignee !== '—') return [item.assignee];
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Email HTML builder
// ─────────────────────────────────────────────────────────────────────────────

function buildEmailHTML({ overdueTasks, todayTasks, upcomingEvents, byPerson }) {
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  const style = `
    body { margin: 0; padding: 0; background: #0d0d0d; font-family: 'Courier New', Courier, monospace; color: #e0e0e0; }
    .wrap { max-width: 640px; margin: 0 auto; padding: 24px 16px; }
    .header { border-bottom: 3px solid #FF6B00; padding-bottom: 14px; margin-bottom: 24px; }
    .header h1 { font-size: 1.1rem; letter-spacing: 4px; color: #FF6B00; margin: 0 0 4px; text-transform: uppercase; }
    .header .date { font-size: 0.72rem; color: #666; letter-spacing: 2px; }
    .section { margin-bottom: 28px; }
    .section-title { font-size: 0.65rem; letter-spacing: 3px; color: #FF6B00; text-transform: uppercase;
      border-bottom: 1px solid #222; padding-bottom: 6px; margin-bottom: 12px; }
    .empty-note { font-size: 0.75rem; color: #555; padding: 6px 0; }
    table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
    th { text-align: left; font-size: 0.6rem; letter-spacing: 2px; color: #666; padding: 4px 8px 8px; border-bottom: 1px solid #222; }
    td { padding: 8px; border-bottom: 1px solid #1a1a1a; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    .tag-overdue { color: #FF4444; font-weight: bold; font-size: 0.7rem; letter-spacing: 1px; }
    .tag-today { color: #FFD700; font-size: 0.7rem; letter-spacing: 1px; }
    .muted { color: #555; font-size: 0.7rem; }
    .person-block { background: #111; border: 1px solid #222; border-left: 3px solid #FF6B00;
      border-radius: 4px; padding: 12px 14px; margin-bottom: 14px; }
    .person-name { font-size: 0.8rem; letter-spacing: 2px; color: #FF6B00; margin-bottom: 8px; text-transform: uppercase; }
    .person-item { font-size: 0.75rem; padding: 3px 0; color: #ccc; }
    .person-item .item-meta { color: #555; font-size: 0.68rem; margin-left: 6px; }
    .footer { font-size: 0.6rem; color: #333; letter-spacing: 2px; text-align: center;
      border-top: 1px solid #1a1a1a; padding-top: 16px; margin-top: 32px; }
  `;

  let overdueRows = '';
  overdueTasks.forEach(t => {
    overdueRows += `<tr>
      <td>${esc(t.name)}</td>
      <td>${getAssigneeStr(t) ? esc(getAssigneeStr(t)) : '<span class="muted">---</span>'}</td>
      <td>${t.dueAt ? `<span class="tag-overdue">${fmtDate(t.dueAt)}</span>` : '<span class="muted">---</span>'}</td>
      <td class="muted">${esc(t._wsName)}</td>
    </tr>`;
  });

  let todayRows = '';
  todayTasks.forEach(t => {
    todayRows += `<tr>
      <td>${esc(t.name)}</td>
      <td>${getAssigneeStr(t) ? esc(getAssigneeStr(t)) : '<span class="muted">---</span>'}</td>
      <td>${t.dueAt ? `<span class="tag-today">${fmtTime(t.dueAt)}</span>` : '<span class="muted">---</span>'}</td>
      <td class="muted">${esc(t._wsName)}</td>
    </tr>`;
  });

  let eventRows = '';
  upcomingEvents.forEach(ev => {
    eventRows += `<tr>
      <td>${esc(ev.title)}</td>
      <td>${getAssigneeStr(ev) ? esc(getAssigneeStr(ev)) : '<span class="muted">---</span>'}</td>
      <td>${fmtDateTime(ev.startAt, ev.allDay)}</td>
      <td>${ev.location ? esc(ev.location) : '<span class="muted">---</span>'}</td>
      <td class="muted">${esc(ev._wsName)}</td>
    </tr>`;
  });

  let personHTML = '';
  const people = Object.keys(byPerson).sort((a, b) => a.localeCompare(b));
  people.forEach(person => {
    const data = byPerson[person];
    let items = '';
    data.tasks.forEach(t => {
      const badge = t.dueAt && t.dueAt < Date.now()
        ? `<span class="tag-overdue">OVERDUE</span>` : `<span class="tag-today">DUE TODAY</span>`;
      items += `<div class="person-item">📋 ${esc(t.name)} ${badge}</div>`;
    });
    data.events.forEach(ev => {
      items += `<div class="person-item">📅 ${esc(ev.title)} <span class="item-meta">${fmtDateTime(ev.startAt, ev.allDay)}</span></div>`;
    });
    if (items) {
      personHTML += `<div class="person-block">
        <div class="person-name">${esc(person)}</div>
        ${items}
      </div>`;
    }
  });

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${style}</style></head>
<body><div class="wrap">
  <div class="header">
    <h1>TaskQ Daily Report</h1>
    <div class="date">${dateStr}</div>
  </div>

  <div class="section">
    <div class="section-title">⚠ Overdue Tasks (${overdueTasks.length})</div>
    ${overdueTasks.length ? `<table>
      <tr><th>TASK</th><th>ASSIGNEE</th><th>WAS DUE</th><th>WORKSPACE</th></tr>
      ${overdueRows}
    </table>` : '<div class="empty-note">No overdue tasks.</div>'}
  </div>

  <div class="section">
    <div class="section-title">📋 Due Today (${todayTasks.length})</div>
    ${todayTasks.length ? `<table>
      <tr><th>TASK</th><th>ASSIGNEE</th><th>TIME</th><th>WORKSPACE</th></tr>
      ${todayRows}
    </table>` : '<div class="empty-note">Nothing due today.</div>'}
  </div>

  <div class="section">
    <div class="section-title">📅 Upcoming Events -- Next 7 Days (${upcomingEvents.length})</div>
    ${upcomingEvents.length ? `<table>
      <tr><th>EVENT</th><th>ASSIGNEE</th><th>DATE / TIME</th><th>LOCATION</th><th>WORKSPACE</th></tr>
      ${eventRows}
    </table>` : '<div class="empty-note">No upcoming events.</div>'}
  </div>

  ${personHTML ? `<div class="section">
    <div class="section-title">👤 Per-Person Summary</div>
    ${personHTML}
  </div>` : ''}

  <div class="footer">TASKQ DAILY REPORT -- SENT AUTOMATICALLY VIA TASKQ@QPONENT.COM</div>
</div></body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: gather data and send
// ─────────────────────────────────────────────────────────────────────────────

async function buildAndSendReport(smtpPassword) {
  const settingsSnap = await db.ref('emailSettings').once('value');
  const emailCfg     = settingsSnap.val() || {};

  if (!emailCfg.enabled) {
    console.log('Email report is disabled -- skipping.');
    return { skipped: true };
  }
  const DEFAULT_RECIPIENT = 'trevorcoddington@gmail.com';
  const recipients = (emailCfg.recipients || []).filter(r => r && r.includes('@'));
  if (!recipients.length) recipients.push(DEFAULT_RECIPIENT);

  const [wsSnap, usersSnap] = await Promise.all([
    db.ref('workspaces').once('value'),
    db.ref('users').once('value'),
  ]);
  const workspaces = wsSnap.val() || {};
  const users = usersSnap.val() || {};

  // Build wsId -> name map from users/{uid}/workspaces/{wsId}/name
  const wsNameById = {};
  Object.values(users).forEach(userData => {
    const userWs = userData?.workspaces || {};
    Object.entries(userWs).forEach(([wsId, entry]) => {
      if (entry?.name && !wsNameById[wsId]) wsNameById[wsId] = entry.name;
    });
  });

  const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
  const todayStart   = todayMidnight.getTime();
  const todayEnd     = todayStart + 86400000;
  const weekEnd      = todayStart + 7 * 86400000;

  let allTasks  = [];
  let allEvents = [];

  Object.entries(workspaces).forEach(([wsId, wsData]) => {
    const wsName = wsNameById[wsId] || wsData.settings?.subtitle || wsId;
    const wsTasks = Object.entries(wsData.tasks || {})
      .map(([k, v]) => ({ ...v, _key: k, _wsId: wsId, _wsName: wsName }));
    const wsEvents = Object.entries(wsData.events || {})
      .map(([k, v]) => ({ ...v, _key: k, _wsId: wsId, _wsName: wsName }));
    allTasks.push(...wsTasks);
    allEvents.push(...wsEvents);
  });

  const overdueTasks = allTasks
    .filter(t => t.status !== 'done' && t.dueAt && t.dueAt < todayStart)
    .sort((a, b) => a.dueAt - b.dueAt);

  const todayTasks = allTasks
    .filter(t => t.status !== 'done' && t.dueAt && t.dueAt >= todayStart && t.dueAt < todayEnd)
    .sort((a, b) => a.dueAt - b.dueAt);

  const upcomingEvents = allEvents
    .filter(e => e.startAt >= todayStart && e.startAt < weekEnd)
    .sort((a, b) => a.startAt - b.startAt);

  // Per-person index using multi-assignee support
  const byPerson = {};
  [...overdueTasks, ...todayTasks].forEach(t => {
    const people = getAssigneeArr(t);
    if (!people.length) people.push('Unassigned');
    people.forEach(p => {
      if (!byPerson[p]) byPerson[p] = { tasks: [], events: [] };
      byPerson[p].tasks.push(t);
    });
  });
  upcomingEvents.forEach(e => {
    const people = getAssigneeArr(e);
    people.forEach(p => {
      if (!byPerson[p]) byPerson[p] = { tasks: [], events: [] };
      byPerson[p].events.push(e);
    });
  });

  const html    = buildEmailHTML({ overdueTasks, todayTasks, upcomingEvents, byPerson });
  const subject = `TaskQ Daily Report -- ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`;

  const transporter = createTransport(smtpPassword);
  const fromName  = emailCfg.fromName  || 'TaskQ Daily';
  const fromEmail = emailCfg.fromEmail || SMTP_USER;

  await transporter.sendMail({
    from:    `"${fromName}" <${fromEmail}>`,
    to:      recipients.join(', '),
    subject,
    html
  });

  console.log(`Report sent to ${recipients.length} recipient(s) via MXRoute SMTP.`);
  return { sent: true, recipients: recipients.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled function -- runs daily at 7 AM Central
// ─────────────────────────────────────────────────────────────────────────────

exports.scheduledEmailReport = onSchedule(
  {
    schedule:  '0 7 * * *',
    timeZone:  'America/Chicago',
    secrets:   [SMTP_PASSWORD],
  },
  async () => {
    await buildAndSendReport(SMTP_PASSWORD.value());
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// HTTP function -- "Send Now" triggered from TaskQ UI
// ─────────────────────────────────────────────────────────────────────────────

exports.sendEmailNow = onRequest(
  {
    secrets:   [SMTP_PASSWORD],
    cors:      true,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      const result = await buildAndSendReport(SMTP_PASSWORD.value());
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('sendEmailNow error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Inbound email-to-task -- receives forwarded emails from MXRoute
// Expects multipart form data or JSON with: from, subject, text, html
// ─────────────────────────────────────────────────────────────────────────────

exports.inboundEmail = onRequest(
  { cors: false },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method not allowed');
      return;
    }
    try {
      // Parse inbound email fields (supports both JSON and form-encoded)
      const body    = req.body || {};
      const subject = body.subject || body.Subject || 'Emailed Task';
      const from    = body.from    || body.From    || '';
      const text    = body.text    || body['stripped-text'] || body.Text || '';

      // Extract sender name from "Name <email>" format
      const nameMatch = from.match(/^([^<]+)</);
      const senderName = nameMatch ? nameMatch[1].trim() : from.split('@')[0];

      // Determine target workspace (default to first workspace)
      const wsSnap = await db.ref('workspaces').once('value');
      const workspaces = wsSnap.val() || {};
      const wsIds = Object.keys(workspaces);
      if (!wsIds.length) {
        res.status(400).json({ error: 'No workspaces found' });
        return;
      }

      // Use first workspace, or check subject for [WS:name] tag
      let targetWsId = wsIds[0];
      const wsTag = subject.match(/\[WS:([^\]]+)\]/i);
      if (wsTag) {
        const tagName = wsTag[1].toLowerCase();
        const match = wsIds.find(id => {
          const settings = workspaces[id].settings || {};
          return (settings.subtitle || id).toLowerCase().includes(tagName);
        });
        if (match) targetWsId = match;
      }

      // Clean up subject (remove [WS:...] tag if present)
      const cleanSubject = subject.replace(/\[WS:[^\]]+\]\s*/i, '').trim();

      // Count existing tasks for ID generation
      const tasksSnap = await db.ref(`workspaces/${targetWsId}/tasks`).once('value');
      const existingTasks = tasksSnap.val() || {};
      const num = Object.keys(existingTasks).length + 1;

      // Get default category
      const settingsSnap = await db.ref(`workspaces/${targetWsId}/settings`).once('value');
      const wsCfg = settingsSnap.val() || {};
      const categories = wsCfg.categories || [];
      const defaultCat = categories.length ? categories[0].id : 'other';

      // Create the task
      const taskData = {
        id:        'T-' + String(num).padStart(3, '0'),
        name:      cleanSubject.substring(0, 80),
        assignees: senderName ? [senderName] : null,
        category:  defaultCat,
        createdAt: Date.now(),
        dueAt:     null,
        notes:     text ? text.substring(0, 1000) : null,
        status:    'active',
        doneAt:    null
      };

      await db.ref(`workspaces/${targetWsId}/tasks`).push(taskData);
      console.log(`Inbound email created task "${cleanSubject}" in workspace ${targetWsId}`);
      res.json({ success: true, task: taskData.name, workspace: targetWsId });
    } catch (err) {
      console.error('inboundEmail error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// IMAP Inbox Polling — scheduled every 5 minutes
// Pulls unseen messages from taskq@qponent.com, authenticates sender via DKIM,
// looks up matching TaskQ user by email, creates tasks or calendar events.
// ─────────────────────────────────────────────────────────────────────────────

const IMAP_HOST = 'chocobo.mxrouting.net';
const IMAP_PORT = 993;
const IMAP_USER = 'taskq@qponent.com';

// Verify DKIM cryptographically from the raw message source.
// Returns { ok, summary } where ok=true if any DKIM signature passed.
async function verifyDkim(rawSource) {
  try {
    const result = await authenticate(rawSource, { trustReceived: false });
    const dkim = result?.dkim?.results || [];
    const anyPass = dkim.some(r => r.status?.result === 'pass');
    const summary = dkim.map(r => `${r.signingDomain || '?'}=${r.status?.result || '?'}`).join(', ');
    return { ok: anyPass, summary: summary || 'no DKIM signatures found' };
  } catch (err) {
    return { ok: false, summary: 'verify error: ' + err.message };
  }
}

// Strip RFC 5322 display name, return lowercase bare address
function bareEmail(addrField) {
  if (!addrField) return null;
  const val = addrField.value?.[0]?.address || addrField.text || String(addrField);
  const m = String(val).match(/[\w.+-]+@[\w.-]+\.\w+/);
  return m ? m[0].toLowerCase() : null;
}

async function resolveUidByEmail(email) {
  try {
    const rec = await admin.auth().getUserByEmail(email);
    return rec.uid;
  } catch (err) {
    return null;
  }
}

async function pickWorkspaceForUser(uid, subject) {
  const wsSnap = await db.ref(`users/${uid}/workspaces`).once('value');
  const wsList = wsSnap.val() || {};
  const entries = Object.entries(wsList);
  if (!entries.length) return null;
  // Look for [WS:name] tag in subject
  const tag = (subject || '').match(/\[WS:([^\]]+)\]/i);
  if (tag) {
    const want = tag[1].trim().toUpperCase();
    const hit = entries.find(([, v]) => (v.name || '').toUpperCase() === want);
    if (hit) return hit[0];
  }
  // Oldest workspace first (matches UI default)
  entries.sort(([, a], [, b]) => (a.createdAt || 0) - (b.createdAt || 0));
  return entries[0][0];
}

function cleanSubjectForTitle(subject) {
  return (subject || '(No subject)')
    .replace(/\[WS:[^\]]+\]/gi, '')
    .replace(/^\s*(Re:|Fwd?:)\s*/gi, '')
    .trim();
}

// Parse structured tags from subject line. Returns { cleanSubject, fields }.
// Supported: [WS:name] [A:a,b] [@a] [DUE:...] [D:...] [C:cat] [!] [URGENT] [*] [HIGH] [EVENT]
function parseSubjectTags(subject) {
  const raw = subject || '';
  const fields = {
    ws: null,
    assignees: [],
    due: null,
    category: null,
    urgent: false,
    highPriority: false,
    forceEvent: false,
  };
  let s = raw;
  const addAssignees = (str) => {
    String(str).split(',').map(x => x.trim()).filter(Boolean).forEach(a => {
      if (!fields.assignees.includes(a)) fields.assignees.push(a);
    });
  };
  const eatFirst = (re) => {
    const m = s.match(re);
    if (m) { s = s.replace(m[0], ' '); return m; }
    return null;
  };
  // Bracketed tags — run each matcher until no more matches
  const patterns = [
    { re: /\[WS:([^\]]+)\]/i, on: (m) => { fields.ws = m[1].trim(); } },
    { re: /\[A:([^\]]+)\]/i,  on: (m) => { addAssignees(m[1]); } },
    { re: /\[@([^\]]+)\]/i,   on: (m) => { addAssignees(m[1]); } },
    { re: /\[DUE:([^\]]+)\]/i, on: (m) => { fields.due = m[1].trim(); } },
    { re: /\[D:([^\]]+)\]/i,   on: (m) => { fields.due = m[1].trim(); } },
    { re: /\[C:([^\]]+)\]/i,   on: (m) => { fields.category = m[1].trim(); } },
    { re: /\[URGENT\]/i,  on: () => { fields.urgent = true; } },
    { re: /\[!\]/,         on: () => { fields.urgent = true; } },
    { re: /\[HIGH\]/i,    on: () => { fields.highPriority = true; } },
    { re: /\[\*\]/,        on: () => { fields.highPriority = true; } },
    { re: /\[EVENT\]/i,   on: () => { fields.forceEvent = true; } },
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of patterns) {
      const m = eatFirst(p.re);
      if (m) { p.on(m); changed = true; }
    }
  }
  const cleanSubject = s
    .replace(/^\s*(Re:|Fwd?:)\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || '(No subject)';
  return { cleanSubject, fields };
}

// Parse body header block: keyword lines before first blank / separator.
// Returns { fields, bodyRest }.
function parseBodyHeader(bodyText) {
  const fields = {
    assignees: [],
    due: null,
    category: null,
    urgent: null,
    highPriority: null,
    forceEvent: false,
    ws: null,
  };
  const rawBody = String(bodyText || '');
  const lines = rawBody.split(/\r?\n/);
  const keywordRe = /^\s*(assignee|assignees|assigned to|due|due date|category|cat|urgent|priority|high priority|workspace|ws|event)\s*:\s*(.+)$/i;
  const separatorRe = /^\s*(---+|===+|\*\*\*+)\s*$/;
  let headerEnd = -1;
  let seenAnyKeyword = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (separatorRe.test(ln)) { headerEnd = i; break; }
    if (ln.trim() === '') {
      if (seenAnyKeyword) { headerEnd = i; break; }
      continue; // allow leading blank lines
    }
    if (!keywordRe.test(ln)) {
      if (seenAnyKeyword) { headerEnd = i - 1; break; }
      // No keyword yet, not a keyword line, not blank — there's no header
      headerEnd = -1;
      break;
    }
    const m = ln.match(keywordRe);
    seenAnyKeyword = true;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'assignee' || key === 'assignees' || key === 'assigned to') {
      val.split(',').map(x => x.trim()).filter(Boolean).forEach(a => {
        if (!fields.assignees.includes(a)) fields.assignees.push(a);
      });
    } else if (key === 'due' || key === 'due date') {
      fields.due = val;
    } else if (key === 'category' || key === 'cat') {
      fields.category = val;
    } else if (key === 'urgent') {
      fields.urgent = /^(yes|y|true|1|!)$/i.test(val);
    } else if (key === 'priority' || key === 'high priority') {
      fields.highPriority = /^(yes|y|true|1|high|hi|\*)$/i.test(val);
    } else if (key === 'workspace' || key === 'ws') {
      fields.ws = val;
    } else if (key === 'event') {
      fields.forceEvent = /^(yes|y|true|1)$/i.test(val);
    }
  }
  const bodyRest = (headerEnd >= 0) ? lines.slice(headerEnd + 1).join('\n').replace(/^\s+/, '') : rawBody;
  return { fields, bodyRest };
}

// Merge: subject tags win over body header.
function mergeFields(subjFields, bodyFields) {
  const assignees = [];
  (subjFields.assignees || []).forEach(a => { if (!assignees.includes(a)) assignees.push(a); });
  (bodyFields.assignees || []).forEach(a => { if (!assignees.includes(a)) assignees.push(a); });
  return {
    ws:           subjFields.ws            || bodyFields.ws            || null,
    assignees:    assignees,
    due:          subjFields.due           || bodyFields.due           || null,
    category:     subjFields.category      || bodyFields.category      || null,
    urgent:       subjFields.urgent        || !!bodyFields.urgent      || false,
    highPriority: subjFields.highPriority  || !!bodyFields.highPriority|| false,
    forceEvent:   subjFields.forceEvent    || bodyFields.forceEvent    || false,
  };
}

function parseNaturalDate(str, refDate) {
  if (!str) return null;
  const results = chrono.parse(str, refDate || new Date(), { forwardDate: true });
  if (!results || !results.length) return null;
  return results[0].start ? results[0].start.date().getTime() : null;
}

// Case-insensitive match against a list; returns the canonical value if found.
function matchIgnoreCase(want, list) {
  if (!want || !Array.isArray(list)) return null;
  const w = String(want).trim().toLowerCase();
  return list.find(x => String(x).trim().toLowerCase() === w) || null;
}

// Send an acknowledgment reply, threaded to the original message.
async function sendAck(smtpPassword, toEmail, origSubject, origMessageId, bodyLines, ok) {
  if (!toEmail) return;
  try {
    const transport = createTransport(smtpPassword);
    const subj = (ok ? '✓ ' : '✗ ') + 'Re: ' + (origSubject || '(No subject)').replace(/^\s*Re:\s*/i, '');
    const headers = {};
    if (origMessageId) {
      headers['In-Reply-To'] = origMessageId;
      headers['References']  = origMessageId;
    }
    await transport.sendMail({
      from: `"TaskQ" <${SMTP_USER}>`,
      to: toEmail,
      subject: subj,
      text: bodyLines.join('\n'),
      headers
    });
  } catch (err) {
    console.warn('sendAck failed:', err.message);
  }
}

function fmtAckDate(ts) {
  if (!ts) return '(none)';
  return new Date(ts).toLocaleString('en-US', {
    timeZone: DEFAULT_TZ,
    weekday: 'short', month: 'short', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

async function resolveWorkspaceByName(uid, name) {
  if (!name) return null;
  const wsSnap = await db.ref(`users/${uid}/workspaces`).once('value');
  const wsList = wsSnap.val() || {};
  const want = String(name).trim().toUpperCase();
  const hit = Object.entries(wsList).find(([, v]) => (v.name || '').toUpperCase() === want);
  return hit ? hit[0] : null;
}

async function uploadAttachmentsToStorage(attachments, wsId, taskKey) {
  if (!attachments || !attachments.length) return [];
  const bucket = admin.storage().bucket();
  const files = [];
  for (const att of attachments) {
    if (!att.content || !att.filename) continue;
    // Skip calendar attachments (handled separately)
    if (/\.ics$/i.test(att.filename) || att.contentType === 'text/calendar') continue;
    const safe = att.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `workspaces/${wsId}/tasks/${taskKey}/${Date.now()}_${safe}`;
    const fileRef = bucket.file(path);
    await fileRef.save(att.content, {
      metadata: { contentType: att.contentType || 'application/octet-stream' }
    });
    // Make publicly readable download URL via getSignedUrl (long-lived)
    const [url] = await fileRef.getSignedUrl({
      action: 'read',
      expires: '03-01-2500'
    });
    files.push({
      name: att.filename,
      url,
      path,
      size: att.size || (att.content && att.content.length) || 0,
      type: att.contentType || ''
    });
  }
  return files;
}

function extractIcsEvents(attachments, htmlOrText) {
  const events = [];
  const buffers = [];
  (attachments || []).forEach(att => {
    if (/\.ics$/i.test(att.filename || '') || att.contentType === 'text/calendar') {
      if (att.content) buffers.push(att.content.toString('utf8'));
    }
  });
  for (const buf of buffers) {
    try {
      const parsed = ical.sync.parseICS(buf);
      for (const k of Object.keys(parsed)) {
        const item = parsed[k];
        if (item.type === 'VEVENT') events.push(item);
      }
    } catch (e) {
      console.warn('Bad ICS:', e.message);
    }
  }
  return events;
}

async function createEventFromIcs(uid, wsId, vevent, fromEmail, fields) {
  fields = fields || {};
  const start = new Date(vevent.start).getTime();
  const end = vevent.end ? new Date(vevent.end).getTime() : start + 3600000;
  const isAllDay =
    (typeof vevent.start === 'string' && !vevent.start.includes('T')) ||
    (vevent.datetype === 'date');
  // Resolve category against workspace settings
  const settingsSnap = await db.ref(`workspaces/${wsId}/settings`).once('value');
  const settings = settingsSnap.val() || {};
  const catList = settings.categories || [];
  const assigneeList = settings.assignees || [];
  const category = matchIgnoreCase(fields.category, catList) || 'Appointments';
  const assignees = (fields.assignees || [])
    .map(a => matchIgnoreCase(a, assigneeList) || a)
    .filter(Boolean);
  const data = {
    title: (vevent.summary || '(No title)').toString(),
    description: vevent.description ? String(vevent.description) : null,
    allDay: !!isAllDay,
    startAt: start,
    endAt: end,
    category,
    location: vevent.location ? String(vevent.location) : null,
    assignees: assignees.length ? assignees : null,
    assignee: null,
    estimatedBudget: null,
    expenseCategory: null,
    recurrence: null,
    recurEnd: null,
    source: 'email',
    sourceFrom: fromEmail
  };
  const ref = await db.ref(`workspaces/${wsId}/events`).push(data);
  return ref.key;
}

async function createEventFromFields(uid, wsId, title, description, fields, fromEmail) {
  const startAt = parseNaturalDate(fields.due);
  if (!startAt) return null;
  const settingsSnap = await db.ref(`workspaces/${wsId}/settings`).once('value');
  const settings = settingsSnap.val() || {};
  const catList = settings.categories || [];
  const assigneeList = settings.assignees || [];
  const category = matchIgnoreCase(fields.category, catList) || 'Appointments';
  const assignees = (fields.assignees || [])
    .map(a => matchIgnoreCase(a, assigneeList) || a)
    .filter(Boolean);
  const endAt = startAt + 3600000;
  const data = {
    title,
    description: description || null,
    allDay: false,
    startAt,
    endAt,
    category,
    location: null,
    assignees: assignees.length ? assignees : null,
    assignee: null,
    estimatedBudget: null,
    expenseCategory: null,
    recurrence: null,
    recurEnd: null,
    source: 'email',
    sourceFrom: fromEmail
  };
  const ref = await db.ref(`workspaces/${wsId}/events`).push(data);
  return ref.key;
}

async function createTaskFromEmail(uid, wsId, cleanName, bodyText, fromEmail, fields) {
  fields = fields || {};
  const tasksRef = db.ref(`workspaces/${wsId}/tasks`);
  const existingSnap = await tasksRef.once('value');
  const num = (existingSnap.numChildren() || 0) + 1;
  const settingsSnap = await db.ref(`workspaces/${wsId}/settings`).once('value');
  const settings = settingsSnap.val() || {};
  const catList = settings.categories || [];
  const assigneeList = settings.assignees || [];
  const category = matchIgnoreCase(fields.category, catList) || catList[0] || 'General';
  const dueAt = parseNaturalDate(fields.due);
  const assignees = (fields.assignees || [])
    .map(a => matchIgnoreCase(a, assigneeList) || a)
    .filter(Boolean);
  const taskData = {
    id: 'T-' + String(num).padStart(3, '0'),
    name: cleanName,
    assignees: assignees.length ? assignees : null,
    category,
    createdAt: Date.now(),
    dueAt: dueAt || null,
    urgent: fields.urgent ? true : null,
    highPriority: fields.highPriority ? true : null,
    status: 'active',
    doneAt: null,
    description: bodyText ? String(bodyText).slice(0, 2000) : null,
    source: 'email',
    sourceFrom: fromEmail
  };
  const ref = await tasksRef.push(taskData);
  return ref.key;
}

async function processOneMessage(client, uid, mailbox, seq) {
  const fetched = await client.fetchOne(seq, { source: true, envelope: true });
  if (!fetched) return { skipped: true, reason: 'not found' };
  const parsed = await simpleParser(fetched.source);
  const subject = parsed.subject || '';
  const fromEmail = bareEmail(parsed.from);
  const wsId = await pickWorkspaceForUser(uid, subject);
  if (!wsId) return { skipped: true, reason: 'no workspace' };
  const vevents = extractIcsEvents(parsed.attachments, parsed.html || parsed.text);
  if (vevents.length) {
    for (const ve of vevents) {
      await createEventFromIcs(uid, wsId, ve, fromEmail);
    }
    return { type: 'event', count: vevents.length, wsId };
  }
  const bodyText = parsed.text || (parsed.html ? parsed.html.replace(/<[^>]+>/g, ' ') : '');
  const taskKey = await createTaskFromEmail(uid, wsId, subject, bodyText, fromEmail);
  const fileMeta = await uploadAttachmentsToStorage(parsed.attachments, wsId, taskKey);
  if (fileMeta.length) {
    await db.ref(`workspaces/${wsId}/tasks/${taskKey}/files`).set(fileMeta);
  }
  return { type: 'task', key: taskKey, files: fileMeta.length, wsId };
}

exports.pollInbox = onSchedule(
  {
    schedule: 'every 5 minutes',
    timeZone: 'America/Chicago',
    secrets: [SMTP_PASSWORD],
    timeoutSeconds: 300,
    memory: '512MiB'
  },
  async () => {
    const client = new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: true,
      auth: { user: IMAP_USER, pass: SMTP_PASSWORD.value() },
      logger: false
    });
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let processed = 0, skipped = 0, errors = 0;
    try {
      const unseen = await client.search({ seen: false }, { uid: true });
      for (const uid of unseen || []) {
        try {
          const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
          if (!msg) { skipped++; continue; }
          const parsed = await simpleParser(msg.source);
          const fromEmail = bareEmail(parsed.from);
          const dkimResult = await verifyDkim(msg.source);
          const dkimOk = dkimResult.ok;
          console.log(`DKIM check for ${fromEmail}: ${dkimOk ? 'pass' : 'fail'} [${dkimResult.summary}]`);
          const origSubject = parsed.subject || '';
          const origMsgId   = parsed.messageId || null;
          const smtpPass    = SMTP_PASSWORD.value();
          if (!fromEmail) {
            console.log('No from address, marking seen');
            await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
            skipped++;
            continue;
          }
          if (!dkimOk) {
            console.log(`DKIM did not pass for ${fromEmail}, rejecting`);
            await sendAck(smtpPass, fromEmail, origSubject, origMsgId, [
              'TaskQ could not process your email.',
              '',
              'Reason: DKIM signature did not verify. For security, TaskQ only accepts',
              'mail whose authenticity can be confirmed by cryptographic signature.',
              '',
              `DKIM results: ${dkimResult.summary}`,
              '',
              'If you sent this from Gmail, Outlook, or iCloud and still see this,',
              'try resending directly (not forwarded through another service).'
            ], false);
            await client.messageFlagsAdd(uid, ['\\Seen', '\\Flagged'], { uid: true });
            skipped++;
            continue;
          }
          const userUid = await resolveUidByEmail(fromEmail);
          if (!userUid) {
            console.log(`No TaskQ user for ${fromEmail}, rejecting`);
            await sendAck(smtpPass, fromEmail, origSubject, origMsgId, [
              'TaskQ could not process your email.',
              '',
              `Reason: Sender ${fromEmail} is not a registered TaskQ user.`,
              '',
              'To use TaskQ email intake, the sending address must match the email',
              'address on your TaskQ account.'
            ], false);
            await client.messageFlagsAdd(uid, ['\\Seen', '\\Flagged'], { uid: true });
            skipped++;
            continue;
          }
          // Parse structured fields from subject and body header
          const subjParsed = parseSubjectTags(parsed.subject);
          const rawBody = parsed.text || (parsed.html ? parsed.html.replace(/<[^>]+>/g, ' ') : '');
          const bodyParsed = parseBodyHeader(rawBody);
          const fields = mergeFields(subjParsed.fields, bodyParsed.fields);
          // Workspace: explicit -> resolve by name; else default
          let wsId = null;
          if (fields.ws) {
            wsId = await resolveWorkspaceByName(userUid, fields.ws);
            if (!wsId) console.log(`Workspace "${fields.ws}" not found, falling back to default`);
          }
          if (!wsId) wsId = await pickWorkspaceForUser(userUid, parsed.subject);
          if (!wsId) {
            console.log(`No workspace for uid ${userUid}`);
            await sendAck(smtpPass, fromEmail, origSubject, origMsgId, [
              'TaskQ could not process your email.',
              '',
              'Reason: Your TaskQ account has no workspaces yet.',
              '',
              'Open TaskQ in your browser and create a workspace, then try again.'
            ], false);
            await client.messageFlagsAdd(uid, ['\\Seen', '\\Flagged'], { uid: true });
            skipped++;
            continue;
          }
          // Look up the workspace name for the ack
          const wsNameSnap = await db.ref(`users/${userUid}/workspaces/${wsId}/name`).once('value');
          const wsNameForAck = wsNameSnap.val() || wsId;

          const vevents = extractIcsEvents(parsed.attachments);
          if (vevents.length) {
            for (const ve of vevents) await createEventFromIcs(userUid, wsId, ve, fromEmail, fields);
            console.log(`Created ${vevents.length} event(s) for ${fromEmail} in ${wsId}`);
            const ve = vevents[0];
            const startTs = new Date(ve.start).getTime();
            await sendAck(smtpPass, fromEmail, origSubject, origMsgId, [
              `Calendar event created in ${wsNameForAck}.`,
              '',
              `Title:    ${String(ve.summary || '(No title)')}`,
              `Starts:   ${fmtAckDate(startTs)}`,
              ve.location ? `Location: ${ve.location}` : null,
              vevents.length > 1 ? `Also created: ${vevents.length - 1} additional event(s).` : null,
              '',
              'View in TaskQ: https://drtquick.github.io/taskq/'
            ].filter(Boolean), true);
          } else if (fields.forceEvent && fields.due) {
            const evKey = await createEventFromFields(userUid, wsId, subjParsed.cleanSubject, bodyParsed.bodyRest, fields, fromEmail);
            const startTs = parseNaturalDate(fields.due);
            console.log(`Created forced event ${evKey} in ${wsId} for ${fromEmail}`);
            await sendAck(smtpPass, fromEmail, origSubject, origMsgId, [
              `Calendar event created in ${wsNameForAck}.`,
              '',
              `Title:  ${subjParsed.cleanSubject}`,
              `Starts: ${fmtAckDate(startTs)}`,
              '',
              'View in TaskQ: https://drtquick.github.io/taskq/'
            ], true);
          } else {
            const taskKey = await createTaskFromEmail(userUid, wsId, subjParsed.cleanSubject, bodyParsed.bodyRest, fromEmail, fields);
            const fileMeta = await uploadAttachmentsToStorage(parsed.attachments, wsId, taskKey);
            if (fileMeta.length) {
              await db.ref(`workspaces/${wsId}/tasks/${taskKey}/files`).set(fileMeta);
            }
            console.log(`Created task in ${wsId} for ${fromEmail} (files: ${fileMeta.length}, due: ${fields.due || 'none'}, assignees: ${fields.assignees.join(',') || 'none'})`);
            const dueTs = parseNaturalDate(fields.due);
            const lines = [
              `Task created in ${wsNameForAck}.`,
              '',
              `Title:     ${subjParsed.cleanSubject}`,
              `Assignees: ${fields.assignees.length ? fields.assignees.join(', ') : '(none)'}`,
              `Category:  ${fields.category || '(default)'}`,
              `Due:       ${dueTs ? fmtAckDate(dueTs) : '(none)'}`,
              `Urgent:    ${fields.urgent ? 'yes' : 'no'}`,
              `Priority:  ${fields.highPriority ? 'high' : 'normal'}`,
              fileMeta.length ? `Attachments: ${fileMeta.length}` : null,
              '',
              'View in TaskQ: https://drtquick.github.io/taskq/'
            ].filter(Boolean);
            await sendAck(smtpPass, fromEmail, origSubject, origMsgId, lines, true);
          }
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          processed++;
        } catch (e) {
          console.error(`Error processing uid ${uid}:`, e);
          errors++;
        }
      }
    } finally {
      lock.release();
      await client.logout();
    }
    console.log(`pollInbox done: processed=${processed} skipped=${skipped} errors=${errors}`);
  }
);
