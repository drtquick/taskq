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
