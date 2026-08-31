// src/services/bulkData/cv/RepasseSyncService.js
import db from '../../../models/sequelize/index.js';
import apiCv from '../../../lib/apiCv.js';
import { parseCvDate, formatCvDate } from '../../../lib/cvDate.js';
const { Repasse } = db;

const LIMIT = 5000; // máximo da API

// ---------- Helpers ----------
const toDate = (s) => (s ? new Date(s.replace(' ', 'T')) : null);
const toDec = (s) => (s === null || s === undefined || s === '' ? null : String(s));

function buildCurrentSnapshot(raw) {
    return {
        status_reserva: raw.status_reserva ?? null,
        status_repasse: raw.status_repasse ?? null,
        idsituacao_repasse: raw.idsituacao_repasse ?? null,
        // Forma canônica (hora de parede do CV). A string da API já vem assim,
        // mas passar pelo formatCvDate garante o mesmo texto que a reserva
        // grava a partir deste espelho. Ver lib/cvDate.js.
        data_status_repasse: formatCvDate(raw.data_status_repasse),
        captured_at: new Date().toISOString()
    };
}

function snapshotsEqual(a, b) {
    if (!a || !b) return false;
    return (
        (a.status_reserva ?? null) === (b.status_reserva ?? null) &&
        (a.status_repasse ?? null) === (b.status_repasse ?? null) &&
        String(a.idsituacao_repasse ?? '') === String(b.idsituacao_repasse ?? '') &&
        String(a.data_status_repasse ?? '') === String(b.data_status_repasse ?? '')
    );
}

function mapRawToCols(raw) {
    return {
        idrepasse: raw.ID,
        idreserva: raw.idreserva,
        documento: raw.documento ?? null,
        etapa: raw.etapa ?? null,
        empreendimento: raw.empreendimento ?? null,
        bloco: raw.bloco ?? null,
        unidade: raw.unidade ?? null,

        codigointerno_reserva: raw.codigointerno_reserva ?? null,
        codigointerno_repasse: raw.codigointerno_repasse ?? null,
        codigointerno_empreendimento: raw.codigointerno_empreendimento ?? null,
        codigointerno_etapa: raw.codigointerno_etapa ?? null,
        codigointerno_bloco: raw.codigointerno_bloco ?? null,
        codigointerno_unidade: raw.codigointerno_unidade ?? null,

        // espelho do "atual"
        status_reserva: raw.status_reserva ?? null,
        status_repasse: raw.status_repasse ?? null,
        idsituacao_repasse: raw.idsituacao_repasse ?? null,
        // parseCvDate e não toDate: este é o campo que a reserva lê deste
        // espelho para montar o snapshot. Com o toDate genérico, o instante
        // gravado dependia do fuso do processo (UTC no Railway, Brasília numa
        // máquina local), e as duas escritas alternavam de 3 em 3 horas. As
        // outras datas seguem no toDate - trocá-las mexeria em data_assinatura
        // e no corte mensal do Faturamento, o que pede auditoria própria.
        data_status_repasse: parseCvDate(raw.data_status_repasse),

        data_contrato_liberado: toDate(raw.data_contrato_liberado),
        sla_prazo_repasse: raw.sla_prazo_repasse ?? null,

        valor_financiado: toDec(raw.valor_financiado),
        valor_previsto: toDec(raw.valor_previsto),
        valor_divida: toDec(raw.valor_divida),
        valor_subsidio: toDec(raw.valor_subsidio),
        valor_fgts: toDec(raw.valor_fgts),
        valor_registro: toDec(raw.valor_registro),

        data_status_financiamento: toDate(raw.data_status_financiamento),
        registro_pago: raw.registro_pago ?? null,
        parcela_conclusao: toDec(raw.parcela_conclusao),
        parcela_baixada: raw.parcela_baixada ?? null,
        saldo_devedor: toDec(raw.saldo_devedor),

        contrato_interno: raw.contrato_interno ?? null,
        valor_contrato: toDec(raw.valor_contrato),
        numero_contrato: raw.numero_contrato ?? null,
        situacao_contrato: raw.situacao_contrato ?? null,
        contrato_quitado: raw.contrato_quitado ?? null,
        contrato_liquidado: raw.contrato_liquidado ?? null,
        data_contrato_contab: toDate(raw.data_contrato_contab),
        proxima_acao: raw.proxima_acao ?? null,
        liberar_assinatura: raw.liberar_assinatura ?? null,
        num_matricula: raw.num_matricula ?? null,
        data_assinatura: toDate(raw.data_assinatura),
        recebendo_financiamento: raw.recebendo_financiamento ?? null,
        itbi_pago: raw.itbi_pago ?? null,
        laudemio_pago: raw.laudemio_pago ?? null,
        data_unidade_liberada: toDate(raw.data_unidade_liberada),
        data_laudo_liberado: toDate(raw.data_laudo_liberado),
        data_recurso_liberado: toDate(raw.data_recurso_liberado),
        porcentagem_medicao_obra: toDec(raw.porcentagem_medicao_obra),
    };
}

