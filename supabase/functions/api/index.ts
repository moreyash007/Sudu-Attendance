// SUDU Attendance: the server-side rules. Employees do not sign in: they are identified by a live face scan
// (face-login, check-in, check-out, visit take the face descriptor; me and leave take the token face-login issues).
// Admin routes need a signed-in admin with the authenticator-app step (aal2). Employees cannot write attendance
// any other way (see the SQL security rules).
//
// Routes (POST /functions/v1/api/<route>):
//   employee: config, holidays, face-login, me, check-in, check-out, visit, leave
//   admin:    admin-create-user, admin-update-user, admin-delete-user, admin-review, admin-settings,
//             admin-holiday-add, admin-holiday-update, admin-holiday-delete, admin-holiday-rules
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const EMAIL_DOMAIN = Deno.env.get('EMAIL_DOMAIN') ?? 'attendance.invalid';
// Local testing only: skips the office-location rule. Honoured only for requests coming from localhost.
const ALLOW_LOCAL_TEST = Deno.env.get('ALLOW_LOCAL_TEST') === 'true';
const TZ = 'Asia/Kolkata';

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const CORS = {
  'Access-Control-Allow-Origin': '*', // auth is a bearer token, not a cookie, so this is safe
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const fail = (status: number, message: string): never => { throw new HttpError(status, message); };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// ---------- helpers ----------

const DEFAULT_OFFICE = { lat: 18.646972, lng: 73.784528, radius: 10, maxAccuracy: 15, startTime: '09:30', graceMin: 15 };

async function getOffice() {
  const { data } = await db.from('settings').select('value').eq('key', 'office').maybeSingle();
  return { ...DEFAULT_OFFICE, ...(data?.value ?? {}) };
}

const dateKey = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

// ---------- holidays ----------
// Weekly offs are rules (every Sunday, the 1st-5th Saturday of the month); festival holidays are rows in `holidays`.
// A festival entry wins over a weekly rule for the same date. This is the single source of truth for both pages.

const DEFAULT_RULES = { sunday: true, saturdays: [2] as number[] };
const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th'];

async function getRules() {
  const { data } = await db.from('settings').select('value').eq('key', 'holiday_rules').maybeSingle();
  const v = (data?.value ?? {}) as Record<string, unknown>;
  const saturdays = Array.isArray(v.saturdays) ? v.saturdays.filter((n) => Number.isInteger(n) && n >= 1 && n <= 5) as number[] : DEFAULT_RULES.saturdays;
  return { sunday: typeof v.sunday === 'boolean' ? v.sunday : DEFAULT_RULES.sunday, saturdays };
}

function weeklyHoliday(date: string, rules: { sunday: boolean; saturdays: number[] }): string | null {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday, 6 = Saturday
  if (weekday === 0 && rules.sunday) return 'Sunday';
  if (weekday === 6) {
    const nth = Math.ceil(d / 7);
    if (rules.saturdays.includes(nth)) return `${ORDINAL[nth - 1]} Saturday`;
  }
  return null;
}

type Holiday = { date: string; name: string; kind: 'festival' | 'weekly'; id?: string };

async function holidaysBetween(from: string, to: string): Promise<Holiday[]> {
  const [rules, { data: festivals }] = await Promise.all([
    getRules(),
    db.from('holidays').select('id, date, name').gte('date', from).lte('date', to),
  ]);
  const byDate = new Map<string, Holiday>();
  for (const f of festivals ?? []) byDate.set(f.date, { id: f.id, date: f.date, name: f.name, kind: 'festival' });
  const end = Date.parse(to + 'T00:00:00Z');
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= end; t += 86400000) {
    const date = new Date(t).toISOString().slice(0, 10);
    if (byDate.has(date)) continue;
    const name = weeklyHoliday(date, rules);
    if (name) byDate.set(date, { date, name, kind: 'weekly' });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function holidayFor(date: string): Promise<Holiday | null> {
  return (await holidaysBetween(date, date))[0] ?? null;
}

function minutesNow() {
  const [h, m] = new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false }).split(':').map(Number);
  return h * 60 + m;
}

