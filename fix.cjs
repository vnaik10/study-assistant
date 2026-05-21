const fs = require('fs');
let code = fs.readFileSync('src/lib/ai.functions.ts', 'utf8');

// The Python script doubled the backslashes, so we need to replace '\\\\' with '\\'
code = code.replace(/\\\\/g, '\\');

// Fix the unescaped forward slash in the regex on line 20
// The broken regex is /[{}[\];=+\-*/<>]/g
// We need it to be /[{}[\];=+\-\/<>]/g or /[{}[\];=+\-*\/<>]/g
code = code.replace(/clean\.match\(\/\[\{\}\[\\\];\=\+\\\-\*\/<>\]\/g\)/, 'clean.match(/[{}[\\\\];=+\\\\-*\\\\/<>]/g)');

fs.writeFileSync('src/lib/ai.functions.ts', code);
console.log("Fixed backslashes");
