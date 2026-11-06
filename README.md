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
BASE_URL=http://localhost:8787 npm run test:e2e   # precisa do Chrome instalado
```

## Deploy

O deploy é feito pelo **Workers Builds** da Cloudflare: cada push na `main` roda `npm run build` e `npx wrangler deploy`.

### Configuração no painel (Workers → transfernow → Settings → Variables and Secrets)

| Nome | Tipo | Para que serve |
|---|---|---|
| `MAX_FILE_SIZE_MB` | Variável | Tamanho máximo por arquivo, em MB. `-1` ou ausente = sem limite. `1024` = 1 GB. |
| `LOG_SALT` | Segredo | Sal do hash de IP nos logs. Use um texto aleatório longo. |
| `TURN_KEY_ID` | Segredo | ID da chave TURN (Realtime → TURN Server). Opcional. |
| `TURN_KEY_API_TOKEN` | Segredo | Token da chave TURN. Opcional. |

O `wrangler.jsonc` usa `keep_vars: true`, então o que for configurado no painel não é apagado pelos próximos deploys.

O limite de tamanho é aplicado pelos dois navegadores: quem envia é avisado antes, e quem recebe recusa automaticamente. Como o arquivo nunca passa pelo servidor, não há como o servidor barrar o conteúdo em si.

### TURN (opcional, recomendado)

Sem TURN, cerca de 10–20% das conexões falham em redes restritivas (corporativas, 4G com NAT simétrico). O TURN da Cloudflare Realtime tem 1.000 GB/mês grátis e depois US$ 0,05/GB, cobrado só no tráfego que passa por ele. O STUN (`stun.cloudflare.com`) é grátis e ilimitado.

Para ativar: painel da Cloudflare → Realtime → TURN Server → criar chave → colocar `TURN_KEY_ID` e `TURN_KEY_API_TOKEN` como segredos do Worker.

## Licenças

Fontes DSEG por Keshikan (SIL Open Font License, ver `public/fonts/DSEG-LICENSE.txt`). Three.js (MIT).