// Só baixa tudo (1 ou mais páginas, conforme total/LIMIT)
async function fetchAll(basePath) {
    let offset = 0;
    const all = [];
    const glue = basePath.includes('?') ? '&' : '?';
    let pages = 0;

    while (true) {
        const url = `${basePath}${glue}limit=${LIMIT}&offset=${offset}`;
        const { data } = await apiCv.get(url);
        const repasses = data?.repasses ?? [];
        all.push(...repasses);
        pages++;

        if (repasses.length < LIMIT) break;
        offset += LIMIT;
    }

    console.log(`📥 Fetch concluído: ${all.length} repasses em ${pages} página(s) da API`);
    return all;
}

// ---------- Service ----------
export default class RepasseSyncService {
    async loadAll() {
        console.log('🚀 [Repasses] Carga inicial');
        const all = await fetchAll('/v1/financeiro/repasses?');
        const stats = await this.upsertBatch(all);
        console.log(`🎉 [Repasses] Bulk concluído: total=${stats.total} | criados=${stats.created} | atualizados=${stats.updated} | mantidos=${stats.unchanged}`);
        return stats;
    }

    async loadDelta() {
        console.log('🚀 [Repasses] Delta (full scan controlado)');
        const all = await fetchAll('/v1/financeiro/repasses?');
        const stats = await this.upsertBatch(all);
        console.log(`🎉 [Repasses] Delta concluído: total=${stats.total} | criados=${stats.created} | atualizados=${stats.updated} | mantidos=${stats.unchanged}`);
        return stats;
    }

