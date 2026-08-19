import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

// ─── Env types (Cloudflare Pages) ──────────────────────────────────────────
interface Env {
  FEDAPAY_SECRET_KEY: string;
  FEDAPAY_MODE?: "sandbox" | "live";
  FEDAPAY_WEBHOOK_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
}

// Identité propriétaire forcée — ne jamais utiliser les données client ici.
const OWNER_EMAIL = "Avenircc120@gmail.com";
const OWNER_FIRSTNAME = "Bien avenir";
const OWNER_LASTNAME = "Aveni";

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,PATCH,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Api-Key",
};

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

function noContent(status = 204): Response {
  return new Response(null, { status, headers: CORS_HEADERS });
}

// ─── FedaPay helpers ────────────────────────────────────────────────────────

function fedapayUrls(env: Env) {
  const mode = env.FEDAPAY_MODE ?? "sandbox";
  return {
    mode,
    api: mode === "live" ? "https://api.fedapay.com/v1" : "https://sandbox-api.fedapay.com/v1",
    checkout: mode === "live" ? "https://process.fedapay.com" : "https://sandbox-process.fedapay.com",
  };
}

async function fedapayRequest(
  env: Env,
  path: string,
  body: unknown,
  method: "POST" | "PUT" = "POST",
): Promise<Record<string, unknown>> {
  if (!env.FEDAPAY_SECRET_KEY) {
    throw new Error("FEDAPAY_SECRET_KEY non configurée — vérifiez les variables d'environnement Cloudflare Pages");
  }
  const { api } = fedapayUrls(env);

  const r = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.FEDAPAY_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await r.text();
  let data: Record<string, unknown> = {};
  try {
    if (text.trim()) data = JSON.parse(text);
  } catch {
    // Réponse non-JSON de FedaPay
  }

  if (!r.ok) {
    const msg =
      (data?.message as string) ??
      (data?.error as string) ??
      text.trim().slice(0, 200) ??
      `FedaPay HTTP ${r.status}`;
    throw new Error(`FedaPay [${r.status}] ${msg}`);
  }

  return data;
}

async function createTransaction(
  env: Env,
  params: {
    amount: number;
    description: string;
    customerEmail: string;
    customerFirstname: string;
    customerLastname: string;
    phoneNumber?: string;
    country?: string;
    mode?: string;
    callbackUrl?: string;
  },
): Promise<{ id: number; status: string }> {
  const data = await fedapayRequest(env, "/transactions", {
    description: params.description,
    amount: params.amount,
    currency: { iso: "XOF" },
    customer: {
      firstname: params.customerFirstname,
      lastname: params.customerLastname,
      email: params.customerEmail,
      ...(params.phoneNumber && params.country
        ? { phone_number: { number: params.phoneNumber, country: params.country.toLowerCase() } }
        : {}),
    },
    ...(params.mode ? { mode: params.mode } : {}),
    ...(params.callbackUrl ? { callback_url: params.callbackUrl } : {}),
  });
  const tx =
    (data["v1/transaction"] as Record<string, unknown>) ??
    (data.transaction as Record<string, unknown>) ??
    data;
  const id = tx.id as number;
  if (!id) throw new Error("ID transaction FedaPay introuvable");
  return { id, status: (tx.status as string) ?? "pending" };
}

async function generateToken(env: Env, txId: number): Promise<{ token: string; url?: string }> {
  const data = await fedapayRequest(env, `/transactions/${txId}/token`, {});
  const tokenObj = data.token as Record<string, unknown> | string | undefined;
  const token = typeof tokenObj === "string" ? tokenObj : (tokenObj?.token as string);
  const url = (data.url as string) ?? ((tokenObj as Record<string, unknown>)?.url as string);
  if (!token) throw new Error("Token FedaPay introuvable");
  return { token, url };
}

// ─── Supabase persistence ───────────────────────────────────────────────────
// Chap Money utilise le projet Supabase comme unique base applicative.

