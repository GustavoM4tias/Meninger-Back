// services/realestate/realEstateNotifyService.js
//
// E-mails ao gerente da imobiliária sobre o cadastro:
// - access: cadastro concluído no CV -> login + senha (se o CV retornar) ou
//   instrução de definir a senha via "Esqueci minha senha" no painel.
// - pending: cadastro recebido mas ainda não concluído -> "aguarde, você
//   receberá o acesso assim que disponível" (enviado uma única vez; quando um
//   reprocessamento concluir, o e-mail de acesso sai automaticamente).

import { sendEmail } from '../../email/email.service.js';

const PAINEL_URL = process.env.CV_PAINEL_URL || 'https://menin.cvcrm.com.br';

// O POST de usuário-imobiliária documenta só { data: { id }, status }, mas se
// alguma versão do CV devolver a senha gerada, aproveitamos.
function findPasswordDeep(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 4) return '';
    for (const [key, value] of Object.entries(obj)) {
        if (/senha|password/i.test(key) && typeof value === 'string' && value.trim()) {
            return value.trim();
        }
        if (value && typeof value === 'object') {
            const found = findPasswordDeep(value, depth + 1);
            if (found) return found;
        }
    }
    return '';
}

function baseData(reg) {
    const ger = reg.form?.gerente || {};
    const imob = reg.form?.imobiliaria || {};
    return {
        to: String(ger.email || '').trim(),
        data: {
            gerentePrimeiroNome: String(ger.nome || '').trim().split(/\s+/)[0] || 'tudo bem',
            imobiliariaNome: imob.nome || imob.razao_social || 'sua imobiliária',
        },
    };
}

export async function sendAccessEmail(reg) {
    const { to, data } = baseData(reg);
    if (!to) return false;

    await sendEmail('realestate.access', to, {
        ...data,
        login: to,
        senha: findPasswordDeep(reg.result?.steps?.usuario?.response),
        painelUrl: PAINEL_URL,
        empreendimentos: (reg.enterprises || []).map(e => e?.nome).filter(Boolean).join(', '),
    });
    return true;
}

export async function sendPendingEmail(reg) {
    const { to, data } = baseData(reg);
    if (!to) return false;

    await sendEmail('realestate.pending', to, data);
    return true;
}

export default { sendAccessEmail, sendPendingEmail };
