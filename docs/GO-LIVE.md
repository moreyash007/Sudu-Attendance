# Go-live checklist (Monday 2 November 2026)

Site: https://suduattendance.vercel.app/  ·  Admin: https://suduattendance.vercel.app/admin/

## Status on Saturday 31 October

Checked on the live system with a temporary employee (removed afterwards): 19 of 19 checks passed.

| Check | Result |
|---|---|
| Site and admin page load | Yes |
| Public sign-up | Off |
| Test mode on the live server | Off (cannot be switched on) |
| Check-in outside the zone, with weak GPS, or twice | Refused |
| Check-in / check-out inside the zone | Accepted, with server time and distance |
| A second phone on the same account | Refused (device lock) |
| Leave is saved by the server | Yes (admin email works once set up, see below) |
| Employees can read other people's data or photos | No |

## Before Monday (about 15 minutes)

1. **Admin authenticator.** Open the admin page, **sign out**, sign in again, scan the QR code with a new entry in
   Google/Microsoft Authenticator, delete any old entry, type the 6-digit code.
2. **Test on a real phone at the office.** Stand at the entrance with GPS on and allow location and camera.
   Check in, check out. The map tag should say "In office zone". If staff are refused, raise **Allowed radius** or
   **Max GPS error** in Admin > Settings (and see the messages table below).
3. **Office location.** Admin > Settings > "Use my current location" while standing in the office, then Save.
4. **Staff.** Give each employee their username, temporary password and the site address. Each account locks to the
   **first phone** it signs in on, so they must sign in on their own phone first. Admin > Employees > **Reset device**
   if someone changes phone.
5. **Leave emails (optional).** Create a Resend API key, then run
   `powershell -File "C:\Users\yashr\Desktop\helpdesk\SUDU\attendance\scripts\set-mail-secrets.ps1"`.
6. **Remove test data** if any (Admin > Employees > Delete) so Monday starts clean.

## Holidays (admin has full control)

- Admin > **Holidays**. Weekly offs are already set to **every Sunday + the 2nd Saturday** of each month; tick or untick
  any of them (1st to 5th Saturday, Sunday) and press Save.
- Declare festivals now so staff see them in advance: **Diwali**, Dussehra, Holi, Christmas, Republic Day and so on.
  Enter the name and a date, or a start and end date for several days, then Add. Use Rename or Remove to correct one.
- On a holiday nobody is counted late or absent. If someone checks in anyway it is recorded as **holiday work**.
- Staff see "Today is a holiday" and an "Upcoming holidays" list on their page.

## Message for staff (copy and send)

> Attendance: open https://suduattendance.vercel.app/ on your own phone and sign in with your username and password.
> When the phone asks, tap **Allow** for **location** and **camera**. Switch GPS on. Stand inside the office, press
> **Check in** when you arrive and **Check out** when you leave, and take the selfie. If the app says you are too far
> or the GPS is weak, move near a window or the door and try again. Out for work or a customer visit: use
> **Out duty / visit**. Leave: use **Leave** (full day, first half or second half).

> उपस्थिति: अपने फ़ोन पर https://suduattendance.vercel.app/ खोलें और यूज़रनेम-पासवर्ड से साइन इन करें। फ़ोन पूछे तो
> **लोकेशन** और **कैमरा** की अनुमति दें और GPS चालू रखें। ऑफिस के अंदर आते समय **चेक इन** और जाते समय **चेक आउट** दबाएँ
> और सेल्फी लें। अगर "दूर हैं" या "कमज़ोर GPS" लिखा आए तो खिड़की या दरवाज़े के पास जाकर दोबारा कोशिश करें। बाहर काम या
> ग्राहक विज़िट: **बाहर ड्यूटी / विज़िट**। छुट्टी: **छुट्टी** (पूरा दिन या आधा दिन)।

## If someone cannot check in

| What the app says | What it means | What to do |
|---|---|---|
| "You are X m from the office..." | Outside the allowed radius | Move closer, or raise the radius in Settings |
| "GPS accuracy is X m; 15 m or better is needed" | The phone's GPS is rough | Go near a window/door, wait 10-20 s, retry; or raise Max GPS error |
| "Location blocked" | The browser denied location | Allow location for the site in the browser settings |
| "Camera blocked" | The browser denied camera | Allow camera for the site |
| "registered to another phone/browser" | Account is locked to the first phone | Admin > Employees > Reset device |
| "You have already checked in today" | One check-in per day | Use Check out |

## Every day / week for the admin

- **Dashboard:** present, late and absent for today, and the last 14 days.
- **Approvals:** approve or reject leave and out-duty/visit requests.
- **Photos:** open the in/out selfies on the dashboard now and then. There is no automatic face check, so a quick
  look is the control against someone else checking in for a colleague.
- **Reports:** Reports > Download CSV (opens in Excel). Do this at month end and keep the file: it is your backup of
  the attendance records.

## Settings changes apply to everyone

Zone, radius, GPS limit, start time and grace are saved once and used by the server on every check-in. Open employee
pages pick up the change within about 30 seconds. Records already saved keep their late / on-time label.

## Things to keep safe

- The admin password and the authenticator phone. If the phone is lost, ask for an authenticator reset.
- The Supabase and Vercel logins, and the GitHub repository (it is public; never commit passwords or keys).
- The project's **secret / service_role** key must never appear on the website or in Git.
