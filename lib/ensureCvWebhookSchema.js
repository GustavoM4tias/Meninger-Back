// lib/ensureCvWebhookSchema.js
//
// Entrada por webhook do CV e o registro de execuções da integração.
//
// Duas tabelas, com propósitos bem diferentes:
//
//   cv_webhook_endpoints  - uma linha por funcionalidade do CV (reservas,
//       repasses). O CV deixa apontar um webhook por funcionalidade e gatilho,
//       então a configuração acompanha esse recorte. Cada linha tem o próprio
//       token, porque revogar o de repasses não pode derrubar o de reservas.
//
//   cv_integration_events - o histórico que não existia. Até aqui o único
//       registro era `cv_sync_state`, que guarda UMA linha por job e é
//       sobrescrita a cada rodada: dava para saber se a última execução deu
//       certo, nunca o que aconteceu antes dela. Sem isso não há como
//       responder "o CV está mesmo entregando os eventos?", que é a pergunta
//       que decide se o cron pode ser rebaixado a validador.
//
// O campo `processa` é o que permite ligar uma funcionalidade em MODO ESCUTA:
// o endpoint aceita, registra o corpo cru e não age. É assim que o formato do
// payload de repasse é descoberto - com o dado real que o CV manda, sem que um
// palpite errado escreva no espelho.

import crypto from 'crypto';
import db from '../models/sequelize/index.js';
import { applyOnce } from './schemaPatchMarks.js';

const FUNCIONALIDADES = [
    {
        key: 'reservas',
        // Reservas entra processando: é o alvo desta entrega e o caminho de
        // busca por id (/v1/comercial/reservas/{id}) já é o que o gap usa.
        processa: true,
        descricao: 'Reservas - alteração de situação e entrada em Nova Reserva.',
    },
    {
        key: 'repasses',
        // O id do aviso pode ser idrepasse ou idreserva - o CV não documenta
        // qual. O processador confere qual dos dois é antes de gravar, em vez
        // de supor (RepasseSyncService.syncPorIdDoWebhook), então dá para
        // entrar processando.
        processa: true,
        descricao: 'Repasses - alteração de situação. Entra na cadeia contrato → repasse → reserva → lead.',
    },
    {
        key: 'leads',
        processa: true,
        descricao: 'Leads - alteração de situação. Alimenta Marketing e a atribuição de mídia.',
    },
    {
        key: 'precadastros',
        processa: true,
        descricao: 'Pré-cadastros - alteração de situação. A tela de Pré-Cadastros lê daqui.',
    },
];

const STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS cv_webhook_endpoints (
        funcionalidade    VARCHAR(40)  PRIMARY KEY,
        active            BOOLEAN      NOT NULL DEFAULT false,
        processa          BOOLEAN      NOT NULL DEFAULT false,
        token             VARCHAR(80)  NOT NULL,
        descricao         TEXT,
        last_event_at     TIMESTAMPTZ,
        last_status       VARCHAR(20),
        last_message      TEXT,
        eventos_recebidos BIGINT       NOT NULL DEFAULT 0,
        created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS cv_integration_events (
        id             BIGSERIAL    PRIMARY KEY,
        origem         VARCHAR(20)  NOT NULL,
        funcionalidade VARCHAR(40)  NOT NULL,
        entidade_id    INTEGER,
        status         VARCHAR(20)  NOT NULL,
        mensagem       TEXT,
        duracao_ms     INTEGER,
        payload        JSONB,
        stats          JSONB,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,

    // A tela lê sempre "os últimos N", e o filtro por funcionalidade é o
    // recorte natural. O índice por entidade responde "o que já aconteceu com
    // a reserva 7076", que é a pergunta de quem está investigando um caso.
    `CREATE INDEX IF NOT EXISTS cv_integration_events_recentes_idx
         ON cv_integration_events (created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS cv_integration_events_func_idx
         ON cv_integration_events (funcionalidade, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS cv_integration_events_entidade_idx
         ON cv_integration_events (entidade_id)
      WHERE entidade_id IS NOT NULL`,

    // Retenção do histórico: mora no singleton do módulo, editável na tela.
    // Constante em código aqui seria regra travada - ver CLAUDE.md.
    `ALTER TABLE cv_panel_settings
        ADD COLUMN IF NOT EXISTS historico_eventos_dias INTEGER DEFAULT 30`,
];

/** Token de URL. CSPRNG porque ele É a autenticação deste endpoint. */
const novoToken = () => crypto.randomBytes(24).toString('hex');

export async function ensureCvWebhookSchema() {
    let applied = 0, failed = 0;
    for (const sql of STATEMENTS) {
        try { await db.sequelize.query(sql); applied++; }
        catch (err) {
            failed++;
            console.warn(`⚠️  [SchemaPatch] Falha em statement: ${err.message}`);
            console.warn(`    SQL: ${sql.slice(0, 100)}...`);
        }
    }

    // Semeia uma linha por funcionalidade. Nasce DESLIGADA de propósito: o
    // endpoint só passa a existir de verdade quando alguém liga na tela e cola
    // a URL no CV. Ligar sozinho seria abrir uma porta que ninguém pediu.
    for (const f of FUNCIONALIDADES) {
        try {
            await db.sequelize.query(`
                INSERT INTO cv_webhook_endpoints (funcionalidade, active, processa, token, descricao)
                     VALUES (:key, false, :processa, :token, :descricao)
                ON CONFLICT (funcionalidade) DO NOTHING
            `, {
                replacements: {
                    key: f.key,
                    processa: f.processa,
                    token: novoToken(),
                    descricao: f.descricao,
                },
            });
        } catch (err) {
            console.warn(`⚠️  [SchemaPatch] Semeadura do webhook "${f.key}" falhou: ${err.message}`);
        }
    }

    // A linha de repasses nasceu com `processa = false` em 28/08/2026, quando
    // ainda não se sabia se o CV manda idrepasse ou idreserva no aviso. O
    // processador passou a conferir qual dos dois é (ver
    // RepasseSyncService.syncPorIdDoWebhook), então o modo escuta deixou de ser
    // necessário. Como o `INSERT ... DO NOTHING` acima não toca em linha
    // existente - e não pode tocar, senão desfaria a escolha de quem mexeu na
    // tela -, a virada vai por applyOnce: roda uma vez e nunca mais.
    await applyOnce(
        'cv.webhook.repasses_sai_do_modo_escuta',
        `UPDATE cv_webhook_endpoints
            SET processa = true,
                descricao = 'Repasses - alteração de situação. Entra na cadeia contrato → repasse → reserva → lead.'
          WHERE funcionalidade = 'repasses'`,
    );

    console.log(`✅ [SchemaPatch] Webhook do CV garantido (${applied} OK, ${failed} skip).`);
}

export { FUNCIONALIDADES, novoToken };
export default ensureCvWebhookSchema;
