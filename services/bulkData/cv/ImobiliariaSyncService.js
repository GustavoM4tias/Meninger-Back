// services/bulkData/cv/ImobiliariaSyncService.js
//
// Backup das imobiliárias do CV em cv_imobiliarias. A listagem
// GET /v1/cadastros/imobiliarias devolve TODAS de uma vez, já com cidade e
// estado resolvidos — uma chamada sincroniza tudo. `syncOne` atualiza um
// registro específico (usado logo após um cadastro feito pelo Office).

import apiCv from '../../../lib/apiCv.js';
import db from '../../../models/sequelize/index.js';

function toRow(item) {
    return {
        idimobiliaria: Number(item.idimobiliaria),
        nome: item.nome || null,
        razao_social: item.razao_social || null,
        cnpj: String(item.cnpj || '').replace(/\D/g, '') || null,
        sigla: item.sigla || null,
        creci: item.creci || null,
        validade_creci: item.validade_creci || null,
        ativo: item.ativo || null,
        ativo_painel: item.ativo_painel || null,
        micro_empresa: item.micro_empresa || null,
        email: item.email || null,
        telefone: item.telefone || null,
        celular: item.celular || null,
        cidade: item.cidade || null,
        estado: item.estado || null,
        gerente_nome: item.gerente_nome || null,
        gerente_email: item.gerente_email || null,
        gerente_celular: item.gerente_celular || null,
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

        let count = 0;
        for (const item of list) {
            if (!Number.isFinite(Number(item?.idimobiliaria))) continue;
            await db.CvImobiliaria.upsert(toRow(item));
            count++;
        }
        return count;
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
