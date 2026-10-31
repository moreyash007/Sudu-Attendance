# Sets the private email settings on your Supabase project. Run it yourself in a terminal:
#   powershell -File "C:\Users\yashr\Desktop\helpdesk\SUDU\attendance\scripts\set-mail-secrets.ps1"
# It asks for the admin's email address(es) and your Resend API key (hidden). Nothing is written to the repository:
# the values go straight into the project's function secrets (use `npx supabase login` first).
param(
  [string]$Ref = 'lrrnvjurlesmphpcfyft',
  [string]$SiteUrl = 'https://moreyash007.github.io/Sudu-Attendance'
)
$ErrorActionPreference = 'Stop'

$to = (Read-Host 'Admin email address to notify (separate several with commas)').Trim()
if ($to -notmatch '^[^@\s,]+@[^@\s,]+\.[^@\s,]+(\s*,\s*[^@\s,]+@[^@\s,]+\.[^@\s,]+)*$') { Write-Host 'That does not look like an email address.'; exit 1 }

function PlainText($secure) {
  $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
}
$key = (PlainText (Read-Host 'Resend API key (starts with re_, hidden)' -AsSecureString)).Trim()
if ($key -notmatch '^re_[A-Za-z0-9_]{10,}$') { Write-Host 'That does not look like a Resend API key (it starts with re_).'; exit 1 }

# A temporary file keeps the key off the command line; it is deleted straight after.
$tmp = Join-Path $env:TEMP ("sudu-secrets-" + [guid]::NewGuid().ToString('N') + ".env")
try {
  Set-Content -Path $tmp -Value @("NOTIFY_EMAIL=$to", "RESEND_API_KEY=$key", "SITE_URL=$SiteUrl") -Encoding ascii
  $ErrorActionPreference = 'Continue' # npx prints harmless notices on stderr
  npx --yes supabase@latest secrets set --env-file $tmp --project-ref $Ref 2>&1 | Select-String 'Finished|rror|secrets' | ForEach-Object { $_.Line.Trim() }
} finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }

Write-Host "Done. Leave requests will now email: $to"
Write-Host 'Test it: apply for leave as an employee and check that inbox (also the spam folder).'
