# TransferNow

Pendrive digital entre navegadores. Abra um portal, passe o código de 6 caracteres e jogue o arquivo: ele vai **direto** de um computador para o outro, por WebRTC, sem login e sem armazenamento no servidor.

**Produção:** https://transfernow.duia.com.br

## Como funciona

```
 Navegador A (envia)                               Navegador B (recebe)
   │ 1. POST /api/rooms → código                         │
   │──────────► Worker + Durable Object (1 por sala) ◄───│ 2. digita o código
   │ 3. troca de SDP/ICE pelo WebSocket da sala          │
   │◄───────────────────────────────────────────────────►│
   └════════ 4. DataChannel WebRTC (P2P, criptografado DTLS) ════════┘
              (se a rede bloquear: TURN da Cloudflare, só repassa)
```

- **Sinalização:** um Durable Object por código, com WebSocket Hibernation. O código vale 10 minutos, serve para um único receptor e some quando os dois saem.
- **Código:** 6 caracteres de um alfabeto de 21 símbolos legíveis no display de 14 segmentos (sem 0/O/D/Q, 1/I/L, 2/Z, 5/S, 6/G, 8/B, X, V). Há limite de tentativas por IP.
- **Transferência:** pedaços de 64 KB com controle de fluxo (`bufferedAmountLowThreshold`). Cada arquivo leva um SHA-256 verificado na chegada.
- **Arquivos grandes:** quem recebe grava em streaming por um Service Worker (`public/sw.js`), direto para a pasta de downloads, sem segurar o arquivo inteiro na memória. Navegadores sem Service Worker caem para download em memória.
- **Logs:** eventos de auditoria em JSON no Workers Logs. IPs e códigos entram só como hash; nomes e conteúdo de arquivos nunca são registrados.

## Estrutura

```
src/
  shared/code.ts        alfabeto do código e tipos das mensagens da sala
  worker/index.ts       rotas /api/* (config, ice, rooms, ws)
  worker/room.ts        Durable Object PortalRoom (sinalização)
  worker/log.ts         logs estruturados + hash
  client/main.ts        máquina de estados da interface
  client/p2p/           signaling, peer (WebRTC), sender, receiver, download (SW)
  client/scene/         portal 3D em Three.js (shaders, rastros de fogo, feixe de luz)
  client/ui/effects.ts  máquina de escrever, código rolando, formatação
public/sw.js            Service Worker de download em streaming
tests/e2e.mjs           dois navegadores trocando um arquivo de verdade
```

## Desenvolvimento

```bash
npm install
npm run dev            # build do site + wrangler dev em http://localhost:8787
npm run typecheck
npx wrangler d1 migrations apply transfernow --local
BASE_URL=http://localhost:8787 npm run test:e2e   # P2P; precisa do Chrome instalado
SESSION=<cookie tn_sess de um assinante> npm run test:e2e:cloud
```

## Planos

| Plano | Volume/mês | Transferências/mês | Por arquivo | Nuvem | Anúncio |
|---|---|---|---|---|---|
| Gratuito (sem login) | 5 GB | 10 | 5 GB | — | vídeo recompensado no envio e no download |
| Starter | 50 GB | 100 | 10 GB | 24 h | não |
| Scale | 200 GB | 200 | 50 GB | 72 h | não |
| Pró | ilimitado (uso justo 2 TB) | ilimitado | ilimitado | 7 dias | não |

Os limites ficam em `src/shared/plans.ts`. O gratuito conta por aparelho (cookie `tn_dev`) e, com teto 10× maior, por IP. No P2P o tamanho é informado pelo navegador; na nuvem é medido no servidor.

**Modo nuvem:** o arquivo sobe em partes (8–90 MB) direto para o R2 pelo Worker, sem chaves S3. Quem recebe baixa pelo código; cada arquivo é apagado quando o download termina, e uma rotina de hora em hora apaga o que venceu. A regra de ciclo de vida do bucket apaga qualquer objeto com mais de 8 dias como rede de segurança.

**Anúncio:** bloco *rewarded* do Google Ad Manager (GPT). A pessoa escolhe assistir, e o envio ou download é liberado quando o Google confirma a recompensa. Sem anúncio disponível, a transferência segue sem vídeo. Quem recebe só vê anúncio quando as duas pontas são do gratuito.

## Deploy

O deploy é feito pelo **Workers Builds** da Cloudflare: cada push na `main` roda `npm run build` e `npm run deploy:ci` (migrações do D1 + `wrangler deploy`).

### Configuração no painel (Workers → transfernow → Settings → Variables and Secrets)

| Nome | Tipo | Para que serve |
|---|---|---|
| `PRICE_STARTER`, `PRICE_SCALE`, `PRICE_PRO` | Variável | Preço mensal em reais (ex.: `19.90`). Sem preço, o plano aparece como "Em breve". |
| `ADS_REWARDED_UNIT` | Variável | Bloco rewarded do Google Ad Manager (ex.: `/1234567/transfernow_rewarded`). Sem ele, o gratuito não mostra vídeo. |
| `GOOGLE_CLIENT_ID` | Variável | Login com Google. |
| `GOOGLE_CLIENT_SECRET` | Segredo | Login com Google. |
| `MP_ACCESS_TOKEN` | Segredo | Credencial de produção do Mercado Pago. Sem ela, as assinaturas ficam fechadas. |
| `MP_WEBHOOK_SECRET` | Segredo | Assinatura secreta dos webhooks do Mercado Pago. |
| `MAX_FILE_SIZE_MB` | Variável | Limite extra por arquivo no gratuito, em MB. `-1` ou ausente = 5 GB do plano. |
| `LOG_SALT` | Segredo | Sal do hash de IP nos logs. |
| `TURN_KEY_ID`, `TURN_KEY_API_TOKEN` | Segredo | TURN da Cloudflare Realtime (opcional, recomendado). |

`keep_vars: true` impede que os deploys apaguem o que foi configurado no painel.

### Serviços externos

1. **E-mail do link de acesso:** Cloudflare → Compute → Email Service → Email Sending → *Onboard Domain* → `duia.com.br`. Remetente: `transfernow@duia.com.br` (variável `EMAIL_FROM`).
2. **Google:** Google Cloud Console → APIs e serviços → Credenciais → ID do cliente OAuth (aplicativo da Web). URI de redirecionamento: `https://transfernow.duia.com.br/api/auth/google/callback`.
3. **Mercado Pago:** Suas integrações → criar aplicação → credenciais de produção (`MP_ACCESS_TOKEN`). Em Webhooks, URL `https://transfernow.duia.com.br/api/billing/webhook` com os eventos de **Planos e assinaturas**; copie a assinatura secreta para `MP_WEBHOOK_SECRET`. O webhook sempre reconsulta a assinatura na API antes de liberar um plano.
4. **Anúncios:** conta no AdSense aprovada para `duia.com.br` → Google Ad Manager → bloco de anúncios do tipo *Rewarded* para web → desative a proteção "Block non-instream video ads" → coloque o caminho do bloco em `ADS_REWARDED_UNIT`.

### Registros de acesso (Marco Civil, art. 15)

A tabela `access_log` guarda IP, data e hora dos usos por 6 meses (183 dias), apagados pela rotina agendada. O acesso deve ser restrito e os dados só saem por ordem judicial.

## Licenças

Fontes DSEG por Keshikan (SIL Open Font License, ver `public/fonts/DSEG-LICENSE.txt`). Three.js (MIT).
