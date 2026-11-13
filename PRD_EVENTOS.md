# PRD: Módulo de Gestão de Eventos, Bilheteria Dinâmica e Portaria Offline-First

**Projeto:** Expansão da Plataforma Oficial — Atlética Furiozos (`atletica-furiozos.web.app`)
**Stack Existente:** HTML5/JS, Tailwind CSS, Firebase (Auth + Firestore + Hosting), Cloudflare Workers, Mercado Pago API.

## 1. Visão Geral e Objetivo

Integrar um sistema completo de bilheteria própria, venda de combos (Ingresso + Produto) e controle de portaria com validação criptográfica Offline-First diretamente na plataforma atual da Atlética, eliminando taxas de plataformas terceiras e mantendo total compatibilidade com o e-commerce existente.

## 2. Arquitetura de Dados (Firestore Schema)

### 2.1. Coleção `events`

- `id` (string): Identificador único / slug do evento.
- `title` (string): Nome da festa/evento.
- `description` (string): Descrição completa, atrações, open bar, regras.
- `date` (timestamp): Data e horário de início e fim.
- `location` (string): Local do evento e link do mapa.
- `bannerUrl` (string): Imagem de capa.
- `status` (string): `draft` | `published` | `paused` | `finished`.
- `activeBatchId` (string): Ponteiro para o lote ativo atual.
- `costs` (array/map): Custos fixos e variáveis cadastrados pela diretoria (ex: Som, DJ, Bebida, Segurança) para cálculo de break-even em tempo real.
- `createdAt` / `updatedAt` (timestamp).

### 2.2. Subcoleção `events/{eventId}/batches` (Lotes)

- `id` (string): ID do lote.
- `name` (string): Ex: "Lote Promocional", "1º Lote", "Lote Sócio".
- `order` (number): Ordem sequencial para virada automática (1, 2, 3...).
- `price` (number): Preço base.
- `memberPrice` (number, opcional): Preço com desconto para sócio/aluno verificado.
- `totalQuantity` (number): Limite total de ingressos deste lote.
- `soldQuantity` (number): Ingressos pagos e confirmados.
- `reservedQuantity` (number): Ingressos travados aguardando pagamento PIX (TTL de 10 minutos).
- `autoTurn` (boolean): Se `true`, ativa o próximo lote (`order + 1`) automaticamente quando `soldQuantity >= totalQuantity`.
- `comboItems` (array, opcional): IDs de produtos da loja vinculados (ex: Caneca + Tirante) para baixa automática de estoque.

### 2.3. Coleção `tickets`

- `id` (string): UUID do ingresso.
- `eventId` (string): Referência ao evento.
- `batchId` (string): Referência ao lote.
- `orderId` (string): Referência ao pedido/pagamento no Mercado Pago.
- `ownerUid` (string): UID do usuário titular atual.
- `ownerName` (string): Nome completo do titular.
- `ownerCpf` (string): Documento para conferência visual opcional.
- `ownerMatricula` (string, opcional): Matrícula universitária.
- `status` (string): `reserved` | `valid` | `used` | `transferred` | `cancelled`.
- `qrSignature` (string): Token assinado via HMAC-SHA256 gerado exclusivamente pelo Cloudflare Worker após confirmação do Webhook.
- `checkedInAt` (timestamp, null): Horário exato da leitura na portaria.
- `checkedInBy` (string, null): UID do diretor que realizou a leitura.
- `comboRedeemed` (boolean): Status de retirada dos itens físicos de combo no estande.
- `transferHistory` (array): Registro de transferências anteriores de titularidade.

## 3. Regras de Negócio no Backend (Cloudflare Workers + Mercado Pago)

### 3.1. Reserva Atômica e Anti-Overbooking (`POST /api/events/checkout`)

