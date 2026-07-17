// services/realestate/realEstateRegistrationService.js
//
// Processa um cadastro de imobiliária contra o CV CRM (padrão apiCv):
//   1. POST /v1/cadastros/imobiliarias        (upsert por CNPJ/idimobiliaria_int)
//   2. resolve idimobiliaria_cv               (resposta ou lookup por CNPJ)
//   3. POST /v1/cadastros/usuarios-imobiliarias (gerente)
//   4. POST /v2/cadastros/empreendimentos/imobiliarias (uma por empreendimento)
// Cada etapa grava seu resultado em `result.steps`; falha parcial vira status
// 'error' com retry — o upsert do CV torna a repetição segura.

import apiCv from '../../lib/apiCv.js';
import { sendAccessEmail, sendPendingEmail } from './realEstateNotifyService.js';

export const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

// ── Validações de documento ──────────────────────────────────────────────────
export function isValidCnpj(value) {
    const c = onlyDigits(value);
    if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
    const calc = (len) => {
        let sum = 0, pos = len - 7;
        for (let i = 0; i < len; i++) {
            sum += Number(c[i]) * pos--;
            if (pos < 2) pos = 9;
        }
        const r = sum % 11;
        return r < 2 ? 0 : 11 - r;
    };
    return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
}

export function isValidCpf(value) {
    const c = onlyDigits(value);
    if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
    const calc = (len) => {
        let sum = 0;
        for (let i = 0; i < len; i++) sum += Number(c[i]) * (len + 1 - i);
        const r = (sum * 10) % 11;
        return r === 10 ? 0 : r;
    };
    return calc(9) === Number(c[9]) && calc(10) === Number(c[10]);
}

// ── Regras de negócio ────────────────────────────────────────────────────────

