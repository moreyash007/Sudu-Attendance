// End-to-end test of the Supabase backend: sign-in, authenticator step, security rules, photo storage and the
// `api` Edge Function. Needs Node 20+ and no packages. Run it with scripts/test.ps1 (or see the README).
//   API_URL=http://127.0.0.1:55321 ANON_KEY=... SERVICE_ROLE_KEY=... node supabase/tests/e2e.mjs
import crypto from 'node:crypto';

const { API_URL, ANON_KEY, SERVICE_ROLE_KEY } = process.env;
const DOMAIN = 'attendance.invalid';
const LOCAL = 'http://localhost:8090';           // origin of a developer's PC: local test mode may apply
const PAGES = 'https://suduattendance.vercel.app'; // origin of the real site: the location rule must apply
const OFFICE = { lat: 18.646972, lng: 73.784528 };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1600, 7)]);
const RUN = Math.random().toString(36).slice(2, 7); // every run uses its own usernames, so it can be repeated
const UA = 'adm' + RUN, U1 = 'e1' + RUN, U2 = 'e2' + RUN;
import nodeHttp from 'node:http';
// A fake Resend server: the local Edge Function is configured (supabase/config.toml) to post its emails here.
const mails = [];
const MAIL_PORT = Number(process.env.MAIL_PORT || 55999);
nodeHttp.createServer((req, res) => {
  let data = '';
  req.on('data', (d) => (data += d));
  req.on('end', () => { try { mails.push({ auth: req.headers.authorization, body: JSON.parse(data) }); } catch { /* ignore */ } res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"test"}'); });
}).listen(MAIL_PORT, '0.0.0.0');
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  <- ' + extra}`); };
const short = (v) => JSON.stringify(v)?.slice(0, 160);

// ---- tiny TOTP (RFC 6238) so no packages are needed ----
function totp(secretBase32) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretBase32.replace(/=+$/, '').toUpperCase()) bits += A.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String(((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1e6).padStart(6, '0');
}

async function http(method, path, { token, body, key = ANON_KEY, headers = {}, raw } = {}) {
  const h = { apikey: key, ...headers };
  if (token !== null) h.Authorization = 'Bearer ' + (token || key);
  let payload = raw;
  if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const res = await fetch(API_URL + path, { method, headers: h, body: payload });
  const text = Buffer.from(await res.arrayBuffer());
  let data = text; try { data = JSON.parse(text.toString()); } catch { /* binary or empty */ }
  return { status: res.status, data };
}
const admin = (method, path, body) => http(method, path, { token: SERVICE_ROLE_KEY, key: SERVICE_ROLE_KEY, body, headers: { Prefer: 'return=representation' } });
const login = (username, password) => http('POST', '/auth/v1/token?grant_type=password', { token: null, body: { email: `${username}@${DOMAIN}`, password } });
const fn = (token, route, body, origin = LOCAL) => http('POST', `/functions/v1/api/${route}`, { token, body, headers: { Origin: origin } });
const rest = (token, method, path, body) => http(method, '/rest/v1/' + path, { token, body, headers: { Prefer: 'return=representation' } });
const upload = (token, path, bytes, type = 'image/jpeg') => http('POST', `/storage/v1/object/photos/${path}`, { token, raw: bytes, headers: { 'Content-Type': type } });
const download = (token, path) => http('GET', `/storage/v1/object/authenticated/photos/${path}`, { token });
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

async function waitForFunction() {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${API_URL}/functions/v1/api/config`, { method: 'POST', headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + ANON_KEY } }).catch(() => null);
    if (r && r.status === 401) return true;
    await new Promise((r2) => setTimeout(r2, 1500));
  }
  return false;
}

async function selfie(token, uid) {
  const path = `selfies/${uid}/${Date.now()}-${Math.random().toString(16).slice(2, 8)}.jpg`;
  const r = await upload(token, path, JPEG);
  if (r.status >= 300) throw new Error('selfie upload failed: ' + short(r.data));
  return path;
}

(async () => {
  check('Edge Function is up and rejects an anonymous call (401)', await waitForFunction());

  // ---------- first admin (what the README tells you to do once) ----------
  let r = await admin('POST', '/auth/v1/admin/users', { email: `${UA}@${DOMAIN}`, password: 'AdminPass-12345', email_confirm: true });
  check('hidden login address (@attendance.invalid) is accepted by the auth server', r.status === 200 && r.data.id, short(r.data));
  const adminId = r.data.id;
  r = await admin('POST', '/rest/v1/profiles', { id: adminId, username: UA, name: 'Admin', emp_id: 'ADMIN', role: 'admin' });
  check('first admin profile created', r.status === 201, short(r.data));

  // ---------- admin: password only is NOT enough ----------
  r = await login(UA, 'wrong-password-1');
  check('wrong password is rejected', r.status === 400);
  r = await login(UA, 'AdminPass-12345');
  check('admin password sign-in works', r.status === 200 && r.data.access_token, short(r.data));
  let aal1 = r.data.access_token;
  check('password-only admin session is NOT treated as admin by the function', (await fn(aal1, 'admin-settings', { lat: 1, lng: 1, radius: 10, maxAccuracy: 15, graceMin: 5, startTime: '09:30' })).status === 403);
  check('password-only admin sees only their own profile row', (await rest(aal1, 'GET', 'profiles?select=id')).data.length === 1);

  // ---------- authenticator enrolment ----------
  r = await http('POST', '/auth/v1/factors', { token: aal1, body: { factor_type: 'totp', friendly_name: 'Test ' + Date.now() } });
  check('authenticator enrolment starts (QR + secret)', r.status === 200 && r.data.totp && r.data.totp.secret && r.data.totp.qr_code, short(r.data));
  const factor = r.data.id, secret = r.data.totp.secret;
  r = await http('POST', `/auth/v1/factors/${factor}/challenge`, { token: aal1, body: {} });
  const challenge = r.data.id;
  r = await http('POST', `/auth/v1/factors/${factor}/verify`, { token: aal1, body: { challenge_id: challenge, code: '000000' } });
  check('wrong authenticator code is rejected', r.status >= 400);
  r = await http('POST', `/auth/v1/factors/${factor}/challenge`, { token: aal1, body: {} });
  r = await http('POST', `/auth/v1/factors/${factor}/verify`, { token: aal1, body: { challenge_id: r.data.id, code: totp(secret) } });
  check('correct code upgrades the session to aal2', r.status === 200 && r.data.access_token, short(r.data));
  const A = r.data.access_token;
  check('admin (aal2) sees all profiles', (await rest(A, 'GET', 'profiles?select=id')).status === 200);

  // ---------- admin creates employees ----------
  const b64 = JPEG.toString('base64');
  const mk = (username, extra = {}) => fn(A, 'admin-create-user', { name: 'Test ' + username, empId: 'E-' + username, username, password: 'Employee-Pass-1', photo: b64, ...extra });
  r = await mk(U1); check('admin creates employee emp1 (login + photo)', r.status === 200 && r.data.id, short(r.data));
  const emp1 = r.data.id;
  check('duplicate username is 409', (await mk(U1)).status === 409);
  check('employee needs a photo', (await mk('emp9', { photo: undefined })).status === 400);
  check('short password rejected', (await mk('emp8', { password: 'short' })).status === 400);
  check('bad username rejected', (await mk('Bad Name!')).status === 400);
  check('a password-only admin session cannot create employees', (await fn(aal1, 'admin-create-user', { name: 'x', username: 'sneaky', password: 'Employee-Pass-1', photo: b64 })).status === 403);
  r = await mk(U2); const emp2 = r.data.id;
  check('admin creates employee emp2', r.status === 200);

  const prof1 = (await rest(A, 'GET', `profiles?id=eq.${emp1}&select=*`)).data[0];
  check('profile has role employee and an enrolment photo path', prof1 && prof1.role === 'employee' && /^enroll\//.test(prof1.enrol_photo), short(prof1));
  const enrol = await download(A, prof1.enrol_photo);
  check('admin can view the enrolment photo (identical bytes)', enrol.status === 200 && Buffer.compare(enrol.data, JPEG) === 0, String(enrol.status));

  // ---------- employee: what they may and may not do ----------
  r = await login(U1, 'Employee-Pass-1'); const E1 = r.data.access_token;
  check('employee sign-in works (username only)', r.status === 200 && E1);
  check('employee is refused on admin routes', (await fn(E1, 'admin-review', { table: 'visits', id: crypto.randomUUID(), status: 'approved' })).status === 403);
  check('employee sees only their own profile', (await rest(E1, 'GET', 'profiles?select=id')).data.length === 1);
  check('employee cannot write attendance directly', (await rest(E1, 'POST', 'attendance', { user_id: emp1, date: today })).status >= 400);
  check('employee cannot make themselves admin', (await rest(E1, 'PATCH', `profiles?id=eq.${emp1}`, { role: 'admin' })).status >= 400 && (await rest(A, 'GET', `profiles?id=eq.${emp1}&select=role`)).data[0].role === 'employee');
  check('employee cannot change settings', (await rest(E1, 'PATCH', 'settings?key=eq.office', { value: { radius: 9999 } })).status >= 400 && (await rest(A, 'GET', 'settings?key=eq.office')).data[0].value.radius === 10);
  check('employee cannot read photos back', (await download(E1, prof1.enrol_photo)).status >= 400);
  check('employee cannot upload into someone else’s folder', (await upload(E1, `selfies/${emp2}/x.jpg`, JPEG)).status >= 400);
  check('employee cannot upload a non-JPEG file', (await upload(E1, `selfies/${emp1}/x.png`, Buffer.from('not an image'), 'text/plain')).status >= 400);
  const stray = await admin('POST', '/auth/v1/admin/users', { email: `stray${RUN}@${DOMAIN}`, password: 'Stray-Pass-123', email_confirm: true });
  const strayTok = (await login('stray' + RUN, 'Stray-Pass-123')).data.access_token;
  check('a login without an employee profile cannot upload anything', (await upload(strayTok, `selfies/${stray.data.id}/x.jpg`, JPEG)).status >= 400);
  await admin('DELETE', `/auth/v1/admin/users/${stray.data.id}`);
  check('employee cannot sneak a file into the enroll folder', (await upload(E1, `enroll/${emp1}/me.jpg`, JPEG)).status >= 400);

  // ---------- check-in / check-out in LOCAL TEST mode (origin = localhost) ----------
  const D1 = 'device-aaaaaaaa', D2 = 'device-bbbbbbbb';
  check('config reports devMode on localhost', (await fn(E1, 'config', {})).data.devMode === true);
  check('check-in without a selfie is rejected', (await fn(E1, 'check-in', { deviceId: D1 })).status === 400);
  check('someone else’s selfie path is rejected', (await fn(E1, 'check-in', { deviceId: D1, selfiePath: `selfies/${emp2}/x.jpg` })).status === 400);
  check('a selfie that was never uploaded is rejected', (await fn(E1, 'check-in', { deviceId: D1, selfiePath: `selfies/${emp1}/ghost.jpg` })).status === 400);
  r = await fn(E1, 'check-in', { deviceId: D1, selfiePath: await selfie(E1, emp1) });
  check('check-in with no location works in local test mode', r.status === 200, short(r.data));
  check('second check-in is 409', (await fn(E1, 'check-in', { deviceId: D1, selfiePath: await selfie(E1, emp1) })).status === 409);
  check('another phone is blocked (device lock)', (await fn(E1, 'check-out', { deviceId: D2, selfiePath: await selfie(E1, emp1) })).status === 403);
  r = await fn(E1, 'check-out', { deviceId: D1, selfiePath: await selfie(E1, emp1) });
  check('check-out works', r.status === 200, short(r.data));
  check('second check-out is 409', (await fn(E1, 'check-out', { deviceId: D1, selfiePath: await selfie(E1, emp1) })).status === 409);
  const mine = (await rest(E1, 'GET', 'attendance?select=*')).data;
  check('employee sees their own record, marked as test', mine.length === 1 && mine[0].test === true && mine[0].in_time && mine[0].out_time, short(mine));

  // ---------- REAL mode (origin = the real site): the 10 m rule applies ----------
  const base = async (token, uid) => ({ deviceId: D1, selfiePath: await selfie(token, uid) });
  r = await login(U2, 'Employee-Pass-1'); const E2 = r.data.access_token;
  check('config says devMode false on the real site origin', (await fn(E2, 'config', {}, PAGES)).data.devMode === false);
  check('no location is refused', (await fn(E2, 'check-in', await base(E2, emp2), PAGES)).status === 400);
  r = await fn(E2, 'check-in', { ...(await base(E2, emp2)), lat: OFFICE.lat + 0.001, lng: OFFICE.lng, accuracy: 5 }, PAGES);
  check('about 111 m away is refused', r.status === 422 && /from the office/.test(r.data.error), short(r.data));
  r = await fn(E2, 'check-in', { ...(await base(E2, emp2)), ...OFFICE, accuracy: 40 }, PAGES);
  check('weak GPS (40 m) is refused', r.status === 422 && /GPS accuracy/.test(r.data.error), short(r.data));
  r = await fn(E2, 'check-in', { ...(await base(E2, emp2)), lat: OFFICE.lat + 0.00015, lng: OFFICE.lng, accuracy: 8 }, PAGES);
  check('about 17 m away (outside 10 m) is refused', r.status === 422, short(r.data));
  r = await fn(E2, 'check-in', { ...(await base(E2, emp2)), lat: OFFICE.lat + 0.00005, lng: OFFICE.lng, accuracy: 8 }, PAGES);
  check('about 5.5 m away with 8 m GPS error is accepted', r.status === 200, short(r.data));
  check('check-out far away is refused', (await fn(E2, 'check-out', { ...(await base(E2, emp2)), lat: OFFICE.lat + 0.001, lng: OFFICE.lng, accuracy: 5 }, PAGES)).status === 422);
  check('check-out at the office works', (await fn(E2, 'check-out', { ...(await base(E2, emp2)), ...OFFICE, accuracy: 6 }, PAGES)).status === 200);
  const rec2 = (await rest(E2, 'GET', 'attendance?select=*')).data[0];
  check('real-mode record is NOT marked test and keeps the distance', rec2 && rec2.test === false && rec2.in_dist <= 10, short(rec2));
  check('local test mode cannot be switched on from the real site', (await fn(E2, 'check-in', { ...(await base(E2, emp2)) }, PAGES)).status !== 200);

  // ---------- visits ----------
  const visit = async (extra) => fn(E2, 'visit', { ...(await base(E2, emp2)), ...extra }, PAGES);
  check('customer visit needs a customer name', (await visit({ type: 'customer_visit', reason: 'x', lat: OFFICE.lat + 0.05, lng: OFFICE.lng, accuracy: 30 })).status === 400);
  r = await visit({ type: 'customer_visit', customer: 'Tata Motors', reason: 'Demo', lat: OFFICE.lat + 0.05, lng: OFFICE.lng, accuracy: 30 });
  check('visit works away from the office', r.status === 200, short(r.data));
  const pv = (await rest(A, 'GET', `visits?status=eq.pending&user_id=eq.${emp2}&select=*,profile:profiles(name)`)).data;
  check('admin sees the pending visit with the employee name', pv.length === 1 && pv[0].customer === 'Tata Motors' && pv[0].profile.name === 'Test ' + U2, short(pv));
  check('admin approves the visit', (await fn(A, 'admin-review', { table: 'visits', id: pv[0].id, status: 'approved' })).status === 200);

  // ---------- leave ----------
  const leave = (token, o) => fn(token, 'leave', { reason: 'Family', ...o }, PAGES);
  check('half-day over several dates is refused', (await leave(E2, { type: 'half_first', from: '2026-11-03', to: '2026-11-04' })).status === 400);
  check('end before start is refused', (await leave(E2, { type: 'full', from: '2026-11-05', to: '2026-11-04' })).status === 400);
  check('bad leave type is refused', (await leave(E2, { type: 'holiday', from: '2026-11-05', to: '2026-11-05' })).status === 400);
  check('leave without a reason is refused', (await leave(E2, { type: 'full', from: '2026-11-05', to: '2026-11-05', reason: ' ' })).status === 400);
  check('employees can no longer write leave directly (it must go through the function)', (await rest(E2, 'POST', 'leaves', { user_id: emp2, type: 'full', from_date: '2026-11-03', to_date: '2026-11-03', reason: 'x' })).status >= 400);
  check('an admin cannot file leave through the employee route', (await leave(A, { type: 'full', from: '2026-11-03', to: '2026-11-03' })).status === 403);
  const mailsBefore = mails.length;
  r = await leave(E2, { type: 'full', from: '2026-11-03', to: '2026-11-04', reason: 'Family function <b>& travel</b>' });
  check('full-day leave accepted', r.status === 200 && r.data.ok === true, short(r.data));
  if (process.env.REQUIRE_MAIL) {
    for (let i = 0; i < 20 && mails.length === mailsBefore; i++) await new Promise((r2) => setTimeout(r2, 250));
    const m = mails[mails.length - 1];
    check('the admin is emailed about the leave request', r.data.emailed === true && mails.length === mailsBefore + 1, short(r.data));
    check('email has the right recipient, key, subject and details', m && m.auth === 'Bearer test-key' && m.body.to.includes('admin@mail.test') &&
      /Leave request: Test .* \(Full day, 2026-11-03 to 2026-11-04\)/.test(m.body.subject) &&
      m.body.text.includes('Family function <b>& travel</b>') && m.body.text.includes('https://example.test/app/admin/'), short(m));
    check('email HTML escapes what the employee typed', m && !m.body.html.includes('<b>& travel') && m.body.html.includes('&lt;b&gt;&amp; travel&lt;/b&gt;'));
  } else {
    check('the leave request is saved even when no mail server is reachable', r.status === 200);
  }
  r = await leave(E2, { type: 'half_second', from: '2026-11-06', to: '2026-11-06', reason: 'Bank' });
  check('half-day leave accepted', r.status === 200, short(r.data));
  check('employee cannot approve their own leave', (await rest(E2, 'PATCH', 'leaves?status=eq.pending', { status: 'approved' })).status >= 400 && (await rest(A, 'GET', `leaves?status=eq.approved&user_id=eq.${emp2}&select=id`)).data.length === 0);
  const pl = (await rest(A, 'GET', `leaves?status=eq.pending&user_id=eq.${emp2}&select=id`)).data;
  check('admin sees 2 pending leaves', pl.length === 2);
  check('admin approves one and rejects one', (await fn(A, 'admin-review', { table: 'leaves', id: pl[0].id, status: 'approved' })).status === 200 && (await fn(A, 'admin-review', { table: 'leaves', id: pl[1].id, status: 'rejected' })).status === 200);

  // ---------- settings ----------
  const s0 = (await rest(A, 'GET', 'settings?key=eq.office')).data[0].value;
  check('default settings: 10 m radius, 15 m GPS', s0.radius === 10 && s0.maxAccuracy === 15 && s0.lat === 18.646972, short(s0));
  check('invalid settings rejected', (await fn(A, 'admin-settings', { ...s0, radius: 1 })).status === 400);
  check('valid settings saved', (await fn(A, 'admin-settings', { ...s0, graceMin: 20 })).status === 200 && (await rest(A, 'GET', 'settings?key=eq.office')).data[0].value.graceMin === 20);

  // ---------- holidays: weekly offs + festivals, full admin control ----------
  const hol = (token, from, to) => fn(token, 'holidays', { from, to }, PAGES);
  const expectedWeekly = (from, to, { sunday = true, sats = [2] } = {}) => {
    const out = [];
    for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 86400000) {
      const d = new Date(t), wd = d.getUTCDay(), day = d.getUTCDate();
      if ((wd === 0 && sunday) || (wd === 6 && sats.includes(Math.ceil(day / 7)))) out.push(d.toISOString().slice(0, 10));
    }
    return out;
  };
  r = await hol(E2, '2026-11-01', '2026-12-31');
  check('every Sunday and the 2nd Saturday are holidays by default', r.status === 200 &&
    JSON.stringify(r.data.holidays.map((h) => h.date)) === JSON.stringify(expectedWeekly('2026-11-01', '2026-12-31')), short(r.data).slice(0, 120));
  check('the 2nd Saturdays are 14 Nov and 12 Dec 2026 and are named', ['2026-11-14', '2026-12-12'].every((d) => r.data.holidays.find((h) => h.date === d && h.name === '2nd Saturday')));
  check('other Saturdays and weekdays are working days', !r.data.holidays.find((h) => h.date === '2026-11-07' || h.date === '2026-11-21' || h.date === '2026-11-18'));
  check('a date range over 400 days is refused', (await hol(E2, '2026-01-01', '2028-01-01')).status === 400);
  check('employees cannot declare holidays', (await fn(E2, 'admin-holiday-add', { name: 'Sneaky', from: '2026-11-18' }, PAGES)).status === 403);
  check('employees cannot change the weekly rules', (await fn(E2, 'admin-holiday-rules', { sunday: false, saturdays: [] }, PAGES)).status === 403);
  check('employees cannot write the holidays table directly', (await rest(E2, 'POST', 'holidays', { date: '2026-11-18', name: 'x' })).status >= 400);

  r = await fn(A, 'admin-holiday-add', { name: 'Diwali (test)', from: '2026-11-09', to: '2026-11-11' }, PAGES);
  check('admin declares Diwali for 3 days', r.status === 200 && r.data.days === 3, short(r.data));
  r = await hol(E2, '2026-11-08', '2026-11-12');
  const diwali = r.data.holidays.filter((h) => h.kind === 'festival');
  check('the 3 festival days show up for employees, named', diwali.length === 3 && diwali.every((h) => h.name === 'Diwali (test)'), short(r.data));
  check('(8 Nov is a Sunday, so it is also listed as a weekly off)', r.data.holidays.find((h) => h.date === '2026-11-08' && h.kind === 'weekly'));
  const festId = diwali[0].id;
  r = await fn(A, 'admin-holiday-add', { name: 'Special Sunday', from: '2026-11-15' }, PAGES);
  r = await hol(E2, '2026-11-15', '2026-11-15');
  check('a festival on a Sunday overrides the weekly name', r.data.holidays[0].kind === 'festival' && r.data.holidays[0].name === 'Special Sunday', short(r.data));
  check('admin renames a holiday', (await fn(A, 'admin-holiday-update', { id: festId, name: 'Deepavali (test)' }, PAGES)).status === 200 &&
    (await hol(E2, '2026-11-09', '2026-11-09')).data.holidays[0].name === 'Deepavali (test)');
  const sunId = (await hol(E2, '2026-11-15', '2026-11-15')).data.holidays[0].id;
  check('admin removes a festival and the weekly rule applies again', (await fn(A, 'admin-holiday-delete', { id: sunId }, PAGES)).status === 200 &&
    (await hol(E2, '2026-11-15', '2026-11-15')).data.holidays[0].kind === 'weekly');
  check('empty or oversized holiday entries are refused', (await fn(A, 'admin-holiday-add', { name: ' ', from: '2026-11-18' }, PAGES)).status === 400 &&
    (await fn(A, 'admin-holiday-add', { name: 'Long', from: '2026-11-01', to: '2026-12-31' }, PAGES)).status === 400 &&
    (await fn(A, 'admin-holiday-add', { name: 'Backwards', from: '2026-11-20', to: '2026-11-19' }, PAGES)).status === 400);

  check('admin turns Sunday off and adds the 4th Saturday', (await fn(A, 'admin-holiday-rules', { sunday: false, saturdays: [2, 4] }, PAGES)).status === 200);
  r = await hol(E2, '2026-11-01', '2026-11-30');
  check('weekly rules change at once: no Sundays, 28 Nov (4th Saturday) is off', JSON.stringify(r.data.holidays.filter((h) => h.kind === 'weekly').map((h) => h.date)) === JSON.stringify(['2026-11-14', '2026-11-28']), short(r.data.holidays.filter((h) => h.kind === 'weekly').map((h) => h.date)));
  check('invalid weekly rules are refused', (await fn(A, 'admin-holiday-rules', { sunday: 'yes', saturdays: [2] }, PAGES)).status === 400 &&
    (await fn(A, 'admin-holiday-rules', { sunday: true, saturdays: [9] }, PAGES)).status === 400);
  await fn(A, 'admin-holiday-rules', { sunday: true, saturdays: [2] }, PAGES); // back to the default
  await fn(A, 'admin-holiday-delete', { id: festId }, PAGES);
  for (const f of diwali.slice(1)) await fn(A, 'admin-holiday-delete', { id: f.id }, PAGES);
  check('the test festivals are cleaned up', (await hol(E2, '2026-11-09', '2026-11-11')).data.holidays.every((h) => h.kind !== 'festival'));

  // working on a holiday: allowed, recorded as holiday work, never counted late
  r = await mk('e3' + RUN); const emp3 = r.data.id;
  const E3 = (await login('e3' + RUN, 'Employee-Pass-1')).data.access_token;
  await fn(A, 'admin-settings', { ...s0, startTime: '00:00', graceMin: 0 }, PAGES); // so a normal check-in now would be late
  r = await fn(A, 'admin-holiday-add', { name: 'Declared today (test)', from: today }, PAGES);
  check('admin declares today a holiday', r.status === 200, short(r.data));
  check('the employee app is told today is a holiday', (await fn(E3, 'config', {}, PAGES)).data.holidayToday === 'Declared today (test)');
  r = await fn(E3, 'check-in', { deviceId: 'holiday-device-1', selfiePath: await selfie(E3, emp3), lat: OFFICE.lat + 0.00003, lng: OFFICE.lng, accuracy: 6 }, PAGES);
  check('check-in on a holiday is still allowed, and is not late', r.status === 200 && r.data.late === false && r.data.holiday === 'Declared today (test)', short(r.data));
  const hrec = (await rest(A, 'GET', `attendance?user_id=eq.${emp3}&select=late,holiday_name`)).data[0];
  check('the record is tagged as holiday work', hrec && hrec.holiday_name === 'Declared today (test)' && hrec.late === false, short(hrec));
  const todayHol = (await hol(E3, today, today)).data.holidays[0];
  await fn(A, 'admin-holiday-delete', { id: todayHol.id }, PAGES);
  await fn(A, 'admin-settings', { ...s0 }, PAGES); // restore the settings
  check('after removing the holiday the config no longer reports one', (await fn(E3, 'config', {}, PAGES)).data.holidayToday === null || (await fn(E3, 'config', {}, PAGES)).data.holidayToday === 'Sunday' || (await fn(E3, 'config', {}, PAGES)).data.holidayToday === '2nd Saturday');
  await fn(A, 'admin-delete-user', { id: emp3 }, PAGES);

  // ---------- managing employees ----------
  const att = (await rest(A, 'GET', `attendance?select=*,profile:profiles(name,emp_id)&order=date&user_id=in.(${emp1},${emp2})`)).data;
  check('admin sees all attendance with names', att.length === 2 && att.every((a) => a.profile && a.profile.name), short(att));
  const selfiePhoto = await download(A, att[0].in_photo);
  check('admin can view an attendance selfie', selfiePhoto.status === 200 && Buffer.compare(selfiePhoto.data, JPEG) === 0);
  check('admin resets a device', (await fn(A, 'admin-update-user', { id: emp1, resetDevice: true })).status === 200 && (await rest(A, 'GET', `profiles?id=eq.${emp1}&select=device_id`)).data[0].device_id === null);
  check('admin sets a new employee password', (await fn(A, 'admin-update-user', { id: emp1, password: 'NewPassword-5678' })).status === 200);
  check('old password no longer works', (await login(U1, 'Employee-Pass-1')).status === 400);
  check('new password works', (await login(U1, 'NewPassword-5678')).status === 200);
  check('admin replaces the employee photo', (await fn(A, 'admin-update-user', { id: emp1, photo: b64 })).status === 200);
  check('admin disables an employee', (await fn(A, 'admin-update-user', { id: emp2, active: false })).status === 200);
  check('disabled employee cannot sign in', (await login(U2, 'Employee-Pass-1')).status >= 400);
  const stale = (await fn(E2, 'config', {})).status;
  check('disabled employee’s old session is refused by the function', stale === 401 || stale === 403, String(stale));
  check('admin re-enables the employee', (await fn(A, 'admin-update-user', { id: emp2, active: true })).status === 200 && (await login(U2, 'Employee-Pass-1')).status === 200);
  check('admin cannot delete an admin account', (await fn(A, 'admin-delete-user', { id: adminId })).status === 404);
  const files = (await admin('POST', '/storage/v1/object/list/photos', { prefix: `selfies/${emp1}`, limit: 100 })).data;
  check('(before delete) the employee has stored selfies', Array.isArray(files) && files.length > 0);
  check('admin deletes an employee', (await fn(A, 'admin-delete-user', { id: emp1 })).status === 200);
  check('deleted employee cannot sign in', (await login(U1, 'NewPassword-5678')).status >= 400);
  check('deleted employee’s attendance is gone', (await admin('GET', `/rest/v1/attendance?user_id=eq.${emp1}&select=id`)).data.length === 0);
  const after = (await admin('POST', '/storage/v1/object/list/photos', { prefix: `selfies/${emp1}`, limit: 100 })).data;
  check('deleted employee’s photos are gone', Array.isArray(after) && after.length === 0, short(after));
  check('the function rejects calls without a signed-in user', (await fn(null, 'config', {})).status === 401);

  // clean up what this run created
  await fn(A, 'admin-delete-user', { id: emp2 });
  await admin('DELETE', `/auth/v1/admin/users/${adminId}`);
})().catch((e) => { console.log('FAIL  crashed:', e); results.push(false); }).finally(() => {
  const pass = results.filter(Boolean).length;
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length && results.length > 0 ? 0 : 1);
});