1. Verificar no Firestore se `(soldQuantity + reservedQuantity) < totalQuantity` no lote ativo.
2. Incrementar `reservedQuantity` e definir `expiresAt = now + 10 min`.
3. Criar pagamento PIX no Mercado Pago com `date_of_expiration` de 10 minutos e `external_reference` vinculando o pedido e os ingressos reservados.
4. Caso o pagamento expire, decrementar `reservedQuantity` devolvendo a vaga ao lote.

### 3.2. Emissão Criptográfica e Virada de Lote (`POST /api/webhooks/mercadopago`)

1. Ao confirmar status `approved` (validando assinatura `x-signature` do Mercado Pago):
2. Converter `reservedQuantity` em `soldQuantity`.
3. Se `soldQuantity >= totalQuantity` e `autoTurn == true`, atualizar `activeBatchId` do evento para o próximo lote na sequência.
4. Se for um ingresso **Combo**, abater automaticamente a quantidade correspondente no estoque de produtos da loja.
5. Gerar para cada ingresso o payload compacto: `v1:{ticketId}:{eventId}:{ownerUid}:{issuedAt}` assinado com **HMAC-SHA256** usando a variável de ambiente secreta `TICKET_SECRET_KEY` no Cloudflare Worker.
6. Salvar o ingresso com `status: "valid"` e `qrSignature` no Firestore.

### 3.3. Transferência de Titularidade (`POST /api/tickets/transfer`)

1. Permitido até X horas antes do início do evento e apenas para ingressos com `status: "valid"`.
2. Invalida o `qrSignature` anterior, atualiza `ownerUid`, `ownerName` e `ownerCpf`, gera uma nova assinatura HMAC-SHA256 e registra no `transferHistory`.

## 4. Especificações de Frontend e Experiência do Usuário

- **4.1. Vitrine de Eventos e Checkout Integrado:** Página do evento com barra de ocupação do lote, seleção de avulso ou Combo Festa, e Modal PIX com timer de 10 min e listener `onSnapshot`.
- **4.2. Carteira Digital ("Meus Ingressos"):** QR Code de alta resolução (separando QR de Entrada e QR de Retirada de Kit quando for combo), transferência de titularidade e exportação PDF.
- **4.3. Módulo de Portaria PWA Offline-First (`/portaria`):** Restrito a `admin`/`staff`. Botão de sincronização pré-evento para o **IndexedDB**. Leitura de câmera (`BarcodeDetector` / `html5-qrcode`) com feedback em <50ms (Tela Verde + Bip se válido; Tela Vermelha mostrando quem usou e o horário se já utilizado; Alerta se assinatura HMAC inválida). Fila de sincronização em background (`syncQueue`) para o Firestore e busca manual por Nome/CPF/Matrícula.
- **4.4. Dashboard Financeiro e Operacional da Diretoria (`/admin/eventos`):** CRUD de eventos/lotes, emissão de cortesias/VIPs, virada manual de lote com 1 clique, barra de Break-Even em tempo real (Receita Líquida vs Custos da Festa) e painel ao vivo da portaria (`checkedIn` vs `totalSold`).

## 5. Plano de Execução Iterativo (Milestones)

- **Milestone 1:** Mapeamento do repositório, atualização das `firestore.rules` e expansão do Cloudflare Worker (reserva, Webhook com HMAC-SHA256 e transferência).
- **Milestone 2:** Vitrine de eventos, checkout PIX com reserva e aba "Meus Ingressos".
- **Milestone 3:** Scanner de Portaria Offline-First (IndexedDB + Câmera + Sync Queue).
- **Milestone 4:** Painel da Diretoria e Dashboard Financeiro de Break-Even.

---

## Anexo A — Decisões de implementação (registro vivo)

Onde a implementação precisou detalhar ou ajustar o PRD. O texto acima continua sendo a fonte da verdade do escopo.

### A.1. Caminhos no Firestore

Tudo fica sob o mesmo namespace da loja, para reaproveitar regras e convenções:

| PRD | Caminho real |
| --- | --- |
| `events` | `artifacts/furiozos-app/public/data/events/{eventId}` |
| `events/{id}/batches` | `…/events/{eventId}/batches/{batchId}` |
| `tickets` | `artifacts/furiozos-app/public/data/tickets/{ticketId}` |
| (novo) pedidos de ingresso | `artifacts/furiozos-app/public/data/ticketOrders/{EV-XXXXXXXX}` |
| (novo) custos da festa | `…/events/{eventId}/private/finance` |
| (novo) equipe da portaria | `artifacts/furiozos-app/staff/{uid}` |
| (novo) sócios | `artifacts/furiozos-app/members/{uid}` |

### A.2. Ajustes de schema

- **`date`** virou dois campos timestamp: `startsAt` e `endsAt`. `location` é o texto e `mapUrl` o link do mapa.
- **`costs`** não fica no documento do evento (que é público): fica em `private/finance`, lido só pela diretoria.
- **Combo:** o lote ganhou `comboPrice`. Com `comboItems` preenchido, o comprador escolhe avulso (`price`) ou combo (`comboPrice`); os dois ocupam uma vaga do lote.
- **Preço de sócio:** vale para quem tem documento em `members/{uid}` (cadastro feito pela diretoria). O desconto `price − memberPrice` também é abatido do combo.
- **`ownerCpf`** é guardado mascarado (`***.456.789-**`), como já acontece nos pedidos da loja (LGPD). Serve para conferência visual; o CPF completo vai só ao Mercado Pago.
- **Ingresso** ganhou `kitSignature` (QR de retirada do kit), `isCombo`, `comboItems` (nomes), `courtesy`, `price`, `issuedAt`, `eventTitle`, `batchName`.
- **Status `transferred`:** o ingresso transferido continua `valid` com o novo titular; a transferência fica registrada em `transferHistory` (cada item com `status: "transferred"`).

### A.3. Assinatura e validação offline

- `TICKET_SECRET_KEY` nunca sai do Worker. Cada evento tem uma chave derivada: `HMAC-SHA256(TICKET_SECRET_KEY, "furiozos-ticket-key:v1:" + eventId)`.
- Token do QR: `v1:{ticketId}:{eventId}:{ownerUid}:{issuedAt}.{assinatura base64url}` (prefixo `k1:` para o QR do kit).
- A portaria baixa a chave **do evento** em `GET /api/events/{eventId}/portaria-key` (só admin/staff) durante a sincronização e valida offline. Se um aparelho vazar, só aquele evento é afetado.

### A.4. Rotas do Worker

| Rota | Quem | O que faz |
| --- | --- | --- |
| `POST /api/events/checkout` | logado, e-mail verificado | Reserva atômica + PIX de 10 min |
| `GET /api/events/orders/{orderId}` | dono do pedido | Status + reconciliação com o Mercado Pago |
| `POST /api/webhooks/mercadopago` | Mercado Pago | Mesmo webhook da loja (`/webhook/mercadopago` continua valendo); separa por prefixo `FZ-` / `EV-` |
| `POST /api/tickets/transfer` | titular / recebedor | `action: offer \| cancel \| accept` |
| `GET /api/events/{eventId}/portaria-key` | admin/staff | Chave do evento para validar offline |
| `POST /api/events/courtesy` | admin | Emite cortesias já com código de repasse |
| `POST /api/admin/roles` | admin | Cadastra equipe da portaria / sócio pelo e-mail da conta (ou UID) |
| cron `*/2 * * * *` | — | Devolve ao lote reservas vencidas |

### A.5. Regras de negócio detalhadas