async function supabaseRequest<T = unknown>(env: Env, table: string, init: RequestInit = {}): Promise<T> {
  const base = (env.SUPABASE_URL ?? "").replace(/\/$/, "");
  if (!base || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY doivent être configurées");
  }
  const response = await fetch(`${base}/rest/v1/${table}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase [${response.status}] ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

async function savePayment(
  env: Env,
  params: {
    fedapayId: number;
    amount: number;
    description: string;
    customerEmail: string;
    customerFirstname: string;
    customerLastname: string;
    status: string;
    paymentType: "mobile" | "card";
    operator?: string;
    country?: string;
    phoneNumber?: string;
    paymentUrl?: string;
    apiPublicKey?: string | null;
  },
): Promise<void> {
  try {
    await supabaseRequest(env, "payments", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        fedapay_id: params.fedapayId,
        amount: params.amount,
        description: params.description,
        customer_email: params.customerEmail,
        customer_firstname: params.customerFirstname,
        customer_lastname: params.customerLastname,
        status: params.status,
        payment_type: params.paymentType,
        operator: params.operator ?? null,
        country: params.country ?? null,
        phone_number: params.phoneNumber ?? null,
        payment_url: params.paymentUrl ?? null,
        api_public_key: params.apiPublicKey ?? null,
        mode: fedapayUrls(env).mode,
      }),
    });
  } catch (e) {
    // Sauvegarde DB non-critique — on log et on continue
    console.error("DB save failed:", e);
  }
}

// ─── API key resolver ───────────────────────────────────────────────────────
// Valide la clé publique du site (header X-Api-Key ou champ apiPublicKey dans le body).

async function resolveApiKey(env: Env, request: Request, body: Record<string, unknown>): Promise<string | null> {
  const raw = request.headers.get("x-api-key") ?? (body.apiPublicKey as string | undefined) ?? "";
  if (!raw.trim()) return null;
  const key = raw.trim();
  try {
    const rows = await supabaseRequest<Array<{ public_key: string }>>(
      env,
      `api_credentials?public_key=eq.${encodeURIComponent(key)}&is_active=eq.true&select=public_key&limit=1`,
    );
    return rows[0]?.public_key ?? null;
  } catch {
    return null; // non-bloquant : le paiement continue sans attribution de site
  }
}

// ─── Checkout handlers ───────────────────────────────────────────────────────

async function handleMobile(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const { amount, description, phoneNumber, country, operator } = body as Record<string, string | number>;

  if (!amount || !phoneNumber || !country || !operator) {
    return json({ error: "Champs requis manquants" }, 400);
  }

  const desc = description ? String(description) : "Paiement Chap Money";

  let tx: { id: number; status: string };
  try {
    tx = await createTransaction(env, {
      amount: Number(amount),
      description: desc,
      customerEmail: OWNER_EMAIL,
      customerFirstname: OWNER_FIRSTNAME,
      customerLastname: OWNER_LASTNAME,
      phoneNumber: String(phoneNumber),
      country: String(country),
      mode: String(operator),
    });
  } catch (e) {
    throw new Error(`[étape 1 – create] ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log(`[mobile] transaction créée id=${tx.id}`);

  let token: string;
  try {
    const t = await generateToken(env, tx.id);
    token = t.token;
  } catch (e) {
    throw new Error(`[étape 2 – token] ${e instanceof Error ? e.message : String(e)}`);
  }

  // Étape 3 — POST /v1/{mode} avec checkout token comme Bearer
  const { api } = fedapayUrls(env);
  const pushUrl = `${api}/${String(operator)}`;
  console.log(`[mobile] push → ${pushUrl} token=${token.slice(0, 12)}...`);
  let pushResp: Record<string, unknown>;
  try {
    const r = await fetch(pushUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.FEDAPAY_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token,
        phone_number: { number: String(phoneNumber), country: String(country).toLowerCase() },
      }),
    });
    const text = await r.text();
    let data: Record<string, unknown> = {};
    try {
      if (text.trim()) data = JSON.parse(text);
    } catch {
      // ignore
    }
    if (!r.ok) {
      const msg = (data?.message as string) ?? (data?.error as string) ?? text.trim().slice(0, 400);
      throw new Error(`FedaPay [${r.status}] ${msg}`);
    }
    pushResp = data;
  } catch (e) {
    throw new Error(`[étape 3 – push txId=${tx.id}] ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log(`[mobile] push OK → ${JSON.stringify(pushResp).slice(0, 120)}`);

  const apiPublicKey = await resolveApiKey(env, request, body);

  await savePayment(env, {
    fedapayId: tx.id,
    amount: Number(amount),
    description: desc,
    customerEmail: OWNER_EMAIL,
    customerFirstname: OWNER_FIRSTNAME,
    customerLastname: OWNER_LASTNAME,
    status: "pending",
    paymentType: "mobile",
    operator: String(operator),
    country: String(country),
    phoneNumber: String(phoneNumber),
    apiPublicKey,
  });

  return json({
    transactionId: tx.id,
    status: "pending",
    message: "Demande envoyée sur votre téléphone. Validez via votre opérateur.",
  });
}

async function handleCard(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const { amount, description } = body as Record<string, string | number>;

  if (!amount) {
    return json({ error: "Champs requis manquants" }, 400);
  }

  const desc = description ? String(description) : "Paiement Chap Money";

  const tx = await createTransaction(env, {
    amount: Number(amount),
    description: desc,
    customerEmail: OWNER_EMAIL,
    customerFirstname: OWNER_FIRSTNAME,
    customerLastname: OWNER_LASTNAME,
  });

  const { token, url } = await generateToken(env, tx.id);
  const { checkout } = fedapayUrls(env);
  const paymentUrl = url ?? `${checkout}/${token}`;
  const apiPublicKey = await resolveApiKey(env, request, body);

  await savePayment(env, {
    fedapayId: tx.id,
    amount: Number(amount),
    description: desc,
    customerEmail: OWNER_EMAIL,
    customerFirstname: OWNER_FIRSTNAME,
    customerLastname: OWNER_LASTNAME,
    status: "pending",
    paymentType: "card",
    paymentUrl,
    apiPublicKey,
  });

  return json({ transactionId: tx.id, paymentUrl });
}

async function handleCardSave(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const { transactionId, amount, description, status } = body as Record<string, string | number>;

  if (!transactionId) {
    return json({ error: "transactionId requis" }, 400);
  }

  const apiPublicKey = await resolveApiKey(env, request, body);

  await savePayment(env, {
    fedapayId: Number(transactionId),
    amount: Number(amount) || 0,
    description: description ? String(description) : "Paiement Chap Money",
    customerEmail: OWNER_EMAIL,
    customerFirstname: OWNER_FIRSTNAME,
    customerLastname: OWNER_LASTNAME,
    status: status ? String(status) : "pending",
    paymentType: "card",
    apiPublicKey,
  });

  return json({ ok: true });
}

async function handleStatus(env: Env, transactionId: string): Promise<Response> {
  if (!transactionId || !/^\d+$/.test(transactionId)) {
    return json({ error: "transactionId invalide" }, 400);
  }

  const { api } = fedapayUrls(env);
  const r = await fetch(`${api}/transactions/${transactionId}`, {
    headers: { Authorization: `Bearer ${env.FEDAPAY_SECRET_KEY}` },
  });
  const data = (await r.json()) as Record<string, unknown>;
  if (!r.ok) throw new Error((data?.message as string) ?? "Erreur statut FedaPay");

  const tx =
    (data["v1/transaction"] as Record<string, unknown>) ??
    (data.transaction as Record<string, unknown>) ??
    data;
  const status = (tx.status as string) ?? "pending";

  try {
    await supabaseRequest(env, `payments?fedapay_id=eq.${encodeURIComponent(transactionId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
    });
  } catch {
    // non-critique
  }

  return json({ transactionId, status });
}

