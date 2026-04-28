// v2.4 - api.taskq.qponent.com routing
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
const twilio           = require('twilio');

const DEFAULT_TZ = 'America/Chicago';

admin.initializeApp();
const db = admin.database();

const SMTP_PASSWORD       = defineSecret('SMTP_PASSWORD');
const TWILIO_ACCOUNT_SID  = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN   = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_PHONE_NUMBER = defineSecret('TWILIO_PHONE_NUMBER');

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

// Build a personalized report email for one member in one workspace.
// Applies categoryFilter (list of category ids); if empty/null, includes all categories.
async function buildAndSendPersonalizedReport(smtpPassword, uid, email, wsIdsWithConfig) {
  const [usersSnap, wsSnap] = await Promise.all([
    db.ref('users').once('value'),
    db.ref('workspaces').once('value'),
  ]);
  const users = usersSnap.val() || {};
  const workspaces = wsSnap.val() || {};
  const wsNameById = {};
  Object.values(users).forEach(userData => {
    const userWs = userData?.workspaces || {};
    Object.entries(userWs).forEach(([wsId, entry]) => {
      if (entry?.name && !wsNameById[wsId]) wsNameById[wsId] = entry.name;
    });
  });

  const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
  const todayStart = todayMidnight.getTime();
  const todayEnd   = todayStart + 86400000;
  const weekEnd    = todayStart + 7 * 86400000;

  const allTasks = [];
  const allEvents = [];
  for (const { wsId, categoryFilter } of wsIdsWithConfig) {
    const wsData = workspaces[wsId];
    if (!wsData) continue;
    const wsName = wsNameById[wsId] || wsData.settings?.subtitle || wsId;
    const filterSet = Array.isArray(categoryFilter) && categoryFilter.length ? new Set(categoryFilter.map(String)) : null;
    Object.entries(wsData.tasks || {}).forEach(([k, v]) => {
      if (filterSet && !filterSet.has(String(v.category))) return;
      allTasks.push({ ...v, _key: k, _wsId: wsId, _wsName: wsName });
    });
    Object.entries(wsData.events || {}).forEach(([k, v]) => {
      if (filterSet && !filterSet.has(String(v.category))) return;
      allEvents.push({ ...v, _key: k, _wsId: wsId, _wsName: wsName });
    });
  }
  if (!allTasks.length && !allEvents.length) {
    console.log(`No matching items for ${email}; skipping send.`);
    return { skipped: true };
  }
  const overdueTasks = allTasks
    .filter(t => t.status !== 'done' && t.dueAt && t.dueAt < todayStart)
    .sort((a, b) => a.dueAt - b.dueAt);
  const todayTasks = allTasks
    .filter(t => t.status !== 'done' && t.dueAt && t.dueAt >= todayStart && t.dueAt < todayEnd)
    .sort((a, b) => a.dueAt - b.dueAt);
  const upcomingEvents = allEvents
    .filter(e => e.startAt >= todayStart && e.startAt < weekEnd)
    .sort((a, b) => a.startAt - b.startAt);
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
  await transporter.sendMail({
    from: `"TaskQ Daily" <${SMTP_USER}>`,
    to: email,
    subject,
    html
  });
  console.log(`Personalized report sent to ${email} covering ${wsIdsWithConfig.length} workspace(s).`);
  return { sent: true, to: email };
}

// Gather all members whose reportConfig matches the given hour (local time).
// Returns array of { uid, email, wsList: [{wsId, categoryFilter}] }
async function collectMembersForHour(hour) {
  const wsSnap = await db.ref('workspaces').once('value');
  const workspaces = wsSnap.val() || {};
  const byUid = {};
  for (const [wsId, wsData] of Object.entries(workspaces)) {
    const members = wsData?.members || {};
    for (const [uid, m] of Object.entries(members)) {
      const rc = m?.reportConfig || {};
      if (!rc.enabled) continue;
      const memberHour = Number.isFinite(+rc.sendHour) ? +rc.sendHour : 7;
      if (hour != null && memberHour !== hour) continue;
      if (!byUid[uid]) byUid[uid] = { uid, email: m.email, wsList: [] };
      byUid[uid].wsList.push({ wsId, categoryFilter: rc.categoryFilter || null });
      if (!byUid[uid].email && m.email) byUid[uid].email = m.email;
    }
  }
  return Object.values(byUid).filter(x => x.email);
}

