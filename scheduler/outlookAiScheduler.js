// scheduler/outlookAiScheduler.js
//
// A IA da caixa trabalhando com o Office FECHADO.
//
// Sem isto, a triagem só acontece quando alguém abre a tela - e aí a pessoa
// espera o modelo classificar 40 e-mails enquanto olha para um esqueleto. Com
// isto, a aba abre pronta: o trabalho já foi feito, e o que a tela faz é só ler
// o cache.
//
// TRÊS FREIOS, e eles são o motivo de este arquivo existir do jeito que existe:
//
// 1. SÓ QUEM JÁ USOU. A varredura pega apenas quem TEM linha em
//    outlook_ai_settings, ou seja, quem abriu a tela pelo menos uma vez. Ninguém
//    passa a ter a caixa lida por um modelo porque um cron foi ligado.
//
// 2. CLASSIFICAR SEMPRE, AGIR SÓ SE MANDAREM. `triage()` roda para todo mundo da
//    lista (é leitura, fica no banco do Office e não sai daqui). `runAutomation()`
//    depende de `outlook_ai_auto_enabled`, que nasce FALSE no banco: enquanto
//    ninguém ligar, nenhum e-mail sai e nenhuma mensagem muda de pasta.
//
// 3. HORÁRIO COMERCIAL. Fora da janela não adianta classificar de madrugada o
//    que ninguém vai ler antes das 8h - e cada passada custa token.

import cron from 'node-cron';
import { Op } from 'sequelize';
import db from '../models/sequelize/index.js';
import ai from '../services/microsoft/MicrosoftOutlookAiService.js';
import settingsService from '../services/microsoft/MicrosoftSettingsService.js';

// A cada 15 minutos, das 6h às 21h, de segunda a sexta. E-mail que chega no
// sábado é classificado na segunda de manhã, antes de a pessoa abrir.
const CRON = '*/15 6-21 * * 1-5';

// Teto por passada: uma caixa muito movimentada não pode consumir a rodada
// inteira e deixar as outras pessoas sem triagem.
const MAX_POR_PESSOA = 25;

let rodando = false;

async function rodar() {
    // Passada anterior ainda de pé (Graph lento, lote grande): pular é melhor do
    // que empilhar duas varreduras classificando as mesmas mensagens.
    if (rodando) {
        console.log('⏭️  [OutlookAI] passada anterior ainda rodando, pulando esta.');
        return;
    }
    rodando = true;

    try {
        const global = await settingsService.get();
        if (global.outlook_enabled === false || global.outlook_ai_enabled === false) return;

        // Quem já abriu a tela E deixou a IA ligada. O JOIN com users garante
        // que ainda existe conta Microsoft vinculada - sem microsoft_id não há
        // caixa para ler.
        const linhas = await db.OutlookAiSettings.findAll({
            where: { ativo: true },
            include: [{
                model: db.User,
                as: 'user',
                required: true,
                attributes: ['id', 'microsoft_id', 'username'],
                where: { microsoft_id: { [Op.ne]: null } },
            }],
            limit: 200,
        });

        if (!linhas.length) return;

        let classificadas = 0;
        let aplicadas = 0;

        for (const linha of linhas) {
            const mailbox = linha.user?.microsoft_id;
            if (!mailbox) continue;

            try {
                const passada = await ai.triage(linha.user_id, mailbox, { limite: MAX_POR_PESSOA });
                classificadas += passada.classificadas || 0;

                // Só age se a empresa autorizou. O service confere de novo — este
                // if é para não gastar consulta à toa.
                if (global.outlook_ai_auto_enabled === true) {
                    const r = await ai.runAutomation(linha.user_id, mailbox, { max: MAX_POR_PESSOA });
                    aplicadas += r.aplicadas || 0;
                }
            } catch (err) {
                // Uma caixa com problema (token vencido, 403 de permissão) não
                // pode derrubar a varredura das outras.
                console.warn(`⚠️  [OutlookAI] caixa de ${linha.user?.username || linha.user_id} falhou:`, err.message);
            }
        }

        if (classificadas || aplicadas) {
            console.log(`🤖 [OutlookAI] ${linhas.length} caixa(s): ${classificadas} e-mail(s) classificado(s), ${aplicadas} ação(ões) aplicada(s).`);
        }
    } catch (err) {
        console.error('❌ [OutlookAI] varredura falhou:', err.message);
    } finally {
        rodando = false;
    }
}

export default {
    start() {
        cron.schedule(CRON, rodar, { timezone: 'America/Sao_Paulo' });
        console.log(`🤖 [OutlookAI] varredura da caixa agendada (${CRON}).`);
    },
    // Exposto para a tela poder forçar uma passada e para teste manual.
    rodar,
};