// ─── Admin auth ───────────────────────────────────────────────────────────

function signAdminToken(env: Env): string {
  const secret = env.SESSION_SECRET ?? "change-me";
  const payload = JSON.stringify({ role: "admin", exp: Date.now() + TOKEN_TTL_MS });
  const data = Buffer.from(payload).toString("base64url");
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifyAdminToken(env: Env, token: string): boolean {
  const secret = env.SESSION_SECRET ?? "change-me";
  const dot = token.lastIndexOf(".");
  if (dot === -1) return false;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(data).digest("base64url");
  if (sig !== expected) return false;
  try {
    const p = JSON.parse(Buffer.from(data, "base64url").toString()) as { role: string; exp: number };
    return p.role === "admin" && p.exp > Date.now();
  } catch {
    return false;
  }
}

function requireAdmin(env: Env, request: Request): Response | null {
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || !verifyAdminToken(env, auth.slice(7))) {
    return json({ error: "Non autorisé" }, 401);
  }
  return null;
}

// ─── Admin handlers ─────────────────────────────────────────────────────────

async function handleAdminLogin(env: Env, request: Request): Promise<Response> {
  const { password } = (await request.json().catch(() => ({}))) as { password?: string };
  if (!env.ADMIN_PASSWORD) {
    return json({ error: "ADMIN_PASSWORD non configuré" }, 500);
  }
  if (!password || password !== env.ADMIN_PASSWORD) {
    return json({ error: "Mot de passe incorrect" }, 401);
  }
  return json({ token: signAdminToken(env) });
}

