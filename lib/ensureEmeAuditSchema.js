// lib/ensureEmeAuditSchema.js
//
// Conserta o tipo das colunas de sessão/mensagem do log de auditoria da Eme.
//
// Contexto: `eme_audit_logs` nasceu quando session_id/message_id eram INTEGER.
// O model passou a declará-los UUID, mas a tabela já existia e o boot só roda
// sync({ alter:false }) — a coluna ficou INTEGER. Desde então todo insert com
// um id UUID morre com:
//   [SecureRunner.audit] failed invalid input syntax for type integer: "eb03..."
//
// O audit falha em silêncio de propósito (não pode derrubar a chamada da tool),
// então o sintoma nunca apareceu para o usuário: simplesmente paramos de
// registrar auditoria das tools chamadas a partir do builder de relatórios.
//
// Correção sem perda: a coluna incompatível é RENOMEADA para <col>_legacy e uma
// nova UUID é criada no lugar. O histórico antigo continua consultável e os
// inserts novos voltam a funcionar. Idempotente: na segunda passada as colunas
// já são uuid e nada acontece.

import db from '../models/sequelize/index.js';

const UUID_COLUMNS = ['session_id', 'message_id'];

async function columnType(table, column) {
    const rows = await db.sequelize.query(
        `SELECT data_type
           FROM information_schema.columns
          WHERE table_name = :table AND column_name = :column`,
        { replacements: { table, column }, type: db.Sequelize.QueryTypes.SELECT }
    );
    return rows?.[0]?.data_type ?? null;
}

export async function ensureEmeAuditSchema() {
    let fixed = 0;

    try {
        const exists = await columnType('eme_audit_logs', 'tool_name');
        if (!exists) {
            // Tabela ainda não existe; o sync do boot cria com os tipos certos.
            console.log('✅ [SchemaPatch] Audit da Eme: tabela ainda não criada, nada a corrigir.');
            return;
        }

        for (const col of UUID_COLUMNS) {
            const type = await columnType('eme_audit_logs', col);
            if (!type) {
                await db.sequelize.query(
                    `ALTER TABLE eme_audit_logs ADD COLUMN IF NOT EXISTS ${col} UUID`
                );
                fixed++;
                continue;
            }
            if (type === 'uuid') continue;

            // Tipo incompatível: preserva o histórico e abre espaço para o novo.
            console.warn(`⚠️  [SchemaPatch] eme_audit_logs.${col} está como ${type}; movendo para ${col}_legacy e recriando como UUID.`);
            await db.sequelize.query(
                `ALTER TABLE eme_audit_logs RENAME COLUMN ${col} TO ${col}_legacy`
            );
            await db.sequelize.query(
                `ALTER TABLE eme_audit_logs ADD COLUMN ${col} UUID`
            );
            fixed++;
        }
    } catch (err) {
        console.warn(`⚠️  [SchemaPatch] Audit da Eme falhou: ${err.message}`);
        return;
    }

    console.log(`✅ [SchemaPatch] Audit da Eme garantido (${fixed} coluna(s) ajustada(s)).`);
}
