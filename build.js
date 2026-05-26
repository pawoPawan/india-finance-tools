const fs = require('fs');
const path = require('path');

const css  = fs.readFileSync('src/css/main.css', 'utf8');
const header  = fs.readFileSync('src/html/header.html', 'utf8');
const landing = fs.readFileSync('src/html/landing.html', 'utf8');
const results = fs.readFileSync('src/html/results.html', 'utf8');
const inputs  = fs.readFileSync('src/html/inputs.html', 'utf8');

const jsFiles = [
  'src/js/01_globals.js',
  'src/js/02_utils.js',
  'src/js/03_tax.js',
  'src/js/04_fifo.js',
  'src/js/05_card_builders.js',
  'src/js/06_schwab.js',
  'src/js/07_indmoney.js',
  'src/js/08_zerodha.js',
  'src/js/09_groww.js',
  'src/js/10_landing.js',
].map(f => `// ─── ${path.basename(f)} ───\n` + fs.readFileSync(f, 'utf8')).join('\n\n');

// Use a function replacement to avoid $-substitution issues in replacement strings
function safeReplace(str, placeholder, replacement) {
  const idx = str.indexOf(placeholder);
  if (idx < 0) throw new Error('Placeholder not found: ' + placeholder);
  return str.slice(0, idx) + replacement + str.slice(idx + placeholder.length);
}

let out = fs.readFileSync('src/template.html', 'utf8');
out = safeReplace(out, '{{CSS}}',     css);
out = safeReplace(out, '{{HEADER}}',  header);
out = safeReplace(out, '{{LANDING}}', landing);
out = safeReplace(out, '{{INPUTS}}',  inputs);
out = safeReplace(out, '{{RESULTS}}', results);
out = safeReplace(out, '{{JS}}',      jsFiles);

fs.writeFileSync('equity-analyzer.html', out);
console.log('Built equity-analyzer.html (' + out.split('\n').length + ' lines)');
