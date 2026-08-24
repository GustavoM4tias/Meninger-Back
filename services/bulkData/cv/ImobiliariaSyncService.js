// services/bulkData/cv/ImobiliariaSyncService.js
//
// Backup das imobiliárias do CV em cv_imobiliarias. A listagem
// GET /v1/cadastros/imobiliarias devolve TODAS de uma vez, já com cidade e
// estado resolvidos — uma chamada sincroniza tudo (medido em 2026-08-24: 555
// registros, sem bloco `paginacao` na resposta). `syncOne` atualiza um
// registro específico (usado logo após um cadastro feito pelo Office).
//
// A listagem só devolve imobiliárias ATIVAS. Quem sai dela foi desativada ou
// excluída no CV, e antes ficava no espelho como ativa para sempre — fantasma
// na tela, com contato que não vale mais. Agora o sync marca os ausentes como
// inativos, então a tela mostra "Inativa" em vez de mentir.

import { Op } from 'sequelize';
import apiCv from '../../../lib/apiCv.js';
import { getV3, isConfigured as v3Configurado } from '../../../lib/apiCvV3.js';
import db from '../../../models/sequelize/index.js';

// O CV devolve texto com entidade HTML crua ("CHAVE &amp; CO. ASSOCIADOS").
// Sem decodificar, a entidade aparece literal na tela e ainda estraga a busca.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(value) {
    if (typeof value !== 'string' || !value.includes('&')) return value;
    return value
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

const txt = (value) => decodeEntities(value) || null;

function toRow(item) {
    return {
        idimobiliaria: Number(item.idimobiliaria),
        nome: txt(item.nome),
        razao_social: txt(item.razao_social),
        cnpj: String(item.cnpj || '').replace(/\D/g, '') || null,
        sigla: txt(item.sigla),
        creci: txt(item.creci),
        validade_creci: item.validade_creci || null,
        ativo: item.ativo || null,
        ativo_painel: item.ativo_painel || null,
        micro_empresa: item.micro_empresa || null,
        email: txt(item.email),
        telefone: txt(item.telefone),
        celular: txt(item.celular),
        cidade: txt(item.cidade),
        estado: txt(item.estado),
        gerente_nome: txt(item.gerente_nome),
        gerente_email: txt(item.gerente_email),
        gerente_celular: txt(item.gerente_celular),
        data_cad: item.data_cad || null,
        data_modificacao: item.data_modificacao || null,
        raw: item,
        synced_at: new Date(),
    };
}

export default class ImobiliariaSyncService {
    async syncAll() {
        const resp = await apiCv.get('/v1/cadastros/imobiliarias');
        const list = Array.isArray(resp?.data?.imobiliarias) ? resp.data.imobiliarias : [];

        const vistos = [];
        for (const item of list) {
            const id = Number(item?.idimobiliaria);
            if (!Number.isFinite(id)) continue;
            await db.CvImobiliaria.upsert(toRow(item));
            vistos.push(id);
        }

        // Poda: quem não veio na listagem não está mais ativo no CV. Só roda
        // quando a resposta trouxe conteúdo — resposta vazia é falha do CV, e
        // desativar a base inteira por causa dela seria bem pior.
        if (vistos.length) {
            const [desativadas] = await db.CvImobiliaria.update(
                { ativo: 'N', synced_at: new Date() },
                { where: { idimobiliaria: { [Op.notIn]: vistos }, ativo: { [Op.ne]: 'N' } } }
            );
            if (desativadas) console.log(`[Imobiliárias] ${desativadas} marcada(s) como inativa(s) (sumiram do CV)`);
        }

        return vistos.length;
    }

    /**
     * Associação REAL imobiliária x empreendimento, lida do CV.
     *
     * A v1/v2 só tem POST para esse vínculo (GET devolve 405), então o Office
     * deduzia tudo da atividade — e imobiliária associada que ainda não vendeu
     * ficava "sem empreendimento" na tela. A v3 tem o GET por empreendimento;
     * como são poucas dezenas de empreendimentos, uma varredura completa é
     * barata e devolve o mapa inteiro.
     *
     * 404 = empreendimento sem nenhuma imobiliária associada, não é erro.
     * A poda é POR EMPREENDIMENTO e só com resposta bem-sucedida: um
     * empreendimento que falhou mantém o que já estava gravado.
     */
    async syncAssociacoes() {
        if (!v3Configurado()) {
            console.warn('[Imobiliárias] associações não sincronizadas: CV_PANEL_EMAIL/CV_PANEL_SENHA ausentes.');
            return { ok: false, motivo: 'sem_credencial', pares: 0 };
        }

        const empreendimentos = await db.sequelize.query(
            'SELECT idempreendimento FROM cv_enterprises ORDER BY idempreendimento',
            { type: db.Sequelize.QueryTypes.SELECT }
        );

        const agora = new Date();
        let pares = 0;
        const falhas = [];

        for (const { idempreendimento } of empreendimentos) {
            const idEmp = Number(idempreendimento);
            if (!Number.isFinite(idEmp)) continue;

            let lista;
            try {
                const resp = await getV3(`/v3/cadastros/empreendimentos/${idEmp}/imobiliarias`);
                lista = Array.isArray(resp?.data?.data) ? resp.data.data : [];
            } catch (err) {
                if (err.response?.status === 404) lista = [];   // nenhuma associada
                else { falhas.push(idEmp); continue; }
            }

            const vistos = [];
            for (const item of lista) {
                const idImob = Number(item?.idimobiliaria);
                if (!Number.isFinite(idImob)) continue;
                await db.CvImobiliariaEmpreendimento.upsert({
                    idempreendimento: idEmp,
                    idimobiliaria: idImob,
                    nome: item?.nome || null,
                    razao_social: item?.razao_social || null,
                    synced_at: agora,
                });
                vistos.push(idImob);
                pares++;
            }

            // Desassociado no CV some da resposta: tem que sumir daqui também.
            await db.CvImobiliariaEmpreendimento.destroy({
                where: {
                    idempreendimento: idEmp,
                    ...(vistos.length ? { idimobiliaria: { [Op.notIn]: vistos } } : {}),
                },
            });
        }

        if (falhas.length) console.warn(`[Imobiliárias] associações: ${falhas.length} empreendimento(s) falharam (${falhas.slice(0, 5).join(', ')})`);
        return { ok: true, pares, empreendimentos: empreendimentos.length, falhas: falhas.length };
    }

    async syncOne(idimobiliaria) {
        const id = Number(idimobiliaria);
        if (!Number.isFinite(id)) return null;
        const resp = await apiCv.get(`/v1/cadastros/imobiliarias/${id}`);
        const item = resp?.data?.imobiliarias;
        if (!item?.idimobiliaria) return null;
        await db.CvImobiliaria.upsert(toRow(item));
        return item;
    }
}