async function handleAdminStats(env: Env): Promise<Response> {
  const [total, approved, revenue, sites] = await Promise.all([
    supabaseRequest<Array<{ id: string }>>(env, "payments?select=id"),
    supabaseRequest<Array<{ id: string }>>(env, "payments?status=eq.approved&select=id"),
    supabaseRequest<Array<{ amount: number }>>(env, "payments?status=eq.approved&select=amount"),
    supabaseRequest<Array<{ id: string }>>(env, "api_credentials?is_active=eq.true&select=id"),
  ]);
  return json({
    totalPayments: total.length,
    approvedPayments: approved.length,
    totalRevenue: revenue.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
    activeSites: sites.length,
  });
}

async function handleAdminPayments(env: Env, request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const limit = Math.min(Number(q.get("limit") ?? 50), 100);
  const offset = Number(q.get("offset") ?? 0);
  const siteFilter = (q.get("siteName") ?? "").trim().toLowerCase();
  const [payments, credentials] = await Promise.all([
    supabaseRequest<Array<Record<string, unknown>>>(env, "payments?select=*&order=created_at.desc"),
    supabaseRequest<Array<{ public_key: string; site_name: string }>>(env, "api_credentials?select=public_key,site_name"),
  ]);
  const sitesByKey = new Map(credentials.map((row) => [row.public_key, row.site_name]));
  const rows = payments
    .map((payment) => ({
      id: payment.id,
      fedapayId: payment.fedapay_id,
      amount: payment.amount,
      description: payment.description,
      status: payment.status,
      mode: payment.mode,
      paymentType: payment.payment_type,
      operator: payment.operator,
      country: payment.country,
      phoneNumber: payment.phone_number,
      apiPublicKey: payment.api_public_key,
      siteName: payment.api_public_key ? sitesByKey.get(String(payment.api_public_key)) ?? null : null,
      createdAt: payment.created_at,
    }))
    .filter((row) => !siteFilter || String(row.siteName ?? "").toLowerCase().includes(siteFilter))
    .slice(offset, offset + limit);
  return json(rows);
}

async function handleAdminWallet(env: Env, request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const siteName = (q.get("siteName") ?? q.get("site") ?? "").trim().toLowerCase();
  const transactions = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    "wallet_transactions?select=*&order=created_at.desc",
  );
  const filtered = transactions.filter((row) => !siteName || String(row.site_name ?? "").toLowerCase() === siteName);
  const amountOf = (row: Record<string, unknown>) => Number(row.amount ?? row.value ?? 0);
  const typeOf = (row: Record<string, unknown>) =>
    String(row.type ?? row.transaction_type ?? row.kind ?? "").toLowerCase();
  const withdrawals = filtered.filter((row) => ["retrait", "withdrawal", "debit"].includes(typeOf(row)));
  const balance = filtered.reduce(
    (sum, row) => sum + (withdrawals.includes(row) ? -amountOf(row) : amountOf(row)),
    0,
  );
  return json({
    balance,
    totalTransactions: filtered.length,
    deposits: filtered
      .filter((row) => ["depot", "deposit", "credit"].includes(typeOf(row)))
      .reduce((sum, row) => sum + amountOf(row), 0),
    withdrawals: withdrawals.reduce((sum, row) => sum + amountOf(row), 0),
  });
}

