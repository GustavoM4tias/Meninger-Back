// lib/schemaPatchMarks.js
//
// Marcadores de patch de DADOS que só pode rodar UMA vez.
//
// Os `lib/ensure*.js` rodam a cada boot e por isso são escritos de forma
// idempotente: `ADD COLUMN IF NOT EXISTS`, `UPDATE ... WHERE campo IS NULL`.
// Isso funciona enquanto o patch só PREENCHE o que está vazio.
//
// O problema aparece quando um patch precisa TROCAR um valor que já existe —
// tipicamente subir uma configuração para um padrão novo. Escrito como
// `UPDATE ... WHERE valor = <padrão antigo>`, ele roda de novo em todo boot e
// desfaz a escolha de quem configurou o padrão antigo de propósito pela tela.
// O código passa a ganhar do painel, e é exatamente o que não pode acontecer:
// no Office, configuração é do usuário — regra travada em código é bug.
//
// `applyOnce` resolve isso: o patch roda uma vez, deixa a marca gravada e
// nunca mais encosta no dado. Dali em diante a tela é a única dona do valor.
//
// Uso:
//   await applyOnce('boleto.janela.padrao_06_23',
//       `UPDATE boleto_settings SET janela_inicio_hora = 6 WHERE ...`);
//
// A chave é livre, mas use `modulo.assunto.mudanca` e NUNCA reaproveite uma
// chave já usada — a marca é permanente, o patch novo não rodaria.
import db from '../models/sequelize/index.js';

const TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS schema_patch_marks (
        key VARCHAR(160) PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )`;

let tabelaGarantida = false;

async function garantirTabela() {
    if (tabelaGarantida) return;
    await db.sequelize.query(TABLE_DDL);
    tabelaGarantida = true;
}

/**
 * Executa `sql` só se a marca `key` ainda não existir; grava a marca depois.
 *
 * A marca é gravada DEPOIS do SQL: se o patch falhar, ele é tentado de novo no
 * próximo boot em vez de ficar marcado como aplicado. O SQL precisa aguentar
 * rodar duas vezes num cenário de falha parcial (o `WHERE` do patch em geral já
 * dá conta, porque a segunda passada não casa mais nada).
 *
 * Não lança: patch de dados é best-effort, igual ao resto dos ensure*.
 *
 * @param {string} key   identificador permanente do patch
 * @param {string} sql   comando a executar uma única vez
 * @returns {Promise<'applied'|'already'|'failed'>}
 */
export async function applyOnce(key, sql) {
    try {
        await garantirTabela();

        const [marca] = await db.sequelize.query(
            `SELECT 1 FROM schema_patch_marks WHERE key = :key`,
            { replacements: { key }, type: db.Sequelize.QueryTypes.SELECT },
        );
        if (marca) return 'already';

        await db.sequelize.query(sql);
        await db.sequelize.query(
            `INSERT INTO schema_patch_marks (key) VALUES (:key) ON CONFLICT (key) DO NOTHING`,
            { replacements: { key } },
        );
        console.log(`✅ [SchemaPatch][once] "${key}" aplicado (não roda de novo).`);
        return 'applied';
    } catch (err) {
        console.warn(`⚠️  [SchemaPatch][once] "${key}" falhou: ${err.message}`);
        return 'failed';
    }
}

export default { applyOnce };
