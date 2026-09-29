/**
 * scrimport-1 tests: {{var}} template rendering (both the template
 * service's _test.render and the admin flow's _test.render).
 * No Discord connection, no DB needed.
 */
const assert = require('node:assert/strict');
const svc = require('./src/services/scrimmsgtemplate.js');
const admin = require('./src/flows/scrimadmin.js');

let passed = 0;
function ok(name, cond) {
  if (!cond) {
    console.error('FAIL:', name);
    process.exitCode = 1;
  } else {
    passed++;
    console.log('ok:', name);
  }
}

console.log('service _test.render:');
const r = svc._test.render;
ok('basic substitution', r('Hello {{name}}', { name: 'X' }) === 'Hello X');
ok('multiple vars', r('{{a}} and {{b}}', { a: '1', b: '2' }) === '1 and 2');
ok('unknown keys left as-is', r('Hi {{nope}}!', { name: 'X' }) === 'Hi {{nope}}!');
ok('repeated var substituted everywhere', r('{{x}}/{{x}}', { x: '9' }) === '9/9');
ok('empty template', r('', { name: 'X' }) === '');
ok('non-string vars coerced', r('Slots: {{n}}', { n: 21 }) === 'Slots: 21');

console.log('admin _test.render:');
const ar = admin._test.render;
ok('basic substitution', ar('Hello {{name}}', { name: 'X' }) === 'Hello X');
ok('unknown keys left as-is', ar('Hi {{nope}}', { name: 'X' }) === 'Hi {{nope}}');

console.log('service surface:');
ok('exports getMessageTemplate/setMessageTemplate/renderTemplate', typeof svc.getMessageTemplate === 'function'
  && typeof svc.setMessageTemplate === 'function' && typeof svc.renderTemplate === 'function');
ok('DEFAULT_TEMPLATES is a non-empty object', !!svc.DEFAULT_TEMPLATES && Object.keys(svc.DEFAULT_TEMPLATES).length > 0);
ok('TEMPLATE_NAMES lists the defaults', Array.isArray(svc.TEMPLATE_NAMES) && svc.TEMPLATE_NAMES.length > 0);

console.log(`\n${passed} scrimport template tests passed.`);