exports.scheduledEmailReport = onSchedule(
  {
    schedule:  '0 * * * *',
    timeZone:  'America/Chicago',
    secrets:   [SMTP_PASSWORD],
  },
  async () => {
    // Determine local hour in America/Chicago
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: DEFAULT_TZ, hour: 'numeric', hour12: false }).formatToParts(new Date());
    const hourPart = parts.find(p => p.type === 'hour');
    const hour = hourPart ? parseInt(hourPart.value, 10) % 24 : 7;
    const members = await collectMembersForHour(hour);
    console.log(`scheduledEmailReport at hour ${hour}: ${members.length} member(s) match`);
    for (const m of members) {
      try {
        await buildAndSendPersonalizedReport(SMTP_PASSWORD.value(), m.uid, m.email, m.wsList);
      } catch (e) {
        console.error(`Failed to send to ${m.email}:`, e);
      }
    }
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
      // If the caller is authed, send a personalized report to them across all workspaces they belong to.
      const authHeader = req.get('Authorization') || '';
      const match = authHeader.match(/^Bearer\s+(.+)$/);
      if (match) {
        try {
          const decoded = await admin.auth().verifyIdToken(match[1]);
          const uid = decoded.uid;
          const email = decoded.email;
          const wsSnap = await db.ref('workspaces').once('value');
          const workspaces = wsSnap.val() || {};
          const wsList = [];
          for (const [wsId, wsData] of Object.entries(workspaces)) {
            const m = wsData?.members?.[uid];
            if (!m) continue;
            wsList.push({ wsId, categoryFilter: m.reportConfig?.categoryFilter || null });
          }
          if (wsList.length && email) {
            const result = await buildAndSendPersonalizedReport(SMTP_PASSWORD.value(), uid, email, wsList);
            res.json({ success: true, ...result });
            return;
          }
        } catch (e) {
          console.warn('sendEmailNow: auth provided but lookup failed, falling back to legacy');
        }
      }
      // Legacy fallback: fire the old global-settings report.
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
// Handles both strings and TaskQ category objects { id, label, ... }.
function matchIgnoreCase(want, list) {
  if (!want || !Array.isArray(list)) return null;
  const w = String(want).trim().toLowerCase();
  for (const x of list) {
    if (x == null) continue;
    if (typeof x === 'string') {
      if (x.trim().toLowerCase() === w) return x;
    } else if (typeof x === 'object') {
      // Category objects: check id and label; return id (what TaskQ stores on tasks)
      if (String(x.id || '').toLowerCase() === w) return x.id;
      if (String(x.label || '').toLowerCase() === w) return x.id;
    }
  }
  return null;
}