// Sigla: 1 palavra → 2 primeiras letras; 2+ palavras → inicial das 2 primeiras.
export function buildSigla(nome) {
    const words = String(nome || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    const sigla = words.length === 1
        ? words[0].slice(0, 2)
        : words[0][0] + words[1][0];
    return sigla.toUpperCase();
}

// Validade CRECI vazia → 31/12 do ano seguinte (ex.: em 2026 → 2027-12-31).
export function defaultValidadeCreci(now = new Date()) {
    return `${now.getFullYear() + 1}-12-31`;
}

// Aceita 'dd/mm/aaaa' ou 'aaaa-mm-dd' e devolve 'aaaa-mm-dd'.
export function normalizeDate(value) {
    const s = String(value || '').trim();
    if (!s) return '';
    const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (br) return `${br[3]}-${br[2]}-${br[1]}`;
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    return s;
}

// ── Validação do formulário ──────────────────────────────────────────────────

export function validateSubmission(form) {
    const errors = [];
    const imob = form?.imobiliaria || {};
    const ger = form?.gerente || {};

    if (!String(imob.nome || '').trim()) errors.push('Nome da imobiliária é obrigatório.');
    if (!String(imob.razao_social || '').trim()) errors.push('Razão social é obrigatória.');
    if (!String(imob.creci || '').trim()) errors.push('CRECI da imobiliária é obrigatório.');
    if (!isValidCnpj(imob.cnpj)) errors.push('CNPJ da imobiliária é inválido.');
    if (imob.email && !/^\S+@\S+\.\S+$/.test(String(imob.email).trim())) errors.push('E-mail da imobiliária é inválido.');

    if (!String(ger.nome || '').trim()) errors.push('Nome do gerente é obrigatório.');
    if (!isValidCpf(ger.documento)) errors.push('CPF do gerente é inválido.');
    if (!/^\S+@\S+\.\S+$/.test(String(ger.email || '').trim())) errors.push('E-mail do gerente é inválido.');
    if (!normalizeDate(ger.data_nasc)) errors.push('Data de nascimento do gerente é obrigatória.');
    if (onlyDigits(ger.celular).length < 10) errors.push('Celular do gerente é inválido.');

    return errors;
}

// ── Payloads CV ──────────────────────────────────────────────────────────────

function buildImobiliariaPayload(reg) {
    const imob = reg.form?.imobiliaria || {};
    const nome = String(imob.nome || '').trim();

    return {
        nome,
        sigla: String(imob.sigla || '').trim().toUpperCase() || buildSigla(nome),
        razao_social: String(imob.razao_social || '').trim(),
        escala_plantao: imob.escala_plantao === 'N' ? 'N' : 'S',
        micro_empresa: imob.micro_empresa === 'S' ? 'S' : 'N',
        creci: String(imob.creci || '').trim(),
        validade_creci: normalizeDate(imob.validade_creci) || defaultValidadeCreci(),
        alterar_login_corretor: 'S',
        ativo_painel: 'S',
        cnpj: onlyDigits(imob.cnpj),
        // Upsert idempotente no CV: retry do mesmo registro atualiza em vez de duplicar.
        idimobiliaria_int: `OFFICE-${reg.id}`,
        email: String(imob.email || '').trim().toLowerCase() || undefined,
        logradouro: String(imob.logradouro || '').trim() || undefined,
        endereco: [imob.endereco || imob.logradouro, imob.numero, imob.complemento, imob.bairro]
            .map(v => String(v || '').trim()).filter(Boolean).join(', ') || undefined,
        cidade: String(imob.cidade || '').trim() || undefined,
        estado: String(imob.estado || '').trim().toUpperCase() || undefined,
    };
}

function buildUsuarioPayload(reg, idimobiliariaCv) {
    const ger = reg.form?.gerente || {};
    const celular = onlyDigits(ger.celular);

    const payload = {
        idimobiliaria_cv: Number(idimobiliariaCv),
        idimobiliaria_int: `OFFICE-${reg.id}`,
        nome: String(ger.nome || '').trim(),
        documento: onlyDigits(ger.documento),
        email: String(ger.email || '').trim().toLowerCase(),
        data_nasc: normalizeDate(ger.data_nasc),
        telefone: onlyDigits(ger.telefone) || celular,
        celular,
    };

    const opt = {
        creci: String(ger.creci || '').trim(),
        cep: onlyDigits(ger.cep),
        logradouro: String(ger.logradouro || '').trim(),
        endereco: String(ger.endereco || ger.logradouro || '').trim(),
        bairro: String(ger.bairro || '').trim(),
        numero: String(ger.numero || '').trim(),
        complemento: String(ger.complemento || '').trim(),
        estado: String(ger.estado || '').trim().toUpperCase(),
        cidade: String(ger.cidade || '').trim(),
    };
    for (const [k, v] of Object.entries(opt)) if (v) payload[k] = v;

    return payload;
}

// Vasculha a resposta do CV por um id numérico de imobiliária.
function extractImobiliariaId(data) {
    if (data == null) return null;
    if (typeof data === 'number') return data;
    if (typeof data === 'string') return /^\d+$/.test(data.trim()) ? Number(data.trim()) : null;
    for (const key of ['idimobiliaria_cv', 'idimobiliaria', 'id', 'codigo', 'data', 'imobiliaria']) {
        if (key in data) {
            const found = extractImobiliariaId(data[key]);
            if (found != null) return found;
        }
    }
    return null;
}

// Fallback: localizar a imobiliária no CV pelo CNPJ.
async function lookupImobiliariaByCnpj(cnpj) {
    const doc = onlyDigits(cnpj);
    const attempts = [{ cnpj: doc }, { documento: doc }];
    for (const params of attempts) {
        try {
            const resp = await apiCv.get('/v1/cadastros/imobiliarias', { params: { ...params, limit: 5, offset: 0 } });
            const data = resp?.data;
            const list = Array.isArray(data) ? data
                : Array.isArray(data?.imobiliarias) ? data.imobiliarias
                : Array.isArray(data?.dados) ? data.dados
                : data?.imobiliaria ? [data.imobiliaria]
                : [];
            const hit = list.find(i => onlyDigits(i?.cnpj || i?.documento) === doc) || list[0];
            const id = extractImobiliariaId(hit);
            if (id != null) return id;
        } catch {
            // tenta o próximo formato de filtro
        }
    }
    return null;
}

const cvErrorMessage = (err, fallback) => {
    const d = err?.response?.data;
    const msg = d?.mensagem || d?.message || d?.error
        || (typeof d === 'string' ? d : null)
        || err?.message;
    return `${fallback}: ${msg || 'erro desconhecido'}`;
};

// ── Pipeline principal ───────────────────────────────────────────────────────

export async function processRegistration(registration) {
    const reg = registration;
    const steps = { ...(reg.result?.steps || {}) };
    const result = { ...(reg.result || {}) };

    await reg.update({ status: 'processing', error: null });

    try {
        // 1. Imobiliária (upsert por CNPJ / idimobiliaria_int)
        if (!steps.imobiliaria?.ok) {
            try {
                const resp = await apiCv.post('/v1/cadastros/imobiliarias', buildImobiliariaPayload(reg));
                steps.imobiliaria = { ok: true, response: resp?.data ?? null };
            } catch (err) {
                steps.imobiliaria = { ok: false, response: err?.response?.data ?? null };
                throw new Error(cvErrorMessage(err, 'Falha ao cadastrar a imobiliária no CV'));
            }
        }

        // 2. Resolver o id da imobiliária no CV
        let idimobiliaria = result.idimobiliaria_cv
            || extractImobiliariaId(steps.imobiliaria.response);
        if (!idimobiliaria) {
            idimobiliaria = await lookupImobiliariaByCnpj(reg.form?.imobiliaria?.cnpj);
        }
        if (!idimobiliaria) {
            throw new Error('Imobiliária criada, mas não foi possível obter o ID dela no CV. Tente reprocessar.');
        }
        result.idimobiliaria_cv = Number(idimobiliaria);

        // 3. Usuário gerente
        if (!steps.usuario?.ok) {
            try {
                const resp = await apiCv.post('/v1/cadastros/usuarios-imobiliarias', buildUsuarioPayload(reg, idimobiliaria));
                steps.usuario = { ok: true, response: resp?.data ?? null };
            } catch (err) {
                steps.usuario = { ok: false, response: err?.response?.data ?? null };
                throw new Error(cvErrorMessage(err, 'Falha ao cadastrar o gerente no CV'));
            }
        }

        // 4. Associações a empreendimentos
        const enterprises = Array.isArray(reg.enterprises) ? reg.enterprises : [];
        const assoc = { ...(steps.associacoes || {}) };
        const failed = [];
        for (const ent of enterprises) {
            const entId = Number(ent?.id);
            if (!Number.isFinite(entId)) continue;
            if (assoc[entId]?.ok) continue;
            try {
                const resp = await apiCv.post('/v2/cadastros/empreendimentos/imobiliarias', {
                    idempreendimento: entId,
                    idimobiliaria: Number(idimobiliaria),
                });
                assoc[entId] = { ok: true, nome: ent?.nome, response: resp?.data ?? null };
            } catch (err) {
                assoc[entId] = { ok: false, nome: ent?.nome, response: err?.response?.data ?? null };
                failed.push(ent?.nome || entId);
            }
        }
        steps.associacoes = assoc;
        if (failed.length) {
            throw new Error(`Imobiliária e gerente cadastrados, mas falhou a associação com: ${failed.join(', ')}. Reprocesse para tentar novamente.`);
        }

        await reg.update({
            status: 'completed',
            error: null,
            result: { ...result, steps },
            completed_at: new Date(),
        });

        // E-mail de acesso ao gerente (uma única vez, mesmo em retry). Falha de
        // e-mail não derruba o cadastro - fica registrada para diagnóstico.
        const emails = { ...(result.emails || {}) };
        if (!emails.access_sent_at) {
            try {
                if (await sendAccessEmail(reg)) emails.access_sent_at = new Date().toISOString();
            } catch (mailErr) {
                console.error('[realestate] falha no e-mail de acesso:', mailErr?.message);
                emails.access_error = mailErr?.message || String(mailErr);
            }
            await reg.update({ result: { ...result, steps, emails } });
        }
        return reg;
    } catch (err) {
        // "Aguarde": avisa o gerente uma única vez que o acesso sai depois.
        const emails = { ...(result.emails || {}) };
        if (!emails.pending_sent_at && !emails.access_sent_at) {
            try {
                if (await sendPendingEmail(reg)) emails.pending_sent_at = new Date().toISOString();
            } catch (mailErr) {
                console.error('[realestate] falha no e-mail de aguarde:', mailErr?.message);
            }
        }
        await reg.update({
            status: 'error',
            error: err?.message || String(err),
            result: { ...result, steps, emails },
        });
        throw err;
    }
}

export default {
    processRegistration,
    validateSubmission,
    buildSigla,
    defaultValidadeCreci,
    normalizeDate,
    isValidCnpj,
    isValidCpf,
    onlyDigits,
};
