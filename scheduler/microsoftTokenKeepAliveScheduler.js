// scheduler/microsoftTokenKeepAliveScheduler.js
//
// Mantém a sessão Microsoft de todo mundo viva, para ninguém precisar relogar.
//
// POR QUE ISTO EXISTE
//
// O refresh_token do Azure não é eterno: ele vale por uma janela deslizante de
// 90 dias e SE RENOVA a cada uso (cada renovação devolve um refresh_token novo,
// que o Office grava por cima). Ou seja: token usado é token que não expira.
//
// O problema é quem não usa. Quem passa dois meses sem abrir uma tela da
// Microsoft chega no terceiro com a sessão morta - e a culpa parece do Office,
// que "desconectou sozinho". Com esta varredura diária, o relógio dos 90 dias
// nunca chega perto do fim: na prática, entrar uma vez basta.
//
// A OUTRA METADE do "nunca mais relogar" está em MicrosoftAuthService: até
// 24/08/2026 qualquer falha de renovação apagava o token e forçava login novo -
// bastava uma piscada de rede. Agora ele tenta de novo e só desiste quando a
// Microsoft diz que a autorização morreu. As duas coisas juntas é que fazem a
// promessa valer.
//
// Custo: uma chamada por pessoa por dia, e só para quem tem sessão. Barato o
// bastante para não precisar de recorte.

import cron from 'node-cron';
import { Op } from 'sequelize';
import db from '../models/sequelize/index.js';
import microsoftAuthService from '../services/microsoft/MicrosoftAuthService.js';

// 04:40 todo dia. Fora do horário de trabalho e fora dos minutos redondos, que
// é onde todo cron do mundo se acumula.
const CRON = '40 4 * * *';

let rodando = false;

async function rodar() {
    if (rodando) return;
    rodando = true;

    try {
        const usuarios = await db.User.findAll({
            where: {
                microsoft_id: { [Op.ne]: null },
                microsoft_refresh_token: { [Op.ne]: null },
            },
            attributes: ['id', 'username', 'microsoft_id', 'microsoft_access_token',
                'microsoft_refresh_token', 'microsoft_token_expires_at'],
        });

        if (!usuarios.length) return;

        let vivas = 0;
        let mortas = 0;
        let instaveis = 0;

        for (const u of usuarios) {
            try {
                // getValidToken renova quando está perto de vencer e GRAVA o
                // refresh_token novo. É ele que empurra a janela de 90 dias.
                const token = await microsoftAuthService.getValidToken(u);
                if (token) vivas++;
                else {
                    // null = a autorização morreu de verdade (senha trocada,
                    // consentimento revogado). Os tokens já foram zerados e a
                    // pessoa vai ver o aviso de reconectar ao abrir o Office.
                    mortas++;
                    console.warn(`⚠️  [MicrosoftKeepAlive] sessão de ${u.username || u.id} expirou - precisa reconectar.`);
                }
            } catch (err) {
                // Passageiro: o vínculo continua de pé e amanhã tenta de novo.
                if (err?.microsoftTemporario) instaveis++;
                else console.warn(`⚠️  [MicrosoftKeepAlive] user ${u.id}:`, err.message);
            }
        }

        console.log(`🔑 [MicrosoftKeepAlive] ${usuarios.length} sessão(ões): ${vivas} renovada(s), `
            + `${mortas} precisam reconectar, ${instaveis} instável(is).`);
    } catch (err) {
        console.error('❌ [MicrosoftKeepAlive] varredura falhou:', err.message);
    } finally {
        rodando = false;
    }
}

export default {
    start() {
        cron.schedule(CRON, rodar, { timezone: 'America/Sao_Paulo' });
        console.log(`🔑 [MicrosoftKeepAlive] renovação diária das sessões agendada (${CRON}).`);
    },
    rodar,
};