// First string value from a list of strings or {id,label,...} objects.
function firstStringValue(list) {
  if (!Array.isArray(list)) return null;
  for (const x of list) {
    if (typeof x === 'string' && x.trim()) return x;
    if (x && typeof x === 'object' && typeof x.id === 'string') return x.id;
  }
  return null;
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
    .map(a => matchIgnoreCase(a, assigneeList) || (typeof a === 'string' ? a : null))
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
    .map(a => matchIgnoreCase(a, assigneeList) || (typeof a === 'string' ? a : null))
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
  const category = matchIgnoreCase(fields.category, catList) || firstStringValue(catList) || 'General';
  const dueAt = parseNaturalDate(fields.due);
  const assignees = (fields.assignees || [])
    .map(a => matchIgnoreCase(a, assigneeList) || (typeof a === 'string' ? a : null))
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

// ─────────────────────────────────────────────────────────────────────────────
// Daily Database Backup — writes a full snapshot of the Realtime Database
// to Cloud Storage each morning. Retains 30 days of rolling backups.
// Storage path: gs://<default-bucket>/db-backups/YYYY-MM-DD.json
// ─────────────────────────────────────────────────────────────────────────────

exports.dailyBackup = onSchedule(
  {
    schedule: '0 4 * * *',
    timeZone: 'America/Chicago',
    timeoutSeconds: 540,
    memory: '512MiB'
  },
  async () => {
    const snap = await db.ref('/').once('value');
    const data = snap.val() || {};
    const json = JSON.stringify(data);
    const bucket = admin.storage().bucket('taskq-80ce7-backups');
    const now = new Date();
    const stamp = now.toISOString().slice(0, 10);
    const path = `db-backups/${stamp}.json`;
    const file = bucket.file(path);
    await file.save(Buffer.from(json, 'utf8'), {
      metadata: { contentType: 'application/json' }
    });
    console.log(`Saved DB backup: ${path} (${json.length} bytes)`);

    // Retention: prune backups older than 30 days
    const [files] = await bucket.getFiles({ prefix: 'db-backups/' });
    const cutoff = Date.now() - 30 * 86400000;
    let pruned = 0;
    for (const f of files) {
      const m = f.name.match(/db-backups\/(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) continue;
      const ts = Date.parse(m[1] + 'T00:00:00Z');
      if (!isNaN(ts) && ts < cutoff) {
        await f.delete().catch(() => {});
        pruned++;
      }
    }
    console.log(`Pruned ${pruned} backup(s) older than 30 days.`);
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Admin / Membership Functions
// Workspace members live at workspaces/{wsId}/members/{uid} = {
//   email, role: 'admin'|'member', addedAt, addedBy, reportConfig: { enabled, sendHour, categoryFilter }
// }
// Locks at workspaces/{wsId}/locks = { assignees, categories, subtitle, urgentFlag } (booleans)
// ─────────────────────────────────────────────────────────────────────────────

// Verify the caller is an admin of the workspace. Throws on failure.
async function assertAdmin(req, wsId) {
  const authHeader = req.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/);
  if (!match) throw new Error('Missing Authorization header');
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(match[1]);
  } catch (e) {
    throw new Error('Invalid auth token');
  }
  const callerUid = decoded.uid;
  const memberSnap = await db.ref(`workspaces/${wsId}/members/${callerUid}`).once('value');
  const member = memberSnap.val();
  if (!member || member.role !== 'admin') throw new Error('Caller is not an admin of this workspace');
  return { uid: callerUid, email: decoded.email };
}

// Read JSON body regardless of content-type
function getBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

exports.inviteUserToWorkspace = onRequest(
  { cors: true },
  async (req, res) => {
    try {
      if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
      const body = getBody(req);
      const { wsId, email, role } = body;
      if (!wsId || !email || !['admin', 'member'].includes(role)) {
        res.status(400).json({ error: 'wsId, email, role required (role: admin or member)' });
        return;
      }
      const caller = await assertAdmin(req, wsId);
      // Look up target user by email (must exist)
      let target;
      try {
        target = await admin.auth().getUserByEmail(String(email).trim().toLowerCase());
      } catch {
        res.status(404).json({ error: 'No TaskQ user found with that email. They must sign up first.' });
        return;
      }
      // Workspace must exist
      const wsMetaSnap = await db.ref(`workspaces/${wsId}/settings`).once('value');
      if (!wsMetaSnap.exists()) { res.status(404).json({ error: 'Workspace not found' }); return; }
      const existingMemberSnap = await db.ref(`workspaces/${wsId}/members/${target.uid}`).once('value');
      if (existingMemberSnap.exists()) {
        res.status(409).json({ error: 'User is already a member of this workspace' });
        return;
      }
      // Pull the workspace display name from the inviter's list so we can mirror it
      const inviterWsEntrySnap = await db.ref(`users/${caller.uid}/workspaces/${wsId}`).once('value');
      const wsEntry = inviterWsEntrySnap.val() || {};
      const wsName = wsEntry.name || 'SHARED WORKSPACE';
      const now = Date.now();
      const multi = {};
      multi[`workspaces/${wsId}/members/${target.uid}`] = {
        email: target.email || email,
        role,
        addedAt: now,
        addedBy: caller.uid,
        reportConfig: { enabled: true, sendHour: 7, categoryFilter: null }
      };
      multi[`users/${target.uid}/workspaces/${wsId}`] = {
        name: wsName,
        createdAt: now,
        role
      };
      await db.ref().update(multi);
      res.json({ success: true, uid: target.uid, email: target.email });
    } catch (err) {
      console.error('inviteUserToWorkspace error:', err);
      res.status(err.message.includes('admin') || err.message.includes('token') || err.message.includes('Authorization') ? 403 : 500).json({ error: err.message });
    }
  }
);

exports.removeUserFromWorkspace = onRequest(
  { cors: true },
  async (req, res) => {
    try {
      if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
      const body = getBody(req);
      const { wsId, uid } = body;
      if (!wsId || !uid) { res.status(400).json({ error: 'wsId and uid required' }); return; }
      const caller = await assertAdmin(req, wsId);
      // Protect last admin
      const membersSnap = await db.ref(`workspaces/${wsId}/members`).once('value');
      const members = membersSnap.val() || {};
      const targetRole = members[uid]?.role;
      if (!members[uid]) { res.status(404).json({ error: 'User is not a member' }); return; }
      if (targetRole === 'admin') {
        const adminCount = Object.values(members).filter(m => m?.role === 'admin').length;
        if (adminCount <= 1) { res.status(400).json({ error: 'Cannot remove the last admin' }); return; }
      }
      const multi = {};
      multi[`workspaces/${wsId}/members/${uid}`] = null;
      multi[`users/${uid}/workspaces/${wsId}`] = null;
      await db.ref().update(multi);
      res.json({ success: true });
    } catch (err) {
      console.error('removeUserFromWorkspace error:', err);
      res.status(err.message.includes('admin') || err.message.includes('token') || err.message.includes('Authorization') ? 403 : 500).json({ error: err.message });
    }
  }
);

exports.setUserRole = onRequest(
  { cors: true },
  async (req, res) => {
    try {
      if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
      const body = getBody(req);
      const { wsId, uid, role } = body;
      if (!wsId || !uid || !['admin', 'member'].includes(role)) {
        res.status(400).json({ error: 'wsId, uid, role required (role: admin or member)' });
        return;
      }
      await assertAdmin(req, wsId);
      const membersSnap = await db.ref(`workspaces/${wsId}/members`).once('value');
      const members = membersSnap.val() || {};
      if (!members[uid]) { res.status(404).json({ error: 'User is not a member' }); return; }
      if (members[uid].role === 'admin' && role === 'member') {
        const adminCount = Object.values(members).filter(m => m?.role === 'admin').length;
        if (adminCount <= 1) { res.status(400).json({ error: 'Cannot demote the last admin' }); return; }
      }
      const multi = {};
      multi[`workspaces/${wsId}/members/${uid}/role`] = role;
      multi[`users/${uid}/workspaces/${wsId}/role`] = role;
      await db.ref().update(multi);
      res.json({ success: true });
    } catch (err) {
      console.error('setUserRole error:', err);
      res.status(err.message.includes('admin') || err.message.includes('token') || err.message.includes('Authorization') ? 403 : 500).json({ error: err.message });
    }
  }
);

exports.setWorkspaceLocks = onRequest(
  { cors: true },
  async (req, res) => {
    try {
      if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
      const body = getBody(req);
      const { wsId, locks } = body;
      if (!wsId || !locks || typeof locks !== 'object') {
        res.status(400).json({ error: 'wsId and locks object required' });
        return;
      }
      await assertAdmin(req, wsId);
      const clean = {
        assignees:   !!locks.assignees,
        categories:  !!locks.categories,
        subtitle:    !!locks.subtitle,
        urgentFlag:  !!locks.urgentFlag
      };
      await db.ref(`workspaces/${wsId}/locks`).set(clean);
      res.json({ success: true, locks: clean });
    } catch (err) {
      console.error('setWorkspaceLocks error:', err);
      res.status(err.message.includes('admin') || err.message.includes('token') || err.message.includes('Authorization') ? 403 : 500).json({ error: err.message });
    }
  }
);

exports.setMemberReportConfig = onRequest(
  { cors: true },
  async (req, res) => {
    try {
      if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
      const body = getBody(req);
      const { wsId, uid, reportConfig } = body;
      if (!wsId || !uid || !reportConfig || typeof reportConfig !== 'object') {
        res.status(400).json({ error: 'wsId, uid, reportConfig required' });
        return;
      }
      await assertAdmin(req, wsId);
      const memberSnap = await db.ref(`workspaces/${wsId}/members/${uid}`).once('value');
      if (!memberSnap.exists()) { res.status(404).json({ error: 'User is not a member' }); return; }
      const clean = {
        enabled: !!reportConfig.enabled,
        sendHour: Number.isFinite(+reportConfig.sendHour) ? +reportConfig.sendHour : 7,
        categoryFilter: Array.isArray(reportConfig.categoryFilter) && reportConfig.categoryFilter.length
          ? reportConfig.categoryFilter.map(String)
          : null
      };
      await db.ref(`workspaces/${wsId}/members/${uid}/reportConfig`).set(clean);
      res.json({ success: true, reportConfig: clean });
    } catch (err) {
      console.error('setMemberReportConfig error:', err);
      res.status(err.message.includes('admin') || err.message.includes('token') || err.message.includes('Authorization') ? 403 : 500).json({ error: err.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// SMS Notifications via Twilio
// ─────────────────────────────────────────────────────────────────────────────

function getTwilioClient() {
  return twilio(TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value());
}

async function sendSms(toPhone, messageBody) {
  const client = getTwilioClient();
  const from = TWILIO_PHONE_NUMBER.value();
  try {
    const msg = await client.messages.create({
      body: messageBody,
      from,
      to: toPhone
    });
    console.log(`SMS sent to ${toPhone}: sid=${msg.sid}`);
    return msg.sid;
  } catch (err) {
    console.error(`SMS failed to ${toPhone}:`, err.message);
    return null;
  }
}

// Build an .ics file string for a single event (used in SMS links)
function buildIcsEvent(title, startTs, endTs, description, location, uid) {
  const pad = (n) => String(n).padStart(2, '0');
  const toIcsDate = (ts) => {
    const d = new Date(ts);
    return d.getUTCFullYear() +
      pad(d.getUTCMonth() + 1) +
      pad(d.getUTCDate()) + 'T' +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes()) +
      pad(d.getUTCSeconds()) + 'Z';
  };
  const icsUid = uid || `${Date.now()}-${Math.random().toString(36).slice(2)}@taskq`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TaskQ//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsUid}`,
    `DTSTART:${toIcsDate(startTs)}`,
    `DTEND:${toIcsDate(endTs || startTs + 3600000)}`,
    `SUMMARY:${(title || '').replace(/[\r\n]/g, ' ')}`,
  ];
  if (description) lines.push(`DESCRIPTION:${String(description).replace(/[\r\n]/g, '\\n').slice(0, 500)}`);
  if (location) lines.push(`LOCATION:${String(location).replace(/[\r\n]/g, ' ')}`);
  lines.push(
    `DTSTAMP:${toIcsDate(Date.now())}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT30M',
    'ACTION:DISPLAY',
    `DESCRIPTION:Reminder: ${title}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  );
  return lines.join('\r\n');
}

// Admin endpoint: update a member's phone number
exports.setMemberPhone = onRequest(
  { cors: true },
  async (req, res) => {
    try {
      if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
      const body = getBody(req);
      const { wsId, uid, phone } = body;
      if (!wsId || !uid) { res.status(400).json({ error: 'wsId and uid required' }); return; }
      await assertAdmin(req, wsId);
      const memberSnap = await db.ref(`workspaces/${wsId}/members/${uid}`).once('value');
      if (!memberSnap.exists()) { res.status(404).json({ error: 'User is not a member' }); return; }
      const clean = phone ? String(phone).replace(/[^\d+]/g, '') : null;
      await db.ref(`workspaces/${wsId}/members/${uid}/phone`).set(clean);
      res.json({ success: true, phone: clean });
    } catch (err) {
      console.error('setMemberPhone error:', err);
      res.status(err.message.includes('admin') || err.message.includes('token') || err.message.includes('Authorization') ? 403 : 500).json({ error: err.message });
    }
  }
);

// Send SMS notifications for a task or event to specified members.
// Called by the client after saving a task/event with smsNotify list.
exports.sendSmsNotification = onRequest(
  { cors: true, secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER] },
  async (req, res) => {
    try {
      if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
      const body = getBody(req);
      const { wsId, itemType, itemKey, notifyUids } = body;
      if (!wsId || !itemType || !itemKey || !Array.isArray(notifyUids) || !notifyUids.length) {
        res.status(400).json({ error: 'wsId, itemType (task|event), itemKey, notifyUids[] required' });
        return;
      }
      // Verify caller is authenticated
      const authHeader = req.get('Authorization') || '';
      const match = authHeader.match(/^Bearer\s+(.+)$/);
      if (!match) { res.status(401).json({ error: 'Missing Authorization header' }); return; }
      try { await admin.auth().verifyIdToken(match[1]); } catch {
        res.status(403).json({ error: 'Invalid auth token' }); return;
      }

      // Read the item
      const itemPath = itemType === 'event'
        ? `workspaces/${wsId}/events/${itemKey}`
        : `workspaces/${wsId}/tasks/${itemKey}`;
      const itemSnap = await db.ref(itemPath).once('value');
      const item = itemSnap.val();
      if (!item) { res.status(404).json({ error: 'Item not found' }); return; }

      // Read workspace name
      const membersSnap = await db.ref(`workspaces/${wsId}/members`).once('value');
      const members = membersSnap.val() || {};

      // Build the .ics download URL for events
      let icsUrl = null;
      if (itemType === 'event' && item.startAt) {
        // Serve via calendarEvent endpoint
        icsUrl = `https://api.taskq.qponent.com/calendarEvent?wsId=${wsId}&key=${itemKey}`;
      }

      const sent = [];
      const failed = [];
      for (const uid of notifyUids) {
        const m = members[uid];
        if (!m || !m.phone) { failed.push({ uid, reason: 'no phone' }); continue; }
        let msg = '';
        if (itemType === 'event') {
          const startStr = item.startAt ? fmtDateTime(item.startAt, item.allDay) : 'TBD';
          msg = `TaskQ: ${item.title || '(No title)'}\n${startStr}`;
          if (item.location) msg += `\n${item.location}`;
          if (icsUrl) msg += `\n\nTap to add to calendar:\n${icsUrl}`;
        } else {
          msg = `TaskQ: ${item.name || '(No title)'}`;
          if (item.dueAt) msg += `\nDue: ${fmtDateTime(item.dueAt, false)}`;
          if (item.urgent) msg += '\n*** URGENT ***';
        }
        const sid = await sendSms(m.phone, msg);
        if (sid) sent.push({ uid, sid }); else failed.push({ uid, reason: 'send failed' });
      }
      res.json({ success: true, sent: sent.length, failed: failed.length, details: { sent, failed } });
    } catch (err) {
      console.error('sendSmsNotification error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Serve a single event as a downloadable .ics file (for SMS tap-to-add links)
exports.calendarEvent = onRequest(
  { cors: true },
  async (req, res) => {
    try {
      const { wsId, key } = req.query;
      if (!wsId || !key) { res.status(400).send('wsId and key required'); return; }
      const snap = await db.ref(`workspaces/${wsId}/events/${key}`).once('value');
      const ev = snap.val();
      if (!ev) { res.status(404).send('Event not found'); return; }
      const ics = buildIcsEvent(
        ev.title,
        ev.startAt,
        ev.endAt || ev.startAt + 3600000,
        ev.description,
        ev.location,
        `${key}@taskq-80ce7`
      );
      res.set('Content-Type', 'text/calendar; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${(ev.title || 'event').replace(/[^a-zA-Z0-9 ]/g, '')}.ics"`);
      res.send(ics);
    } catch (err) {
      console.error('calendarEvent error:', err);
      res.status(500).send('Internal error');
    }
  }
);

// Serve a full .ics calendar feed for a user (for iPhone calendar subscription).
// URL: /calendarFeed?uid=XYZ&token=SECRET
// The token is stored at users/{uid}/calFeedToken and generated on first request.
exports.calendarFeed = onRequest(
  { cors: true },
  async (req, res) => {
    try {
      const { uid, token } = req.query;
      if (!uid || !token) { res.status(400).send('uid and token required'); return; }
      // Verify token
      const tokenSnap = await db.ref(`users/${uid}/calFeedToken`).once('value');
      if (!tokenSnap.exists() || tokenSnap.val() !== token) {
        res.status(403).send('Invalid or expired token');
        return;
      }
      // Gather all events from all workspaces the user belongs to
      const wsSnap = await db.ref(`users/${uid}/workspaces`).once('value');
      const userWs = wsSnap.val() || {};
      const wsIds = Object.keys(userWs);
      const pad = (n) => String(n).padStart(2, '0');
      const toIcsDate = (ts) => {
        const d = new Date(ts);
        return d.getUTCFullYear() +
          pad(d.getUTCMonth() + 1) +
          pad(d.getUTCDate()) + 'T' +
          pad(d.getUTCHours()) +
          pad(d.getUTCMinutes()) +
          pad(d.getUTCSeconds()) + 'Z';
      };
      const toIcsDateOnly = (ts) => {
        const d = new Date(ts);
        return d.getUTCFullYear() +
          pad(d.getUTCMonth() + 1) +
          pad(d.getUTCDate());
      };

      const vevents = [];
      for (const wsId of wsIds) {
        const evSnap = await db.ref(`workspaces/${wsId}/events`).once('value');
        const wsEvents = evSnap.val() || {};
        const wsName = userWs[wsId]?.name || wsId;
        for (const [key, ev] of Object.entries(wsEvents)) {
          if (!ev.startAt) continue;
          const lines = [];
          lines.push('BEGIN:VEVENT');
          lines.push(`UID:${key}@taskq-80ce7`);
          if (ev.allDay) {
            lines.push(`DTSTART;VALUE=DATE:${toIcsDateOnly(ev.startAt)}`);
            if (ev.endAt) lines.push(`DTEND;VALUE=DATE:${toIcsDateOnly(ev.endAt)}`);
          } else {
            lines.push(`DTSTART:${toIcsDate(ev.startAt)}`);
            lines.push(`DTEND:${toIcsDate(ev.endAt || ev.startAt + 3600000)}`);
          }
          lines.push(`SUMMARY:${String(ev.title || '').replace(/[\r\n]/g, ' ')} [${wsName}]`);
          if (ev.description) lines.push(`DESCRIPTION:${String(ev.description).replace(/[\r\n]/g, '\\n').slice(0, 500)}`);
          if (ev.location) lines.push(`LOCATION:${String(ev.location).replace(/[\r\n]/g, ' ')}`);
          lines.push(`DTSTAMP:${toIcsDate(Date.now())}`);
          // Add a 30-minute reminder
          lines.push('BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', `DESCRIPTION:${ev.title || 'TaskQ Event'}`, 'END:VALARM');
          lines.push('END:VEVENT');
          vevents.push(lines.join('\r\n'));
        }
        // Also include tasks with due dates as VTODO or VEVENT
        const taskSnap = await db.ref(`workspaces/${wsId}/tasks`).once('value');
        const wsTasks = taskSnap.val() || {};
        for (const [key, t] of Object.entries(wsTasks)) {
          if (!t.dueAt || t.status === 'done') continue;
          const lines = [];
          lines.push('BEGIN:VEVENT');
          lines.push(`UID:task-${key}@taskq-80ce7`);
          lines.push(`DTSTART:${toIcsDate(t.dueAt)}`);
          lines.push(`DTEND:${toIcsDate(t.dueAt + 1800000)}`); // 30-min block
          const prefix = t.urgent ? 'URGENT: ' : t.highPriority ? 'HIGH: ' : '';
          lines.push(`SUMMARY:${prefix}${String(t.name || '').replace(/[\r\n]/g, ' ')} [${wsName}]`);
          if (t.description) lines.push(`DESCRIPTION:${String(t.description).replace(/[\r\n]/g, '\\n').slice(0, 500)}`);
          lines.push(`DTSTAMP:${toIcsDate(Date.now())}`);
          lines.push('BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', `DESCRIPTION:${t.name || 'TaskQ Task'}`, 'END:VALARM');
          lines.push('END:VEVENT');
          vevents.push(lines.join('\r\n'));
        }
      }

      const ical = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//TaskQ//Calendar Feed//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-CALNAME:TaskQ',
        'X-WR-TIMEZONE:America/Chicago',
        ...vevents,
        'END:VCALENDAR'
      ].join('\r\n');

      res.set('Content-Type', 'text/calendar; charset=utf-8');
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.send(ical);
    } catch (err) {
      console.error('calendarFeed error:', err);
      res.status(500).send('Internal error');
    }
  }
);

// Generate or retrieve a calendar feed token for a user
exports.getCalendarFeedUrl = onRequest(
  { cors: true },
  async (req, res) => {
    try {
      const authHeader = req.get('Authorization') || '';
      const match = authHeader.match(/^Bearer\s+(.+)$/);
      if (!match) { res.status(401).json({ error: 'Missing Authorization header' }); return; }
      let decoded;
      try { decoded = await admin.auth().verifyIdToken(match[1]); } catch {
        res.status(403).json({ error: 'Invalid auth token' }); return;
      }
      const uid = decoded.uid;
      let tokenSnap = await db.ref(`users/${uid}/calFeedToken`).once('value');
      let token = tokenSnap.val();
      if (!token) {
        // Generate a random token
        const crypto = require('crypto');
        token = crypto.randomBytes(24).toString('hex');
        await db.ref(`users/${uid}/calFeedToken`).set(token);
      }
      const url = `https://api.taskq.qponent.com/calendarFeed?uid=${uid}&token=${token}`;
      res.json({ success: true, url });
    } catch (err) {
      console.error('getCalendarFeedUrl error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// One-time migration: backfill every existing workspace with its owner(s) as admin.
// Triggerable via HTTP, idempotent (skips workspaces that already have members).
exports.migrateAdminsBackfill = onRequest(
  { cors: true },
  async (req, res) => {
    try {
      // Idempotent one-shot: promotes each workspace's creator(s) to admin.
      // Safe to run publicly — cannot escalate privileges beyond the truthful owner mapping.
      const [usersSnap, wsSnap] = await Promise.all([
        db.ref('users').once('value'),
        db.ref('workspaces').once('value'),
      ]);
      const users = usersSnap.val() || {};
      const workspaces = wsSnap.val() || {};

      // Map wsId -> array of { uid, email, createdAt }
      const wsToOwners = {};
      for (const [uid, userData] of Object.entries(users)) {
        const userWs = userData?.workspaces || {};
        for (const [wsId, entry] of Object.entries(userWs)) {
          if (!wsToOwners[wsId]) wsToOwners[wsId] = [];
          wsToOwners[wsId].push({ uid, createdAt: entry.createdAt || 0 });
        }
      }

      const changes = {};
      let promoted = 0;
      for (const [wsId, wsData] of Object.entries(workspaces)) {
        if (wsData?.members) continue; // already migrated
        const owners = (wsToOwners[wsId] || []).slice().sort((a, b) => a.createdAt - b.createdAt);
        if (!owners.length) continue;
        for (let i = 0; i < owners.length; i++) {
          const o = owners[i];
          let email = '';
          try {
            const rec = await admin.auth().getUser(o.uid);
            email = rec.email || '';
          } catch { /* ignore */ }
          changes[`workspaces/${wsId}/members/${o.uid}`] = {
            email,
            role: 'admin',
            addedAt: o.createdAt || Date.now(),
            addedBy: o.uid,
            reportConfig: { enabled: true, sendHour: 7, categoryFilter: null }
          };
          changes[`users/${o.uid}/workspaces/${wsId}/role`] = 'admin';
          promoted++;
        }
        // Default locks: all off
        if (!wsData.locks) {
          changes[`workspaces/${wsId}/locks`] = {
            assignees: false, categories: false, subtitle: false, urgentFlag: false
          };
        }
      }
      if (Object.keys(changes).length) await db.ref().update(changes);
      res.json({ success: true, promoted, workspaces: Object.keys(workspaces).length });
    } catch (err) {
      console.error('migrateAdminsBackfill error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Manually-triggered backup endpoint, in case you need an on-demand snapshot.
exports.backupNow = onRequest(
  { cors: true },
  async (req, res) => {
    try {
      const snap = await db.ref('/').once('value');
      const data = snap.val() || {};
      const json = JSON.stringify(data);
      const bucket = admin.storage().bucket('taskq-80ce7-backups');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const path = `db-backups/manual-${stamp}.json`;
      await bucket.file(path).save(Buffer.from(json, 'utf8'), {
        metadata: { contentType: 'application/json' }
      });
      res.json({ success: true, path, size: json.length });
    } catch (err) {
      console.error('backupNow error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);
