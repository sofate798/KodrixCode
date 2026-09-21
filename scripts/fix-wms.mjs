// Fix literal backtick-n pollution in windowsMainService.js
import fs from 'node:fs';

const p = 'D:/minicode/out/vs/platform/windows/electron-main/windowsMainService.js';
let c = fs.readFileSync(p, 'utf8');

// The polluted pattern: "{`n    console.error..." where `n is LITERAL backtick+n
const bad = ') {`n    console.error("[DIAG] doOpen ENTER");';
const good = '){\n    console.error("[DIAG] doOpen ENTER");';

if (c.includes(bad)) {
  c = c.split(bad).join(good);
  fs.writeFileSync(p, c);
  console.log('FIXED: replaced literal backtick-n with real newline');
} else {
  console.log('Exact pattern not found.');
  // Search for any literal backtick immediately before "n" not preceded by newline context
  const idx = c.indexOf('`n');
  if (idx >= 0) {
    console.log('Still found literal backtick-n at offset', idx);
    console.log('Context:', JSON.stringify(c.slice(idx - 60, idx + 80)));
  } else {
    console.log('No literal backtick-n remaining.');
  }
}
