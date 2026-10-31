# SUDU Attendance

Office attendance website for SUDU Logistics. Works on any phone or laptop browser (nothing to install).

```
attendance/
  frontend/public/   the website (HTML/CSS/JS), hosted free on GitHub Pages
  supabase/          the backend, hosted on Supabase
    migrations/        database tables + security rules + private photo bucket (SQL)
    functions/api/     the Edge Function: all the rules (10 m check, device lock, approvals...)
    tests/e2e.mjs      automatic end-to-end tests
  .github/workflows/ GitHub Actions: run the tests, publish the site
```

How it fits together: the browser (GitHub Pages) talks to **Supabase** for login, the database and photos, and to
the `api` **Edge Function** for anything that must be checked on the server.

## What it does

- Employees sign in with a **username and password** (no email), check in/out **only inside the office radius
  (default 10 m)** with GPS accurate to 15 m or better, and take a live selfie each time.
- The admin adds employees (name, username, password, **photo taken by the admin**), resets devices, disables or
  deletes employees, approves out-duty/customer visits and leave (full day, first half, second half), sees a
  dashboard with charts and late/absent lists, exports CSV, and edits the office location and rules.
- Admin sign-in = username + password + **authenticator-app code**. This is enforced by the database and the
  server, not just the login page.
- English / Hindi, light / dark, live map of the office zone.

## Rules enforced on the server

- Distance, GPS accuracy, device lock, server time and late flag are all decided by the Edge Function.
  Employees cannot write attendance any other way: the database refuses it.
- Each account is locked to the first phone/browser it is used on; the admin can reset it.
- Employees can only read their own records. Photos live in a private bucket: employees can upload to their own
  folder but never read photos back; only a signed-in admin (with the authenticator step) can view them.
- Out duty / customer visit / custom visit skip the location rule but need GPS + selfie + admin approval.
- Data is encrypted at rest and in transit by Supabase (HTTPS everywhere).

## Set it up (one time)

Your Supabase project: `https://lrrnvjurlesmphpcfyft.supabase.co` (already set in `frontend/public/config.js`).

1. **Create the tables.** Supabase dashboard > SQL Editor > paste all of
   `supabase/migrations/20260101000000_init.sql` > Run.
2. **Turn off public sign-up.** Authentication > Sign In / Providers (or Settings) > switch off
   "Allow new users to sign up". Accounts are created only by the admin.
3. **Deploy the Edge Function** (needs Node; nothing is installed permanently):
   ```
   npx supabase login
   npx supabase link --project-ref lrrnvjurlesmphpcfyft
   npx supabase functions deploy api --no-verify-jwt
   ```
   Do **not** set `ALLOW_LOCAL_TEST` on the hosted project. (Optional: `npx supabase secrets set EMAIL_DOMAIN=attendance.invalid`,
   which is already the default.)
4. **Create the first admin.** Authentication > Users > Add user > Create new user:
   email `yourname@attendance.invalid`, a strong password (12+ characters), tick **Auto Confirm User**.
   Then SQL Editor, replacing `yourname`:
   ```sql
   insert into public.profiles (id, username, name, emp_id, role)
   select id, 'yourname', 'Admin', 'ADMIN', 'admin' from auth.users where email = 'yourname@attendance.invalid';
   ```
   If the dashboard refuses the `@attendance.invalid` address, use another domain and set the same domain in
   `frontend/public/config.js` (`EMAIL_DOMAIN`) and as the `EMAIL_DOMAIN` function secret.
5. **Publish the site.** GitHub repo > Settings > Pages > Source: **GitHub Actions**. Every push to `main` then
   publishes `frontend/public`. The site is at `https://moreyash007.github.io/Sudu-Attendance/`
   (admin: `/admin/`).
6. Open `/admin/`, sign in with your username and password, scan the QR code with Google/Microsoft Authenticator,
   enter the code. From then on every admin sign-in asks for a code. Add employees under Employees.

Never put the Supabase **secret / service_role** key in the website or in Git. Only the publishable key is in
`config.js`; it is designed to be public.

## Try it on your own PC first

```
npx supabase start          # a full local Supabase in Docker
```
Point `frontend/public/config.js` at the local URL/keys from `npx supabase status`, serve the site
(`python -m http.server 8090 --directory frontend/public`) and open http://localhost:8090/.
On `localhost` the function runs in **test mode** when `ALLOW_LOCAL_TEST=true`: the location rule is skipped (a PC has
no 10 m GPS), a TEST MODE banner shows, and records are marked **Test**. It only ever activates for requests coming
from `localhost`, so the real site always enforces the 10 m rule.

## Tests

```
npx supabase start
npx supabase status -o env      # shows API_URL, ANON_KEY, SERVICE_ROLE_KEY
API_URL=... ANON_KEY=... SERVICE_ROLE_KEY=... node supabase/tests/e2e.mjs
```
84 checks: sign-in, authenticator step, security rules, photo storage, the 10 m rules (both modes), device lock,
leave, approvals, delete. GitHub Actions runs them on every push.

## Known limits

- With no face matching, someone else could take the selfie, so admins should review the photos on the dashboard.
  A website cannot detect fake-GPS apps; the device lock and the GPS accuracy rule reduce the risk.
- Login sessions are kept in the browser's storage (Supabase's standard), not in cookies.
- Supabase's built-in rate limits protect sign-in; there is no custom "lock after 5 wrong passwords".
- Late/absent alerts show on the admin dashboard only (no email/SMS). Server messages are English only.
- The map and chart libraries load from public CDNs (jsdelivr, cdnjs, OpenStreetMap).
- The repository contains the default office location (18.646972, 73.784528) and the company logo. Keep the
  repository private if you do not want that public (GitHub Pages from a private repo needs a paid GitHub plan).
