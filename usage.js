// Keeps a live "Engine Usage" tab in your Google Sheet:
//  - what each service (search + email check) used today, this month and in total, against its free allowance
//  - spreads monthly free allowances evenly over the month (so nothing runs dry on the 10th)
//  - Status column says plainly when a limit is reached (and the run page on GitHub shows a warning)
// Allowances can be changed in keys.txt, e.g. TAVILY_MONTHLY=1000, LINKUP_TOTAL=4000, REOON_TOTAL=10000.
'use strict';
const SERVICES = [
  // search services (one search = one request)
  { id: 'tavily', name: 'Tavily (search)', key: 'TAVILY_KEY', store: 'sq', cap: 'tavily_daily_cap', monthly: 'TAVILY_MONTHLY', def: 1000 },
  { id: 'linkup', name: 'Linkup (search)', key: 'LINKUP_KEY', store: 'sq', cap: 'linkup_daily_cap', total: 'LINKUP_TOTAL', def: 4000 },
  { id: 'exa', name: 'Exa (search)', key: 'EXA_KEY', store: 'sq', cap: 'exa_daily_cap', monthly: 'EXA_MONTHLY', def: 270 },
  { id: 'firecrawl', name: 'Firecrawl (search)', key: 'FIRECRAWL_KEY', store: 'sq', cap: 'firecrawl_daily_cap', monthly: 'FIRECRAWL_MONTHLY', def: 250 },
  { id: 'serper', name: 'Serper (search)', key: 'SERPER_KEY', store: 'sq', cap: 'serper_daily_cap', total: 'SERPER_TOTAL', def: 2500 },
  // email checkers (one check = one credit)
  { id: 'qev', name: 'QuickEmailVerification (email check)', key: 'QEV_KEY', store: 'q', cap: 'qev_daily_cap', monthly: 'QEV_MONTHLY', def: 3000 },
  { id: 'mbv', name: 'MailboxValidator (email check)', key: 'MAILBOXVALIDATOR_KEY', store: 'q', cap: 'mailboxvalidator_daily_cap', monthly: 'MAILBOXVALIDATOR_MONTHLY', def: 300 },
  { id: 'zb', name: 'ZeroBounce (email check)', key: 'ZEROBOUNCE_KEY', store: 'q', cap: 'zerobounce_daily_cap', monthly: 'ZEROBOUNCE_MONTHLY', def: 100 },
  { id: 'hunter', name: 'Hunter (email check)', key: 'HUNTER_KEY', store: 'q', cap: 'hunter_verify_daily_cap', monthly: 'HUNTER_MONTHLY', def: 50 },
  { id: 'reoon', name: 'Reoon (email check, paid)', key: 'REOON_KEY', store: 'q', cap: 'reoon_daily_cap', total: 'REOON_TOTAL', def: 10000 },
];
const TAB = 'Engine Usage';
const ALERT = 'ALERTS (top row)';   // row 2 of the tab: the one place to look - lists every service that is low, used up, stopped or has a refused key
const HEADER = ['Service', 'Free allowance', 'Used today', "Today's share", 'Used this month', 'Used in total', 'Left', 'Status', 'Month', 'Updated (IST)'];
const ist = () => new Date(Date.now() + 5.5 * 3600e3);
const today = () => ist().toISOString().slice(0, 10);
const month = () => ist().toISOString().slice(0, 7);

