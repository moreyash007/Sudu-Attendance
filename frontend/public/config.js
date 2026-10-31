// Public settings for the browser. The publishable key is safe to publish: access is enforced by the
// database security rules and the Edge Function. NEVER put the service_role / secret key here.
window.SUDU_CONFIG = {
  SUPABASE_URL: 'https://lrrnvjurlesmphpcfyft.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_7ZnzzGTtEf4BHXmMqm8ptA_MeBV086L',
  // Usernames become hidden login addresses like rahul@attendance.invalid. Must match the EMAIL_DOMAIN function secret.
  EMAIL_DOMAIN: 'attendance.invalid',
};