    /**
     * Sincroniza pelo id que veio no webhook, sem saber de antemão SE aquele id
     * é um idrepasse ou um idreserva.
     *
     * O problema: o CV não documenta qual id manda no aviso de repasse, e o
     * endpoint só filtra por `?ID=<idrepasse>` - `?idreserva=` é ignorado em
     * silêncio (medido em 28/08/2026: `?idreserva=7076` devolveu o repasse
     * ID=1). Chutar erraria calado, que é o pior desfecho possível.
     *
     * A saída é conferir em vez de supor: busca por `?ID=` e só aceita se o
     * repasse devolvido tiver de fato aquele ID. Se não bater, o id era de
     * reserva - e aí os repasses daquela reserva saem do espelho local, que
     * já guarda a ligação idreserva -> idrepasse, e cada um é buscado pelo
     * seu próprio ID.
     *
     * Assim funciona nos dois formatos, e o retorno diz qual deles era - o que
     * transforma o histórico numa medição do comportamento real do CV.
     */
    async syncPorIdDoWebhook(id) {
        const alvo = Number(id);
        if (!Number.isFinite(alvo)) throw new Error('id inválido.');

        const buscarPorId = async (idrepasse) => {
            const { data } = await apiCv.get(`/v1/financeiro/repasses?ID=${idrepasse}&limit=1`);
            const lista = data?.repasses ?? [];
            // A conferência que impede o chute: sem ela, um filtro ignorado
            // devolveria o primeiro repasse da base e nós gravaríamos o
            // registro errado achando que deu certo.
            return lista.find(r => Number(r?.ID) === Number(idrepasse)) || null;
        };

        const comoRepasse = await buscarPorId(alvo);
        if (comoRepasse) {
            const r = await this.upsertOne(comoRepasse);
            return { total: 1, [r]: 1, interpretado_como: 'idrepasse' };
        }

        const doEspelho = await Repasse.findAll({
            attributes: ['idrepasse'],
            where: { idreserva: alvo },
            raw: true,
        });
        if (!doEspelho.length) {
            return { total: 0, nao_encontrado: true, interpretado_como: 'desconhecido' };
        }

        let created = 0, updated = 0, unchanged = 0, failed = 0;
        for (const { idrepasse } of doEspelho) {
            const raw = await buscarPorId(idrepasse);
            if (!raw) { failed++; continue; }
            const r = await this.upsertOne(raw);
            if (r === 'created') created++; else if (r === 'updated') updated++; else unchanged++;
        }
        return {
            total: doEspelho.length, created, updated, unchanged, failed,
            interpretado_como: 'idreserva',
        };
    }

    async upsertBatch(arr) {
        const CHUNK = 300; // gravação em lotes
        let created = 0, updated = 0, unchanged = 0;

        for (let i = 0; i < arr.length; i += CHUNK) {
            const slice = arr.slice(i, i + CHUNK);

            // processa o slice em paralelo “na boa”
            const results = await Promise.all(slice.map((raw) => this.upsertOne(raw)));

            // consolida contadores do slice
            for (const r of results) {
                if (r === 'created') created++;
                else if (r === 'updated') updated++;
                else unchanged++;
            }

            console.log(`   → upsert progresso: ${i + slice.length}/${arr.length} | criados=${created} | atualizados=${updated} | mantidos=${unchanged}`);
        }

        return { total: arr.length, created, updated, unchanged };
    }

    /**
     * Regras:
     * - Se não existir → cria (status[0] = atual)       → 'created'
     * - Se existir e STATUS mudou → atualiza + push      → 'updated'
     * - Se existir e STATUS igual → não faz UPDATE       → 'unchanged'
     *
     * Observação: não atualizamos last_seen_at quando 'unchanged', para economizar I/O.
     */
    async upsertOne(raw) {
        const now = new Date();
        const mapped = mapRawToCols(raw);
        const currentSnap = buildCurrentSnapshot(raw);

        const existing = await Repasse.findByPk(mapped.idrepasse);

        if (!existing) {
            await Repasse.create({
                ...mapped,
                status: [currentSnap],
                first_seen_at: now,
                last_seen_at: now
            });
            return 'created';
        }

        const prevSnap0 = (existing.status && existing.status[0]) || null;
        const statusChanged = !snapshotsEqual(prevSnap0, currentSnap);

        // if (!statusChanged) {
        //     // nada a fazer — mantém como está
        //     return 'unchanged';
        // }
        if (!statusChanged) {
            // ✅ Mesmo se status igual, ainda atualiza os campos espelho
            await existing.update({
                ...mapped,
                // se quiser economizar I/O, pode NÃO mexer no status aqui
                last_seen_at: now
            });
            return 'updated'; // ou 'meta_updated' se quiser separar contagem
        }
        
        // mudou o status → insere snapshot no início e atualiza colunas espelho
        const nextStatus = [currentSnap, ...(existing.status || [])];

        await existing.update({
            ...mapped,
            status: nextStatus,
            last_seen_at: now
        });

        return 'updated';
    }
}
