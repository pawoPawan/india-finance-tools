// ═══════════════════════════════════════════════════════════════════
// FORMATTERS
// ═══════════════════════════════════════════════════════════════════
function fUSD(v, c=false) {
  const abs = Math.abs(v);
  if (c && abs >= 1000) return '$'+(abs/1000).toFixed(2)+'K';
  return '$'+abs.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
}
function fINR(v, c=false) {
  const abs = Math.abs(v);
  if (c && abs >= 10000000) return '₹'+(abs/10000000).toFixed(2)+'Cr';
  if (c && abs >= 100000)  return '₹'+(abs/100000).toFixed(2)+'L';
  if (c && abs >= 1000)    return '₹'+(abs/1000).toFixed(1)+'K';
  return '₹'+Math.round(abs).toLocaleString('en-IN');
}
function fDate(d) {
  return new Date(d+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
}
function fDateShort(d) {
  return new Date(d+'T00:00:00').toLocaleDateString('en-US',{month:'short',year:'numeric'});
}
function fHolding(months) {
  if (months >= 12) { const y=Math.floor(months/12),m=months%12; return m?`${y}y ${m}mo`:`${y}y`; }
  return months+' mo';
}
function signStr(v) { return v >= 0 ? '+' : '−'; }

// Date when a lot crosses 24-month threshold → LTCG
function ltcgDate(dateAcquired) {
  const d = new Date(dateAcquired + 'T00:00:00');
  d.setMonth(d.getMonth() + 24);
  return d.toISOString().split('T')[0];
}
// Days from TODAY to a future isoDate (positive = future)
function daysUntil(isoDate) {
  return Math.ceil((new Date(isoDate + 'T00:00:00') - new Date(TODAY + 'T00:00:00')) / 86400000);
}


function parseCsvLine(line) {
  const result = []; let inQ = false, cur = '';
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  result.push(cur.trim());
  return result;
}

function isMMDDYYYY(s) { return /^\d{2}-\d{2}-\d{4}$/.test(s); }
function mmddToISO(s) {
  s = s.replace(/"/g,'').trim();
  const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
}
function numOf(s) { return parseFloat((s||'').replace(/[$,]/g,'')) || 0; }
function intOf(s) { return parseInt((s||'').replace(/[,]/g,'')) || 0; }
function monthsDiff(d1, d2) {
  const a = new Date(d1), b = new Date(d2);
  return (b.getFullYear()-a.getFullYear())*12 + b.getMonth()-a.getMonth();
}


function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    (acc[item[key]] = acc[item[key]] || []).push(item); return acc;
  }, {});
}
function emptyMsg(msg) {
  return `<div style="color:#aaa;font-size:13px;padding:12px 4px">${msg}</div>`;
}