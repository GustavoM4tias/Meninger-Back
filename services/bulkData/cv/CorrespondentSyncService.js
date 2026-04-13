// services/bulkData/cv/CorrespondentSyncService.js
// Endpoint: /v2/cadastros/correspondentes-usuarios
// Retorna usuários correspondentes; armazenamos por idusuario
import apiCv from '../../../lib/apiCv.js';
import db from '../../../models/sequelize/index.js';
import crypto from 'crypto';

const { CvCorrespondent } = db;

function sha(o) {
    return crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
}

async function fetchAllUsers() {
    const all = [];
    let pagina = 1;

    while (true) {
        const res = await apiCv.get('/v2/cadastros/correspondentes-usuarios', {
            params: { pagina, registros_por_pagina: 500 }
        });
        const dados = res.data?.dados ?? [];
        all.push(...dados);

        const totalPaginas = res.data?.paginacao?.total_de_paginas ?? 1;
        if (pagina >= totalPaginas) break;
        pagina++;
    }

    return all;
}

export default class CorrespondentSyncService {
    async syncAll() {
        console.log('[Correspondents] Sync iniciado');
        const users = await fetchAllUsers();

        for (const u of users) {
            if (!u.idusuario) continue;
            const h = sha(u);
            const existing = await CvCorrespondent.findByPk(u.idusuario);

            const data = {
                idusuario: u.idusuario,
                idempresa: u.idempresa ?? null,
                nome: u.nome ?? null,
                email: u.email ?? null,
                telefone: u.telefone ?? null,
                celular: u.celular ?? null,
                gerente: u.gerente ?? false,
                ativo_login: u.ativo_login ?? false,
                documento: u.documento ? String(u.documento) : null,
                data_cad: u.data_cad ? new Date(u.data_cad) : null,
                raw: u,
                content_hash: h,
            };

            if (!existing) await CvCorrespondent.create(data);
            else if (existing.content_hash !== h) await existing.update(data);
        }

        console.log(`✅ [Correspondents] ${users.length} usuários correspondentes sincronizados`);
        return users.length;
    }
}
