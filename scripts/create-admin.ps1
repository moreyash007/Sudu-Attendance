# Creates the first admin account in your Supabase project. Run it yourself in a terminal:
#   powershell -File scripts\create-admin.ps1
# It asks for a username and a password (hidden). The password and the project's secret key are never
# printed or saved; the key is fetched with the Supabase CLI you are logged in with (npx supabase login).
param(
  [string]$Ref = 'lrrnvjurlesmphpcfyft',
  [string]$Domain = 'attendance.invalid' # must match EMAIL_DOMAIN in frontend/public/config.js
)
$ErrorActionPreference = 'Stop'

$username = (Read-Host 'Admin username (3-32 chars: a-z, 0-9, . _ -)').Trim().ToLower()
if ($username -notmatch '^[a-z0-9][a-z0-9._-]{2,31}$') { Write-Host 'Invalid username.'; exit 1 }

function PlainText($secure) {
  $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
}
$pw1 = PlainText (Read-Host 'Admin password (12+ characters)' -AsSecureString)
$pw2 = PlainText (Read-Host 'Repeat the password' -AsSecureString)
if ($pw1 -ne $pw2) { Write-Host 'Passwords do not match.'; exit 1 }
if ($pw1.Length -lt 12) { Write-Host 'Password must be at least 12 characters.'; exit 1 }

Write-Host 'Getting the project key from the Supabase CLI...'
# npx prints harmless "npm notice" lines on stderr; Windows PowerShell would treat those as errors, so relax it here.
$ErrorActionPreference = 'Continue'
$raw = npx --yes supabase@latest projects api-keys --project-ref $Ref -o json 2>$null | Out-String
$ErrorActionPreference = 'Stop'
$svc = $null
try { $svc = (($raw | ConvertFrom-Json) | Where-Object { $_.name -eq 'service_role' } | Select-Object -First 1).api_key } catch {}
if (-not $svc) { Write-Host 'Could not get the key. Run "npx supabase login" with the account that owns the project, then try again.'; exit 1 }

$url = "https://$Ref.supabase.co"
$h = @{ apikey = $svc; Authorization = "Bearer $svc"; 'Content-Type' = 'application/json'; Prefer = 'return=representation' }
function ApiError($e) { if ($e.ErrorDetails -and $e.ErrorDetails.Message) { $e.ErrorDetails.Message } else { $e.Exception.Message } }

try {
  $user = Invoke-RestMethod -Method Post -Uri "$url/auth/v1/admin/users" -Headers $h `
    -Body (@{ email = "$username@$Domain"; password = $pw1; email_confirm = $true } | ConvertTo-Json)
} catch { Write-Host ('Could not create the login: ' + (ApiError $_)); exit 1 }

try {
  Invoke-RestMethod -Method Post -Uri "$url/rest/v1/profiles" -Headers $h `
    -Body (@{ id = $user.id; username = $username; name = 'Admin'; emp_id = 'ADMIN'; role = 'admin' } | ConvertTo-Json) | Out-Null
} catch {
  Write-Host ('Could not create the admin profile: ' + (ApiError $_))
  Invoke-RestMethod -Method Delete -Uri "$url/auth/v1/admin/users/$($user.id)" -Headers $h | Out-Null # roll back
  exit 1
}

Write-Host "Done. Admin '$username' created. Sign in at the site's /admin/ page; the first sign-in sets up the authenticator app."