async function handleAdminWalletTransactions(
  env: Env,
  request: Request,
  wantedType: "deposit" | "withdrawal",
): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const siteName = (q.get("siteName") ?? q.get("site") ?? "").trim().toLowerCase();
  const limit = Math.min(Number(q.get("limit") ?? 50), 100);
  const offset = Number(q.get("offset") ?? 0);
  const rows = await supabaseRequest<Array<Record<string, unknown>>>(env, "wallet_transactions?select=*&order=created_at.desc");
  const types = wantedType === "deposit" ? ["depot", "deposit", "credit"] : ["retrait", "withdrawal", "debit"];
  return json(
    rows
      .filter((row) => !siteName || String(row.site_name ?? "").toLowerCase() === siteName)
      .filter((row) => types.includes(String(row.type ?? row.transaction_type ?? row.kind ?? "").toLowerCase()))
      .slice(offset, offset + limit),
  );
}

async function handleAdminUsers(env: Env, request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const siteName = (q.get("siteName") ?? q.get("site") ?? "").trim().toLowerCase();
  const rows = await supabaseRequest<Array<Record<string, unknown>>>(env, "user_profiles?select=*&order=created_at.desc");
  const users = rows.filter((row) => !siteName || String(row.site_name ?? "").toLowerCase() === siteName);
  return json({ count: users.length, users });
}

// ─── Credentials handlers ───────────────────────────────────────────────────

function genKey(prefix: string): string {
  return `${prefix}_${randomBytes(20).toString("hex")}`;
}

async function handleGetCredentials(env: Env): Promise<Response> {
  // secret_key et webhook_key ne sont JAMAIS renvoyés dans le listing :
  // ils sont affichés une seule fois à la création / régénération.
  const rows = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    "api_credentials?select=id,site_name,webhook_url,public_key,is_active,created_at&order=created_at.desc",
  );
  return json(
    rows.map((row) => ({
      id: row.id,
      siteName: row.site_name,
      webhookUrl: row.webhook_url,
      publicKey: row.public_key,
      isActive: row.is_active,
      createdAt: row.created_at,
    })),
  );
}

async function handleCreateCredential(env: Env, request: Request): Promise<Response> {
  const { siteName, webhookUrl } = (await request.json().catch(() => ({}))) as {
    siteName?: string;
    webhookUrl?: string;
  };
  if (!siteName?.trim() || !webhookUrl?.trim()) {
    return json({ error: "siteName et webhookUrl requis" }, 400);
  }
  const publicKey = genKey("pk");
  const secretKey = genKey("sk");
  const webhookKey = genKey("wk");
  const rows = await supabaseRequest<Array<Record<string, unknown>>>(env, "api_credentials", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      site_name: siteName.trim(),
      webhook_url: webhookUrl.trim(),
      public_key: publicKey,
      secret_key: secretKey,
      webhook_key: webhookKey,
    }),
  });
  const row = rows[0];
  return json(
    {
      id: row.id,
      siteName: row.site_name,
      webhookUrl: row.webhook_url,
      publicKey: row.public_key,
      secretKey: row.secret_key,
      webhookKey: row.webhook_key,
      isActive: row.is_active,
      createdAt: row.created_at,
    },
    201,
  );
}

async function handleDeleteCredential(env: Env, id: string): Promise<Response> {
  await supabaseRequest(env, `api_credentials?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
  return noContent();
}

async function handleToggleCredential(env: Env, id: string): Promise<Response> {
  const current = await supabaseRequest<Array<{ id: string; is_active: boolean }>>(
    env,
    `api_credentials?id=eq.${encodeURIComponent(id)}&select=id,is_active`,
  );
  if (!current[0]) return json({ error: "Credential introuvable" }, 404);
  const rows = await supabaseRequest<Array<{ id: string; is_active: boolean }>>(
    env,
    `api_credentials?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ is_active: !current[0].is_active, updated_at: new Date().toISOString() }),
    },
  );
  return json({ id: rows[0].id, isActive: rows[0].is_active });
}