- **Reserva:** commit atômico no Firestore com precondição `updateTime` do lote; em conflito, tenta de novo (até 7 vezes). Máximo de 5 ingressos por compra.
- **Expiração:** reserva vence em 10 min; a vaga volta ao lote 2 min depois (folga), pelo cron, pelo webhook de cancelamento ou quando alguém tenta comprar num lote cheio. Antes de devolver, o Worker confere no Mercado Pago se o PIX não foi pago.
- **Pagamento atrasado** (chegou depois de a vaga voltar): o ingresso é emitido mesmo assim e o pedido recebe um aviso para a diretoria.
- **Transferência em duas etapas:** o titular gera um código/link (vale 48 h ou até o prazo); quem recebe entra na própria conta, informa nome e CPF e assume o ingresso com assinatura nova. Prazo: até `TRANSFER_CUTOFF_HOURS` (6 h) antes do início; cortesia pode ser repassada até o fim do evento.
- **Estorno:** cancela os ingressos e desconta de `soldQuantity`.

### A.6. Testes

`node worker/test/eventos.test.mjs` roda o Worker inteiro contra um Firestore e um Mercado Pago simulados em memória (loja + bilheteria).

### A.7. Telas

- **Site (`/`)**: seção "Nossas Festas" (só com evento publicado), página do evento em `/?evento={id}`, PIX com timer e aba "Meus ingressos" no perfil — `public/assets/js/eventos.js`. Link de transferência: `/#transferir={código}`.
- **Painel da diretoria (`/admin/eventos`)**: `public/admin/eventos.html` + `public/assets/js/admin-eventos.js`. Abas por evento: Painel (KPIs, break-even, portaria ao vivo, virada de lote, custos), Dados, Lotes, Cortesias, Vendas (com exportação CSV); e aba geral Equipe e sócios.
- **Break-even:** receita líquida = soma dos pedidos pagos − taxa do PIX (padrão 0,99%, ajustável por evento e guardada em `private/finance.feePercent`), comparada à soma de `private/finance.costs`.

### A.8 Portaria offline-first (Milestone 3)

- **Arquivos**: `public/portaria.html`, `public/assets/js/portaria.js`, `public/portaria-sw.js` (service worker com escopo `/portaria`) e `public/portaria.webmanifest` (instalável na tela inicial).
- **Acesso**: mesma conta do site; libera para `admins/{uid}` ou `staff/{uid}`. O papel fica em cache no aparelho para abrir sem rede. A tela de acesso negado mostra e-mail e UID para a diretoria cadastrar em *Equipe e sócios*.
- **Baixar lista** (com internet): busca a chave do evento no Worker (`/api/events/{id}/portaria-key`), importa como chave **não exportável** e grava no IndexedDB (`fz-portaria`: `tickets`, `meta`, `queue`, `conflicts`) junto com todos os ingressos do evento. Com rede, um `onSnapshot` mantém a lista atualizada (vendas de última hora, transferências, entradas de outros aparelhos).
- **Leitura**: `BarcodeDetector` quando o navegador tem; senão `jsQR` 1.4.0 (CDN com SRI) no lugar do `html5-qrcode` — mais leve e roda sobre o mesmo `<video>`. Cada QR é conferido localmente: formato → evento → HMAC → lista → assinatura atual → status.
  - Verde + bip: entrada liberada (ou kit liberado, para o QR `k1`).
  - Vermelho: já entrou (com nome e horário), QR antigo (ingresso transferido), cancelado/estornado, outro evento, **assinatura inválida** (possível fraude).
  - Âmbar: assinatura verdadeira mas ingresso fora da lista baixada; permite liberação manual, conferida depois.
- **syncQueue**: toda entrada/retirada de kit é gravada primeiro no aparelho e entra na fila; sobe por transação do Firestore quando há rede (a cada 15 s, ao voltar a conexão ou pelo menu). Se o servidor já tinha entrada de outro aparelho, QR antigo ou ingresso cancelado, a leitura vira **conflito** na aba Registro, para a diretoria conferir.
- **Busca manual**: nome, 6 dígitos do meio do CPF (o CPF fica mascarado) ou matrícula; entrada e kit com confirmação em dois toques.
- **Cabeçalhos**: `Permissions-Policy` passou a `camera=(self)`; `connect-src` ganhou os CDNs já usados (para o service worker guardar a casca do app).
