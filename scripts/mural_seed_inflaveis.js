/**
 * SEED de TESTE do Mural de Avisos — comunicado "Ação obrigatória aos sábados".
 *
 * Cadastra o comunicado (idempotente, por título) como RASCUNHO, com público-alvo
 * de TESTE = um único usuário (por padrão o seu, resolvido por e-mail). Assim, ao
 * publicar pela tela de Gestão (/mural/admin), só esse usuário recebe a notificação.
 *
 * ⚠️ NÃO publica e NÃO envia notificação — apenas cria o rascunho para você revisar.
 *
 * Rodar:
 *   node scripts/mural_seed_inflaveis.js
 * Trocar o destinatário de teste:
 *   MURAL_SEED_EMAIL=fulano@menin.com.br node scripts/mural_seed_inflaveis.js
 */

import db from '../models/sequelize/index.js';

const TEST_EMAIL = process.env.MURAL_SEED_EMAIL || 'gustavo.diniz@menin.com.br';

const TITLE = 'Comunicado interno — Ação obrigatória aos sábados';
const BODY = `Prezados Gestores,

Reforçamos que é OBRIGATÓRIO, todos os sábados, ligar os infláveis na frente da loja/plantão de vendas.

Essa ação faz parte da nossa estratégia de atração de fluxo, visibilidade e fortalecimento da marca no ponto de venda. O sábado é um dos dias de maior movimento e precisamos garantir impacto visual e presença ativa.

Pedimos atenção especial para:

✔ Ligar os infláveis no início do expediente
✔ Garantir que estejam posicionados corretamente
✔ Verificar funcionamento durante todo o período de atendimento

Contamos com o comprometimento de todos para mantermos o padrão e a força da nossa operação.

Por gentileza, envie fotos para nossas postagens.`;

export async function seedComunicadoInflaveis() {
    // 1) Garante que as tabelas do Mural existem (caso o backend ainda não tenha
    //    rodado o sync no boot). sync() cria se não existir — não altera nem dropa.
    await db.Comunicado.sync();
    await db.ComunicadoAssignment.sync();
    await db.ComunicadoReceipt.sync();

    // 2) Resolve o destinatário de TESTE (por e-mail).
    const user = await db.User.findOne({
        where: { email: TEST_EMAIL },
        attributes: ['id', 'username', 'email'],
    });
    if (!user) {
        throw new Error(`Usuário de teste não encontrado para o e-mail "${TEST_EMAIL}". `
            + 'Defina MURAL_SEED_EMAIL com um e-mail válido do sistema.');
    }

    // 3) Cria/atualiza o comunicado (idempotente por título) como RASCUNHO.
    const fields = {
        body: BODY,
        kind: 'OBRIGATORIO',
        requiresAck: true,
        pinned: true,
        priority: 1,
        status: 'DRAFT',
        channels: { inapp: true, email: true, whatsapp: false },
        startsAt: null,
        endsAt: null,
        link: null,
        createdByUserId: user.id,
        updatedByUserId: user.id,
    };
    let row = await db.Comunicado.findOne({ where: { title: TITLE } });
    if (row) {
        await row.update(fields);
    } else {
        row = await db.Comunicado.create({ title: TITLE, ...fields });
    }

    // 4) Público-alvo de TESTE: somente o usuário resolvido (escopo USER).
    await db.ComunicadoAssignment.destroy({ where: { comunicadoId: row.id } });
    await db.ComunicadoAssignment.create({
        comunicadoId: row.id,
        scopeType: 'USER',
        scopeValue: String(user.id),
    });

    return { id: row.id, status: row.status, testUser: `${user.username} <${user.email}>` };
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('mural_seed_inflaveis.js');
if (isDirectRun) {
    seedComunicadoInflaveis()
        .then((r) => {
            console.log(`✅ Comunicado cadastrado como RASCUNHO (id=${r.id}, status=${r.status}).`);
            console.log(`   Público-alvo de teste: ${r.testUser}`);
            console.log('   Próximo passo: abra /mural/admin, revise e clique em "Publicar"');
            console.log('   para disparar a notificação (só ao usuário de teste).');
            process.exit(0);
        })
        .catch((err) => {
            console.error('❌ Erro no seed:', err.message);
            process.exit(1);
        });
}