function makeUsage(env, staticData) {
  const url = String(env.SHEET_SCRIPT_URL || '').trim(), secret = String(env.SHEET_SECRET || '').trim();
  async function sheet(action, payload) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ secret, action }, payload)), redirect: 'follow' });
    const j = JSON.parse(await r.text());
    if (!j.ok) throw new Error(j.error || 'sheet error');
    return j;
  }
  const active = SERVICES.filter((s) => String(env[s.key] || '').trim());
  const allowance = (s) => { const v = Number(env[s.monthly || s.total] || s.def); return v > 0 ? v : 0; };
  const usedToday = (s) => { const q = ((staticData[s.store] || {})[s.id]) || {}; return q.day === today() ? Number(q.used || 0) : 0; };
  const refused = (s) => { const q = ((staticData[s.store] || {})[s.id]) || {}; return q.day === today() && q.off; };
  let rows = [], before = {}, book = {}, alertOk = false, displaced = '';

  return {
    // before the run: read the tab, and lower each service's daily cap to its fair share of what is left
    async begin(settings) {
      if (!url || !secret) return [];
      try { rows = ((await sheet('getTab', { tab: TAB })).rows || []); } catch (e) { rows = []; }
      const h = rows[0] || HEADER;
      const ix = (n) => h.indexOf(n);
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i]; const s = SERVICES.find((x) => x.name === r[ix('Service')]);
        if (!s) continue;
        const sameMonth = String(r[ix('Month')]) === month();
        book[s.id] = { row: i + 1, month: sameMonth ? Number(r[ix('Used this month')] || 0) : 0, total: Number(r[ix('Used in total')] || 0) };
      }
      // the alert row must be row 2: the first time, it takes over row 2 and the service that sat there is written again at the bottom (its counters are kept)
      alertOk = rows.length >= 2 && String(rows[1][0]) === ALERT;
      if (!alertOk && rows.length >= 2 && rows[0][0] === 'Service') {
        displaced = String(rows[1][0]);
        const d = SERVICES.find((x) => x.name === displaced);
        if (d && book[d.id]) book[d.id].row = 0;
      }
      const changes = [];
      for (const s of active) {
        const b = (book[s.id] = book[s.id] || { row: 0, month: 0, total: 0 });
        before[s.id] = usedToday(s);
        if (!(s.cap in settings)) continue;
        const A = allowance(s);
        let share;
        if (s.monthly) {
          const d = ist(); const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
          const daysLeft = dim - d.getUTCDate() + 1;
          share = Math.floor((A - (b.month - before[s.id])) / daysLeft);   // even share of what is left this month
        } else share = A - b.total;                                          // one-time credits: whatever is left
        const was = Number(settings[s.cap] || 0);
        const now = Math.max(0, Math.min(was || share, share));
        settings[s.cap] = now; b.share = now;
        if (now !== was) changes.push(s.id + ' ' + was + '->' + now);
      }
      return changes;
    },
    // after the run: add what was used, write the tab, and flag anything that ran out
    async end(notes) {
      if (!url || !secret || !active.length) return [];
      const warn = [];
      const out = [];
      for (const s of active) {
        const b = book[s.id] || { row: 0, month: 0, total: 0 };
        const used = Math.max(0, usedToday(s) - (before[s.id] || 0));
        b.month += used; b.total += used;
        const A = allowance(s);
        const left = s.monthly ? A - b.month : A - b.total;
        const note = (notes || []).find((n) => new RegExp('^' + s.id + ' search stopped|^' + s.name.split(' ')[0] + ' stopped', 'i').test(n));
        let status = 'OK';
        const why = String(note || 'no credits / rate limit').replace(/^.*?:\s*/, '').slice(0, 80);
        if (refused(s) || note) status = (/unauthori|invalid|forbidden|denied|\b40[13]\b|api key|not allowed/i.test(why) ? 'STOPPED today - KEY REFUSED (check or replace the key): ' : 'STOPPED today - service refused: ') + why;
        else if (left <= 0) status = s.monthly ? 'MONTHLY FREE LIMIT USED UP - resets on the 1st' : 'FREE CREDITS USED UP - buy more or remove this key';
        else if (left <= A * 0.2) status = 'Running low - ' + Math.round((left / A) * 100) + '% left';
        else if (b.share !== undefined && usedToday(s) >= b.share) status = "OK - today's share used, more tomorrow";
        // alert: stopped / refused key / free credits used up (any service); under 20% left only counts for one-time (lifetime) credits - monthly ones are spread on purpose
        if (/USED UP|STOPPED/.test(status) || (!s.monthly && /^Running low/.test(status))) warn.push(s.name + ': ' + status);
        out.push({ s, b, row: [s.name, A + (s.monthly ? ' / month' : ' total'), usedToday(s), b.share === undefined ? '' : b.share, b.month, b.total, Math.max(0, left), status, month(), ist().toISOString().slice(0, 16).replace('T', ' ')] });
      }
      try {
        const have = rows.length && rows[0][0] === 'Service';
        const stamp = ist().toISOString().slice(0, 16).replace('T', ' ');
        const alertRow = [ALERT, warn.length + ' alert' + (warn.length === 1 ? '' : 's'), '', '', '', '', '', warn.length ? '\u26a0 ' + warn.join('  |  ').slice(0, 900) : '\u2714 All services OK - no alerts', month(), stamp];
        const updates = out.filter((o) => have && o.b.row).map((o) => ({ tab: TAB, row: o.b.row, keyCol: 'Service', key: o.s.name, set: Object.fromEntries(HEADER.map((k, i) => [k, o.row[i]])) }));
        if (have && alertOk) updates.push({ tab: TAB, row: 2, keyCol: 'Service', key: ALERT, set: Object.fromEntries(HEADER.map((k, i) => [k, alertRow[i]])) });
        else if (have && displaced) updates.push({ tab: TAB, row: 2, keyCol: 'Service', key: displaced, set: Object.fromEntries(HEADER.map((k, i) => [k, alertRow[i]])) });
        if (updates.length) await sheet('updateCells', { updates });
        const fresh = out.filter((o) => !(have && o.b.row)).map((o) => o.row);
        if (!have) fresh.unshift(alertRow);                       // brand-new tab: the alert row goes first
        if (fresh.length) await sheet('appendRows', { tab: TAB, header: HEADER, rows: fresh });
      } catch (e) { warn.push('Could not update the Engine Usage tab: ' + String(e.message || e).slice(0, 100)); }
      return { table: out.map((o) => o.row), warn };
    },
  };
}
module.exports = { makeUsage };