async function handleRegenerateCredential(env: Env, id: string): Promise<Response> {
  const publicKey = genKey("pk");
  const secretKey = genKey("sk");
  const webhookKey = genKey("wk");
  const rows = await supabaseRequest<Array<Record<string, unknown>>>(
    env,
    `api_credentials?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        public_key: publicKey,
        secret_key: secretKey,
        webhook_key: webhookKey,
        updated_at: new Date().toISOString(),
      }),
    },
  );
  if (!rows[0]) return json({ error: "Credential introuvable" }, 404);
  return json({
    id: rows[0].id,
    siteName: rows[0].site_name,
    webhookUrl: rows[0].webhook_url,
    publicKey: rows[0].public_key,
    secretKey: rows[0].secret_key,
    webhookKey: rows[0].webhook_key,
    isActive: rows[0].is_active,
  });
}

// ─── Webhook helpers ─────────────────────────────────────────────────────────

function verifyFedapaySignature(rawBody: string, header: string, secret: string): boolean {
  // Header format: t=timestamp,v1=hmac_sha256_hex
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const timestamp = parts["t"];
  const v1 = parts["v1"];
  if (!timestamp || !v1) return false;

  const signed = `${timestamp}.${rawBody}`;
  const expected = createHmac("sha256", secret).update(signed).digest("hex");

  try {
    return timingSafeEqual(Buffer.from(v1, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

async function handleWebhook(env: Env, request: Request): Promise<Response> {
  const secret = env.FEDAPAY_WEBHOOK_SECRET ?? "";
  if (!secret) {
    console.error("[webhook] FEDAPAY_WEBHOOK_SECRET non configuré");
    return json({ error: "Webhook secret manquant" }, 500);
  }

  const signature = request.headers.get("x-fedapay-signature") ?? "";
  // Important : on vérifie la signature sur le corps brut exact reçu,
  // pas sur un JSON.stringify(re-parsé) qui pourrait différer octet à octet.
  const rawBody = await request.text();

  if (!verifyFedapaySignature(rawBody, signature, secret)) {
    console.warn("[webhook] Signature invalide — requête rejetée");
    return json({ error: "Signature invalide" }, 401);
  }

  const payload = JSON.parse(rawBody) as Record<string, unknown>;
  const event = payload.event as string;
  const data = (payload.data as Record<string, unknown>) ?? {};
  const tx = (data["v1/transaction"] ?? data.transaction ?? {}) as Record<string, unknown>;
  const fedapayId = tx.id as number | undefined;

  console.log(`[webhook] event=${event} fedapayId=${fedapayId}`);

  const STATUS_MAP: Record<string, string> = {
    "transaction.approved": "approved",
    "transaction.declined": "declined",
    "transaction.canceled": "canceled",
    "transaction.refunded": "refunded",
    "transaction.transferred": "transferred",
  };

  const newStatus = STATUS_MAP[event];
  if (fedapayId && newStatus) {
    try {
      await supabaseRequest(env, `payments?fedapay_id=eq.${encodeURIComponent(String(fedapayId))}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: newStatus, updated_at: new Date().toISOString() }),
      });
      console.log(`[webhook] paiement ${fedapayId} → ${newStatus}`);
    } catch (e) {
      console.error("[webhook] DB update échouée:", e);
    }
  }

  // Forwarding vers le webhook du site client
  if (fedapayId && newStatus) {
    try {
      const pmts = await supabaseRequest<Array<{ api_public_key: string | null }>>(
        env,
        `payments?fedapay_id=eq.${encodeURIComponent(String(fedapayId))}&select=api_public_key&limit=1`,
      );
      const pubKey = pmts[0]?.api_public_key ?? undefined;
      if (pubKey) {
        const creds = await supabaseRequest<Array<{ webhook_url?: string; webhook_key?: string }>>(
          env,
          `api_credentials?public_key=eq.${encodeURIComponent(pubKey)}&is_active=eq.true&select=webhook_url,webhook_key&limit=1`,
        );
        const cred = creds[0];
        if (cred?.webhook_url && cred?.webhook_key) {
          const body = JSON.stringify({ event, fedapayId, status: newStatus, transaction: tx });
          const sig = createHmac("sha256", cred.webhook_key).update(body).digest("hex");
          await fetch(cred.webhook_url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Chap-Signature": sig },
            body,
          });
          console.log(`[webhook] forwarded → ${cred.webhook_url}`);
        }
      }
    } catch (e) {
      console.error("[webhook] forwarding échoué:", e);
    }
  }

  return json({ received: true });
}