function distanceMetres(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000, rad = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const isUuid = (s: unknown) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const isUsername = (s: unknown) => typeof s === 'string' && /^[a-z0-9][a-z0-9._-]{2,31}$/.test(s);
const isNum = (n: unknown): n is number => typeof n === 'number' && isFinite(n);

function isLocalRequest(req: Request) {
  try { return ['localhost', '127.0.0.1'].includes(new URL(req.headers.get('origin') ?? '').hostname); } catch { return false; }
}

// Validates a face descriptor: exactly 128 finite numbers.
function parseDescriptor(d: unknown): number[] {
  if (!Array.isArray(d) || d.length !== 128 || !d.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 10)) {
    fail(400, 'No clear face found in the photo. Retake it facing the camera.');
  }
  return d as number[];
}

// Validates a base64 JPEG (the admin's enrolment photo) and returns its bytes.
function parsePhoto(b64: unknown): Uint8Array {
  if (typeof b64 !== 'string' || b64.length > 2_200_000) fail(400, 'A photo is required.');
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(b64 as string), (c) => c.charCodeAt(0)); } catch { return fail(400, 'A photo is required.'); }
  if (bytes.length < 1000 || bytes.length > 1_600_000 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    fail(400, 'A photo is required.');
  }
  return bytes;
}

function jwtClaims(token: string): Record<string, unknown> {
  try {
    const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(p + '='.repeat((4 - (p.length % 4)) % 4)));
  } catch { return {}; }
}

// ---------- authentication ----------

type Auth = { userId: string; profile: Record<string, any>; aal: string };

async function authenticate(req: Request): Promise<Auth> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) fail(401, 'Please sign in.');
  const { data, error } = await db.auth.getUser(token); // verifies the signature and expiry
  if (error || !data.user) fail(401, 'Please sign in again.');
  const { data: profile } = await db.from('profiles').select('*').eq('id', data.user!.id).maybeSingle();
  if (!profile || !profile.active) fail(403, 'Your account is not active.');
  return { userId: data.user!.id, profile: profile!, aal: String(jwtClaims(token).aal ?? '') };
}

// ---------- face identification (employees do not sign in) ----------
// The browser sends the face descriptor from a live blink-checked scan; the server finds whose face it is. The stored
// descriptors never leave the server.

const FACE_MATCH_MAX = 0.5;   // Euclidean distance between descriptors; lower = more alike
const FACE_MARGIN = 0.04;     // the best match must beat the runner-up by this much, else it is ambiguous
const FACE_DUPLICATE = 0.45;  // enrolling a face this close to another employee is refused
const TOKEN_MS = 20 * 60 * 1000;

