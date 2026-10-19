const { OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET } = require("../lib/auth");
const { httpsPostForm } = require("../lib/yandex");
const url = require("url");

// --- API: Request Device Code for One-Click Login ---
async function deviceCodeHandler(req, res) {
  try {
    const deviceId = "ym-mod-" + Date.now();
    const result = await httpsPostForm("https://oauth.yandex.ru/device/code", {
      client_id: OAUTH_CLIENT_ID,
      device_id: deviceId,
      device_name: "Yandex Music Web Mod",
    });

    console.log(`[AUTH] Device code created: ${result.data?.user_code}`);

    if (result.status === 200 && result.data?.user_code) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          userCode: result.data.user_code,
          deviceCode: result.data.device_code,
          verificationUrl: `https://ya.ru/device?user_code=${result.data.user_code}`,
          interval: result.data.interval || 3,
          expiresIn: result.data.expires_in || 300,
        })
      );
    } else {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: result.data?.error_description || "Error requesting device code" }));
    }
  } catch (e) {
    console.error("[AUTH] Error:", e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

// --- API: Poll for Token Confirmation ---
async function deviceTokenHandler(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;
  const deviceCode = query.deviceCode;
  if (!deviceCode) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing deviceCode" }));
    return;
  }

  try {
    const result = await httpsPostForm("https://oauth.yandex.ru/token", {
      grant_type: "device_code",
      code: deviceCode,
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
    });

    if (result.status === 200 && result.data?.access_token) {
      console.log("[AUTH] Device token granted successfully!");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "success", accessToken: result.data.access_token }));
    } else if (
      result.data?.error === "authorization_pending" ||
      result.data?.error === "slow_down"
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "pending" }));
    } else {
      console.log("[AUTH] Device token poll status:", result.data);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error", error: result.data?.error_description || result.data?.error }));
    }
  } catch (e) {
    console.error("[AUTH] Poll error:", e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "error", error: e.message }));
  }
}

// --- API: Login with Username / Password ---
async function authPasswordHandler(req, res, ctx) {
  const body = await ctx.parseBody(req);
  const { username, password } = body;

  if (!username || !password) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Укажите логин и пароль" }));
    return;
  }

  try {
    const result = await httpsPostForm("https://oauth.yandex.ru/token", {
      grant_type: "password",
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      username,
      password,
    });

    if (result.status === 200 && result.data?.access_token) {
      console.log(`[AUTH] User ${username} logged in via password!`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, accessToken: result.data.access_token }));
    } else {
      const desc = result.data?.error_description || result.data?.error || "Ошибка авторизации";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: desc }));
    }
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

module.exports = {
  deviceCodeHandler,
  deviceTokenHandler,
  authPasswordHandler,
};
