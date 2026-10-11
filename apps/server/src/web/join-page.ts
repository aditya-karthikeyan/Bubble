/**
 * The join page, served by the server itself so a crew link works even when the Vercel site
 * lags behind: /join/<code> shows the crew's name and a three-field signup that posts to
 * /api/signup with the code. The person lands in the crew and gets their bubble number.
 */
export function joinPageHtml(input: { code: string; crewName: string | null }): string {
  const name = input.crewName ? escapeHtml(input.crewName) : null;
  const title = name ? `Join ${name}` : 'Join a crew';
  const lede = name
    ? `Get your bubble and you're in ${name}. Then anyone in the crew can text "dinner tonight?" and the bubbles plan it.`
    : "That link doesn't match a crew anymore. Ask whoever made it for a fresh one, or get your own bubble below.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Bubbleworks</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif; background: radial-gradient(120% 90% at 50% 0%, #cfe6ff 0%, #f6f9ff 55%, #ffffff 100%); color: #10203a; min-height: 100vh; }
  @media (prefers-color-scheme: dark) { body { background: radial-gradient(120% 90% at 50% 0%, #15304f 0%, #0b1526 55%, #070d18 100%); color: #e9f0fb; } .card { background: rgba(20,32,52,.85); } input { background: #0f1b2e; color: #e9f0fb; border-color: #2a3d5c; } }
  .wrap { max-width: 440px; margin: 0 auto; padding: 48px 16px 64px; }
  h1 { font-size: 30px; margin: 0 0 8px; letter-spacing: -.01em; }
  .orb { width: 56px; height: 56px; border-radius: 50%; background: radial-gradient(circle at 30% 30%, #fff, #8fc3ff 55%, #4a8ff0); box-shadow: 0 10px 30px rgba(74,143,240,.35); margin-bottom: 16px; }
  .lede { margin: 0 0 20px; opacity: .85; }
  .card { background: rgba(255,255,255,.8); backdrop-filter: blur(14px); border-radius: 18px; padding: 20px; box-shadow: 0 12px 40px rgba(16,32,58,.12); }
  label { display: block; font-size: 13px; opacity: .8; margin: 10px 0 4px; }
  input { width: 100%; box-sizing: border-box; font: inherit; padding: 12px 14px; border: 1px solid #c9d7ec; border-radius: 12px; }
  button { width: 100%; margin-top: 16px; font: inherit; font-weight: 600; padding: 14px; border: 0; border-radius: 14px; background: #1f6fe5; color: #fff; }
  button[disabled] { opacity: .6; }
  .err { color: #c0392b; margin-top: 10px; font-size: 14px; }
  .number { font-size: 28px; font-weight: 700; margin: 10px 0; }
  a.button { display: block; text-align: center; text-decoration: none; margin-top: 14px; font-weight: 600; padding: 14px; border-radius: 14px; background: #1f6fe5; color: #fff; }
  .fine { font-size: 13px; opacity: .7; }
</style></head>
<body><div class="wrap">
  <div class="orb" aria-hidden="true"></div>
  <h1>${title}</h1>
  <p class="lede">${lede}</p>
  <div class="card" id="card">
    <form id="f" novalidate>
      <label for="name">Name</label><input id="name" name="name" autocomplete="name" required>
      <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required>
      <label for="phone">iPhone number</label><input id="phone" name="phone" type="tel" autocomplete="tel" placeholder="704 555 1234" required>
      <button id="go" type="submit">${name ? `Join ${name}` : 'Get my bubble'}</button>
      <div class="err" id="err" role="alert"></div>
    </form>
  </div>
  <p class="fine">Your bubble is private. It plans with your crew's bubbles and never shares your details.</p>
</div>
<script>
(function () {
  var code = ${JSON.stringify(input.crewName ? input.code : null)};
  var f = document.getElementById('f'), err = document.getElementById('err'), go = document.getElementById('go');
  function e164(raw) {
    var d = String(raw).replace(/[^\\d+]/g, '');
    if (/^\\+[1-9]\\d{7,14}$/.test(d)) return d;
    var b = d.replace(/\\+/g, '');
    if (/^\\d{10}$/.test(b)) return '+1' + b;
    if (/^1\\d{10}$/.test(b)) return '+' + b;
    return null;
  }
  f.addEventListener('submit', function (ev) {
    ev.preventDefault();
    err.textContent = '';
    var name = f.name.value.trim(), email = f.email.value.trim(), phone = e164(f.phone.value);
    if (!name) { err.textContent = 'Add your name.'; return; }
    if (!phone) { err.textContent = 'That phone number looks off. Try 10 digits, like 704 555 1234.'; return; }
    go.disabled = true;
    var body = { name: name, email: email, phone: phone };
    if (code) body.crewCode = code;
    fetch('/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok && j.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { err.textContent = 'Check your email and phone, then try again.'; go.disabled = false; return; }
        var j = res.j, number = j.bubbleNumber && j.bubbleNumber.charAt(0) === '+' ? j.bubbleNumber : null;
        var sms = j.smsLink || (number ? 'sms:' + number : null);
        var card = document.getElementById('card');
        card.innerHTML = '<h2 style="margin:0 0 4px;font-size:22px">' + (j.crewName ? "You're in " + j.crewName : 'Your bubble is ready') + '</h2>' +
          '<p class="lede">Text it to say hi. It asks a few quick questions to get to know you.</p>' +
          (number ? '<p class="number">' + number + '</p>' : '') +
          (sms ? '<a class="button" href="' + sms + '">Text your bubble</a>' : '');
        var h2 = card.querySelector('h2'); if (h2 && j.crewName) h2.textContent = "You're in " + j.crewName;
      })
      .catch(function () { err.textContent = "Couldn't reach Bubbleworks. Check your connection and try again."; go.disabled = false; });
  });
})();
</script></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
