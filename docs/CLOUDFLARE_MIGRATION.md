# Migration Vercel → Cloudflare Pages

## Ce qui a changé

- `chap-money/api/handler.ts` (fonction Vercel, style `req`/`res`) a été réécrit en
  `functions/api/[[path]].ts` (Cloudflare Pages Function, style `Request`/`Response`).
- `process.env.X` → `env.X` (les secrets sont maintenant configurés dans le dashboard
  Cloudflare Pages, pas dans `vercel.json`).
- `node:crypto` (`createHmac`, `randomBytes`, `timingSafeEqual`) reste utilisable grâce
  au flag de compatibilité `nodejs_compat` (voir `wrangler.toml`).
- **Correction incluse** : la vérification de signature du webhook FedaPay se fait
  maintenant sur le corps brut exact reçu (`request.text()`), plutôt que sur un
  `JSON.stringify(req.body)` re-sérialisé qui pouvait ne pas correspondre octet à octet
  à ce que FedaPay a signé.
- `vercel.json` référençait un package `@workspace/chap-money` qui n'existe pas (le
  frontend s'appelle `@workspace/mockup-sandbox`) — ce fichier n'est plus utilisé.

## Configuration à faire sur le dashboard Cloudflare Pages

**Build settings :**
- Build command : `pnpm --filter @workspace/api-spec run codegen && pnpm --filter @workspace/mockup-sandbox run build`
- Build output directory : `artifacts/mockup-sandbox/dist`
- Root directory : `/`

**Variables d'environnement (Settings → Environment variables) :**
- `FEDAPAY_SECRET_KEY`
- `FEDAPAY_MODE` (`sandbox` ou `live`)
- `FEDAPAY_WEBHOOK_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_PASSWORD`
- `SESSION_SECRET`

**Compatibility flags :** déjà définis dans `wrangler.toml` (`nodejs_compat`). Si tu
déploies aussi depuis le dashboard sans passer par `wrangler.toml`, ajoute le flag
manuellement dans Settings → Functions → Compatibility flags (Production et Preview).

## Routes API

Le fichier `functions/api/[[path]].ts` capture toutes les requêtes sous `/api/*`
(routing par fichier, propre à Cloudflare Pages Functions — pas besoin de `rewrites`
dans un fichier de config séparé).

## Ce qui n'a pas changé

- Toute la logique métier (FedaPay, Supabase, admin, credentials, webhook forwarding)
  a été conservée à l'identique.
- `chap-money/api/handler.ts` (ancienne version Vercel) est laissé dans le repo pour
  référence mais n'est plus utilisé.