// ─── Main handler (Cloudflare Pages Function) ───────────────────────────────

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: CORS_HEADERS });
  }

  const { pathname } = new URL(request.url);

  try {
    if (pathname.includes("/api/webhook") && request.method === "POST") {
      return await handleWebhook(env, request);
    }
    if (pathname.includes("/api/checkout/mobile") && request.method === "POST") {
      return await handleMobile(env, request);
    }
    if (pathname.includes("/api/checkout/card/save") && request.method === "POST") {
      return await handleCardSave(env, request);
    }
    if (pathname.includes("/api/checkout/card") && request.method === "POST") {
      return await handleCard(env, request);
    }
    const statusMatch = pathname.match(/\/api\/checkout\/status\/(\d+)/);
    if (statusMatch && request.method === "GET") {
      return await handleStatus(env, statusMatch[1]);
    }
    if (pathname.includes("/api/healthz") || pathname.includes("/api/health")) {
      return json({ status: "ok" });
    }

    // ── Routes admin ──────────────────────────────────────────────────────
    if (pathname.includes("/api/admin/login") && request.method === "POST") {
      return await handleAdminLogin(env, request);
    }
    if (pathname.includes("/api/admin/stats") && request.method === "GET") {
      const denied = requireAdmin(env, request);
      if (denied) return denied;
      return await handleAdminStats(env);
    }
    if (pathname.includes("/api/admin/payments") && request.method === "GET") {
      const denied = requireAdmin(env, request);
      if (denied) return denied;
      return await handleAdminPayments(env, request);
    }
    if (pathname.includes("/api/admin/wallet") && request.method === "GET") {
      const denied = requireAdmin(env, request);
      if (denied) return denied;
      return await handleAdminWallet(env, request);
    }
    if (pathname.includes("/api/admin/deposits") && request.method === "GET") {
      const denied = requireAdmin(env, request);
      if (denied) return denied;
      return await handleAdminWalletTransactions(env, request, "deposit");
    }
    if (pathname.includes("/api/admin/withdrawals") && request.method === "GET") {
      const denied = requireAdmin(env, request);
      if (denied) return denied;
      return await handleAdminWalletTransactions(env, request, "withdrawal");
    }
    if (pathname.includes("/api/admin/users") && request.method === "GET") {
      const denied = requireAdmin(env, request);
      if (denied) return denied;
      return await handleAdminUsers(env, request);
    }

    // ── Routes credentials ────────────────────────────────────────────────
    if (pathname.match(/\/api\/credentials\/[\w-]+\/regenerate$/) && request.method === "POST") {
      const denied = requireAdmin(env, request);
      if (denied) return denied;
      const m = pathname.match(/\/api\/credentials\/([\w-]+)\/regenerate/)!;
      return await handleRegenerateCredential(env, m[1]);
    }
    if (pathname.match(/\/api\/credentials\/[\w-]+\/toggle$/) && request.method === "PATCH") {
      const denied = requireAdmin(env, request);
      if (denied) return denied;
      const m = pathname.match(/\/api\/credentials\/([\w-]+)\/toggle/)!;
      return await handleToggleCredential(env, m[1]);
    }
    if (pathname.match(/\/api\/credentials\/[\w-]+$/) && request.method === "DELETE") {
      const denied = requireAdmin(env, request);
      if (denied) return denied;
      const m = pathname.match(/\/api\/credentials\/([\w-]+)$/)!;
      return await handleDeleteCredential(env, m[1]);
    }
    if (pathname.includes("/api/credentials") && request.method === "GET") {
      const denied = requireAdmin(env, request);
      if (denied) return denied;
      return await handleGetCredentials(env);
    }
    if (pathname.includes("/api/credentials") && request.method === "POST") {
      const denied = requireAdmin(env, request);
      if (denied) return denied;
      return await handleCreateCredential(env, request);
    }

    return json({ error: "Route inconnue" }, 404);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Erreur serveur";
    console.error("[API Error]", message);
    return json({ error: message }, 500);
  }
};
