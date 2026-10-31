// Shared by both pages: the Supabase client and the helper that calls the server-side rules (Edge Function).
(function () {
  const cfg = window.SUDU_CONFIG;
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  const emailOf = (username) => `${String(username).trim().toLowerCase()}@${cfg.EMAIL_DOMAIN}`;

  // Calls the `api` Edge Function; throws an Error with the server's message (e.g. "You are 40 m from the office").
  async function call(route, body) {
    const { data, error } = await sb.functions.invoke('api/' + route, { body: body || {} });
    if (!error) return data;
    let message = 'Request failed.';
    let status;
    try {
      status = error.context && error.context.status;
      const j = await error.context.json();
      if (j && j.error) message = j.error;
    } catch (e) { if (error.message) message = error.message; }
    const err = new Error(message);
    err.status = status;
    throw err;
  }

  const blobToBase64 = (blob) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });

  window.Sudu = { sb, emailOf, call, blobToBase64 };
})();