function faceDistance(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < 128; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

async function enrolledFaces(exceptId?: string) {
  const { data, error } = await db.from('profiles').select('*').eq('role', 'employee').eq('active', true).not('face_descriptor', 'is', null);
  if (error) throw error;
  return (data ?? []).filter((p) => p.id !== exceptId && Array.isArray(p.face_descriptor) && p.face_descriptor.length === 128);
}

function rankFaces(descriptor: number[], faces: Record<string, any>[]) {
  return faces.map((p) => ({ p, d: faceDistance(descriptor, p.face_descriptor) })).sort((x, y) => x.d - y.d);
}

async function faceAuth(descriptor: unknown): Promise<Auth> {
  const d = parseDescriptor(descriptor);
  const ranked = rankFaces(d, await enrolledFaces());
  const best = ranked[0], next = ranked[1];
  if (!best || best.d > FACE_MATCH_MAX || (next && next.d - best.d < FACE_MARGIN)) {
    fail(401, 'Face not recognised. Look straight at the camera in good light and try again.');
  }
  return { userId: best.p.id, profile: best.p, aal: '' };
}

const enc = new TextEncoder();
const hmacKey = crypto.subtle.importKey('raw', enc.encode(SERVICE_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
async function sign(payload: string) {
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey, enc.encode(payload)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const issueToken = async (userId: string) => {
  const payload = `${userId}.${Date.now() + TOKEN_MS}`;
  return `${payload}.${await sign(payload)}`;
};

// For routes that follow a face sign-in (history, leave): checks the token the server issued after a face scan.
async function tokenAuth(token: unknown): Promise<Auth> {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3 || !isUuid(parts[0])) fail(401, 'Please scan your face again.');
  const expected = await sign(`${parts[0]}.${parts[1]}`);
  let diff = expected.length ^ parts[2].length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (parts[2].charCodeAt(i) || 0);
  if (diff !== 0 || Number(parts[1]) < Date.now()) fail(401, 'Please scan your face again.');
  const { data: profile } = await db.from('profiles').select('*').eq('id', parts[0]).maybeSingle();
  if (!profile || !profile.active || profile.role !== 'employee') fail(403, 'Your account is not active.');
  return { userId: parts[0], profile: profile!, aal: '' };
}

function requireAdmin(a: Auth) {
  if (a.profile.role !== 'admin') fail(403, 'Admins only.');
  if (a.aal !== 'aal2') fail(403, 'Two-step verification is required.');
}
const requireEmployee = (a: Auth) => { if (a.profile.role !== 'employee') fail(403, 'Employees only.'); };

// ---------- shared employee checks ----------

type Ctx = { req: Request; body: Record<string, any>; auth: Auth; dev: boolean };

// Same checks, in the same order, for check-in / check-out / visits.
async function prepare(c: Ctx, opts: { inside: boolean; maxAccuracy?: number }) {
  const { body: b, auth: a } = c;
  const office = await getOffice();

  const deviceId = String(b.deviceId ?? '');
  if (!/^[\w-]{8,64}$/.test(deviceId)) fail(400, 'Device id missing.');
  if (!a.profile.device_id) {
    await db.from('profiles').update({ device_id: deviceId }).eq('id', a.userId).is('device_id', null);
  } else if (a.profile.device_id !== deviceId) {
    fail(403, 'This account is registered to another phone/browser. Ask the admin to reset your device.');
  }

  const haveLoc = isNum(b.lat) && isNum(b.lng) && isNum(b.accuracy);
  const loc = { lat: null as number | null, lng: null as number | null, acc: null as number | null, dist: null as number | null };
  if (haveLoc) {
    loc.lat = b.lat; loc.lng = b.lng; loc.acc = Math.round(b.accuracy);
    loc.dist = Math.round(distanceMetres(b.lat, b.lng, office.lat, office.lng));
  }
  if (!c.dev) { // the real rules; local test mode skips them
    if (!haveLoc) fail(400, 'Location missing.');
    const limit = opts.maxAccuracy ?? office.maxAccuracy;
    if (b.accuracy > limit) {
      fail(422, `GPS accuracy is ${Math.round(b.accuracy)} m; ${limit} m or better is needed. Step outside or near a window and try again.`);
    }
    if (opts.inside && loc.dist! > office.radius) {
      fail(422, `You are ${loc.dist} m from the office. You must be within ${office.radius} m.`);
    }
  }

  // The live selfie from the face scan, stored in the employee's private folder.
  const bytes = parsePhoto(b.selfie);
  const path = `selfies/${a.userId}/${Date.now()}.jpg`;
  const up = await db.storage.from('photos').upload(path, bytes, { contentType: 'image/jpeg' });
  if (up.error) throw up.error;

  return { office, loc, photo: path };
}

// ---------- employee routes ----------

// Face sign-in: who is this? Returns a short-lived token for history and leave.
async function faceLogin(c: Ctx) {
  const p = c.auth.profile;
  return { token: await issueToken(c.auth.userId), user: { id: p.id, name: p.name, empId: p.emp_id } };
}

// Today's record, history and leave requests for the face-signed-in employee.
async function me(c: Ctx) {
  const uid = c.auth.userId;
  const [a, h, l] = await Promise.all([
    db.from('attendance').select('*').eq('user_id', uid).eq('date', dateKey()).maybeSingle(),
    db.from('attendance').select('*').eq('user_id', uid).order('date', { ascending: false }).limit(60),
    db.from('leaves').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(20),
  ]);
  return { today: a.data, history: h.data ?? [], leaves: l.data ?? [] };
}

async function config(c: Ctx) {
  const o = await getOffice();
  const h = await holidayFor(dateKey());
  return { lat: o.lat, lng: o.lng, radius: o.radius, maxAccuracy: o.maxAccuracy, devMode: c.dev, holidayToday: h?.name ?? null };
}

// Holidays (weekly offs + festivals) between two dates, for the employee's "upcoming" list and the admin calendar.
async function holidays(c: Ctx) {
  const from = isDate(c.body.from) ? c.body.from : dateKey();
  const to = isDate(c.body.to) ? c.body.to : new Date(Date.parse(from + 'T00:00:00Z') + 60 * 86400000).toISOString().slice(0, 10);
  if (to < from || Date.parse(to) - Date.parse(from) > 400 * 86400000) fail(400, 'Choose a date range of up to 400 days.');
  return { holidays: await holidaysBetween(from, to) };
}

async function checkIn(c: Ctx) {
  requireEmployee(c.auth);
  const { office, loc, photo } = await prepare(c, { inside: true });
  const [h, m] = String(office.startTime).split(':').map(Number);
  const today = dateKey();
  const holiday = await holidayFor(today); // working on a holiday is allowed: it is recorded, and never counted late
  const late = !holiday && minutesNow() > h * 60 + m + Number(office.graceMin);
  const { error } = await db.from('attendance').insert({
    user_id: c.auth.userId, date: today, late, test: c.dev, holiday_name: holiday?.name ?? null,
    in_lat: loc.lat, in_lng: loc.lng, in_acc: loc.acc, in_dist: loc.dist, in_photo: photo,
  });
  if (error?.code === '23505') fail(409, 'You have already checked in today.');
  if (error) throw error;
  return { late, holiday: holiday?.name ?? null };
}

async function checkOut(c: Ctx) {
  requireEmployee(c.auth);
  const { loc, photo } = await prepare(c, { inside: true });
  const { data, error } = await db.from('attendance')
    .update({ out_time: new Date().toISOString(), out_lat: loc.lat, out_lng: loc.lng, out_acc: loc.acc, out_dist: loc.dist, out_photo: photo })
    .eq('user_id', c.auth.userId).eq('date', dateKey()).is('out_time', null).select('id');
  if (error) throw error;
  if (!data?.length) fail(409, 'You have not checked in today, or have already checked out.');
  return { ok: true };
}

// Out duty / customer visit / custom visit: no geofence; GPS and selfie are recorded and an admin approves.
async function visit(c: Ctx) {
  requireEmployee(c.auth);
  const b = c.body;
  const customer = String(b.customer ?? '').trim().slice(0, 200);
  const reason = String(b.reason ?? '').trim().slice(0, 500);
  if (!['out_duty', 'customer_visit', 'custom_visit'].includes(b.type)) fail(400, 'Invalid visit type.');
  if (!reason) fail(400, 'Reason is required.');
  if (b.type === 'customer_visit' && !customer) fail(400, 'Customer name is required.');
  const { loc, photo } = await prepare(c, { inside: false, maxAccuracy: 100 });
  const { error } = await db.from('visits').insert({
    user_id: c.auth.userId, date: dateKey(), type: b.type, customer, reason,
    lat: loc.lat, lng: loc.lng, acc: loc.acc, photo,
  });
  if (error) throw error;
  return { ok: true };
}

// ---------- leave (saved here so the admin can be emailed) ----------

const LEAVE_LABEL: Record<string, string> = { full: 'Full day', half_first: 'Half day (first half)', half_second: 'Half day (second half)' };
const isDate = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').trim();

// Emails the admin through Resend. The addresses and the key are function secrets (never in the repository):
//   RESEND_API_KEY, NOTIFY_EMAIL (one or more, comma separated), optional NOTIFY_FROM, SITE_URL.
// A failed or unconfigured email never blocks the leave request itself.
async function emailAdmin(subject: string, lines: string[]): Promise<boolean> {
  const key = Deno.env.get('RESEND_API_KEY');
  const to = (Deno.env.get('NOTIFY_EMAIL') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!key || !to.length) return false;
  const site = (Deno.env.get('SITE_URL') ?? '').replace(/\/$/, '');
  const text = lines.join('\n') + (site ? `\n\nReview it: ${site}/admin/` : '');
  const html = '<p>' + lines.map(esc).join('<br>') + '</p>' + (site ? `<p><a href="${esc(site)}/admin/">Open the admin panel</a></p>` : '');
  try {
    const res = await fetch(Deno.env.get('RESEND_API_URL') ?? 'https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: Deno.env.get('NOTIFY_FROM') ?? 'SUDU Attendance <onboarding@resend.dev>', to, subject, text, html }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error('email failed', res.status, (await res.text()).slice(0, 200));
    return res.ok;
  } catch (e) { console.error('email error', e); return false; }
}

async function leave(c: Ctx) {
  requireEmployee(c.auth);
  const b = c.body;
  const reason = String(b.reason ?? '').trim().slice(0, 500);
  if (!Object.keys(LEAVE_LABEL).includes(b.type) || !isDate(b.from) || !isDate(b.to) || b.to < b.from || !reason) {
    fail(400, 'Pick valid dates and enter a reason.');
  }
  if (b.type !== 'full' && b.from !== b.to) fail(400, 'A half-day leave is for a single date.');
  const { error } = await db.from('leaves').insert({
    user_id: c.auth.userId, type: b.type, from_date: b.from, to_date: b.to, reason,
  });
  if (error) throw error;
  const p = c.auth.profile;
  const dates = b.from === b.to ? b.from : `${b.from} to ${b.to}`;
  const emailed = await emailAdmin(`Leave request: ${oneLine(p.name)} (${LEAVE_LABEL[b.type]}, ${dates})`, [
    `${p.name} (${p.emp_id || p.username}) has applied for leave.`,
    `Type: ${LEAVE_LABEL[b.type]}`,
    `Dates: ${dates}`,
    `Reason: ${reason}`,
  ]);
  return { ok: true, emailed };
}

// ---------- admin routes ----------

async function removeFolder(folder: string) {
  const { data } = await db.storage.from('photos').list(folder, { limit: 1000 });
  if (data?.length) await db.storage.from('photos').remove(data.map((f) => `${folder}/${f.name}`));
}

// Two employees with near-identical faces would make the face sign-in ambiguous, so refuse the enrolment.
async function refuseLookAlike(descriptor: number[], exceptId?: string) {
  const [close] = rankFaces(descriptor, await enrolledFaces(exceptId));
  if (close && close.d < FACE_DUPLICATE) fail(409, `This face is too similar to ${close.p.name}. Retake the photo, or check this person is not already added.`);
}

async function adminCreateUser(c: Ctx) {
  requireAdmin(c.auth);
  const b = c.body;
  const username = String(b.username ?? '').trim().toLowerCase();
  const name = String(b.name ?? '').trim().slice(0, 100);
  // Employees sign in with their face, so the login password is random and never used.
  const password = crypto.randomUUID() + crypto.randomUUID();
  if (!isUsername(username)) fail(400, 'Username must be 3-32 characters: letters, numbers, dot, dash or underscore.');
  if (!name) fail(400, 'Enter a name.');
  const bytes = parsePhoto(b.photo); // the employee's picture, taken by the admin
  const descriptor = parseDescriptor(b.faceDescriptor);
  await refuseLookAlike(descriptor);

  const { data: existing } = await db.from('profiles').select('id').ilike('username', username).maybeSingle();
  if (existing) fail(409, 'That username is already taken.');

  const created = await db.auth.admin.createUser({
    email: `${username}@${EMAIL_DOMAIN}`, password, email_confirm: true, user_metadata: { username },
  });
  if (created.error || !created.data.user) {
    if (/already|registered|exists/i.test(created.error?.message ?? '')) fail(409, 'That username is already taken.');
    console.error('createUser failed', created.error);
    fail(400, 'Could not create the login: ' + (created.error?.message ?? 'unknown error'));
  }
  const id = created.data.user!.id;
  try {
    const path = `enroll/${id}/photo-${Date.now()}.jpg`;
    const up = await db.storage.from('photos').upload(path, bytes, { contentType: 'image/jpeg' });
    if (up.error) throw up.error;
    const ins = await db.from('profiles').insert({
      id, username, name, emp_id: String(b.empId ?? '').trim().slice(0, 40), role: 'employee', enrol_photo: path,
      face_descriptor: descriptor,
    });
    if (ins.error) throw ins.error;
  } catch (e) {
    await db.auth.admin.deleteUser(id); // roll back so the username is not left half-created
    await removeFolder(`enroll/${id}`);
    throw e;
  }
  return { id };
}

async function loadEmployee(id: unknown) {
  if (!isUuid(id)) fail(400, 'Bad id.');
  const { data } = await db.from('profiles').select('*').eq('id', id as string).eq('role', 'employee').maybeSingle();
  if (!data) fail(404, 'Employee not found.');
  return data!;
}

async function adminUpdateUser(c: Ctx) {
  requireAdmin(c.auth);
  const b = c.body;
  const emp = await loadEmployee(b.id);
  if (typeof b.active === 'boolean') {
    await db.from('profiles').update({ active: b.active }).eq('id', emp.id);
    // Ban/unban the login too, so an already signed-in phone is cut off.
    await db.auth.admin.updateUserById(emp.id, { ban_duration: b.active ? 'none' : '876000h' });
  }
  if (b.resetDevice === true) await db.from('profiles').update({ device_id: null }).eq('id', emp.id);
  if (b.password !== undefined) {
    const pw = String(b.password);
    if (pw.length < 8 || pw.length > 72) fail(400, 'Password must be 8-72 characters.');
    const r = await db.auth.admin.updateUserById(emp.id, { password: pw });
    if (r.error) fail(400, r.error.message);
  }
  if (b.photo !== undefined) {
    const bytes = parsePhoto(b.photo);
    const descriptor = parseDescriptor(b.faceDescriptor);
    await refuseLookAlike(descriptor, emp.id);
    const path = `enroll/${emp.id}/photo-${Date.now()}.jpg`;
    const up = await db.storage.from('photos').upload(path, bytes, { contentType: 'image/jpeg' });
    if (up.error) throw up.error;
    await db.from('profiles').update({ enrol_photo: path, face_descriptor: descriptor }).eq('id', emp.id);
  }
  return { ok: true };
}

// Permanent: removes the login plus all of the employee's attendance, visits, leave and photos.
async function adminDeleteUser(c: Ctx) {
  requireAdmin(c.auth);
  const emp = await loadEmployee(c.body.id);
  await removeFolder(`selfies/${emp.id}`);
  await removeFolder(`enroll/${emp.id}`);
  const r = await db.auth.admin.deleteUser(emp.id); // profile, attendance, visits and leaves cascade
  if (r.error) throw r.error;
  return { ok: true };
}

async function adminReview(c: Ctx) {
  requireAdmin(c.auth);
  const { table, id, status } = c.body;
  if (!['visits', 'leaves'].includes(table) || !isUuid(id) || !['approved', 'rejected'].includes(status)) fail(400, 'Bad request.');
  const { error } = await db.from(table).update({ status }).eq('id', id);
  if (error) throw error;
  return { ok: true };
}

async function adminSettings(c: Ctx) {
  requireAdmin(c.auth);
  const b = c.body;
  const n = { lat: b.lat, lng: b.lng, radius: b.radius, maxAccuracy: b.maxAccuracy, graceMin: b.graceMin };
  if (!Object.values(n).every(isNum) || Math.abs(n.lat) > 90 || Math.abs(n.lng) > 180 ||
      n.radius < 3 || n.maxAccuracy < 3 || n.graceMin < 0 || !/^\d{2}:\d{2}$/.test(String(b.startTime ?? ''))) {
    fail(400, 'Check the values (radius and GPS error must be 3 m or more).');
  }
  const { error } = await db.from('settings').upsert({ key: 'office', value: { ...n, startTime: b.startTime } });
  if (error) throw error;
  return { ok: true };
}

// ---------- admin: holidays (full control) ----------

const cleanName = (s: unknown) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 100);

// Declares a festival / special holiday for one day or a range (e.g. Diwali 9-12 November). Adding a date that
// already has a festival entry just renames it.
async function adminHolidayAdd(c: Ctx) {
  requireAdmin(c.auth);
  const name = cleanName(c.body.name);
  const from = c.body.from, to = c.body.to ?? c.body.from;
  if (!name) fail(400, 'Enter the holiday name, for example Diwali.');
  if (!isDate(from) || !isDate(to) || to < from) fail(400, 'Pick a valid start and end date.');
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  if (days > 31) fail(400, 'A holiday can cover up to 31 days at a time.');
  const rows = [...Array(days)].map((_, i) => ({ date: new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10), name }));
  const { error } = await db.from('holidays').upsert(rows, { onConflict: 'date' });
  if (error) throw error;
  return { ok: true, days };
}

async function adminHolidayUpdate(c: Ctx) {
  requireAdmin(c.auth);
  const name = cleanName(c.body.name);
  if (!isUuid(c.body.id) || !name) fail(400, 'Enter the holiday name.');
  const { data, error } = await db.from('holidays').update({ name }).eq('id', c.body.id).select('id');
  if (error) throw error;
  if (!data?.length) fail(404, 'Holiday not found.');
  return { ok: true };
}

async function adminHolidayDelete(c: Ctx) {
  requireAdmin(c.auth);
  if (!isUuid(c.body.id)) fail(400, 'Bad id.');
  const { error } = await db.from('holidays').delete().eq('id', c.body.id);
  if (error) throw error;
  return { ok: true };
}

// The weekly offs: every Sunday on/off, and which Saturdays of the month (1st-5th) are off.
async function adminHolidayRules(c: Ctx) {
  requireAdmin(c.auth);
  const { sunday, saturdays } = c.body;
  if (typeof sunday !== 'boolean' || !Array.isArray(saturdays) || !saturdays.every((n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 5)) {
    fail(400, 'Choose Sunday on or off and which Saturdays (1st to 5th) are off.');
  }
  const value = { sunday, saturdays: [...new Set(saturdays as number[])].sort() };
  const { error } = await db.from('settings').upsert({ key: 'holiday_rules', value });
  if (error) throw error;
  return { ok: true };
}

// ---------- router ----------

const ROUTES: Record<string, (c: Ctx) => Promise<unknown>> = {
  'config': config,
  'holidays': holidays,
  'face-login': faceLogin,
  'me': me,
  'admin-holiday-add': adminHolidayAdd,
  'admin-holiday-update': adminHolidayUpdate,
  'admin-holiday-delete': adminHolidayDelete,
  'admin-holiday-rules': adminHolidayRules,
  'check-in': checkIn,
  'check-out': checkOut,
  'visit': visit,
  'leave': leave,
  'admin-create-user': adminCreateUser,
  'admin-update-user': adminUpdateUser,
  'admin-delete-user': adminDeleteUser,
  'admin-review': adminReview,
  'admin-settings': adminSettings,
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const route = new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? '';
    const handler = ROUTES[route];
    if (!handler || req.method !== 'POST') fail(404, 'Not found.');
    const body = await req.json().catch(() => ({}));
    // Employees are identified by their face, admins by their login. Only 'config' and 'holidays' need no identity.
    const auth = ['config', 'holidays'].includes(route) ? ({} as Auth)
      : ['face-login', 'check-in', 'check-out', 'visit'].includes(route) ? await faceAuth(body.descriptor)
      : ['me', 'leave'].includes(route) ? await tokenAuth(body.token)
      : await authenticate(req);
    return json(await handler({ req, body, auth, dev: ALLOW_LOCAL_TEST && isLocalRequest(req) }));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Something went wrong.' }, 500);
  }
});
