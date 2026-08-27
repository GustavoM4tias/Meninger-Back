// models/sequelize/sienge/envioSiengeWatch.js
//
// Vigia do envio da venda ao ERP. Duas tabelas:
//   - envio_sienge_watch_settings: a regra (singleton, editável por tela)
//   - envio_sienge_watch_items:    o que está sendo acompanhado, com relógio próprio
//
// Por que relógio próprio: o CV não diz desde quando a reserva espera. O
// `erp_sienge.data_cad` é a data em que ELE preparou o registro, não a data em
// que a venda entrou na etapa - reserva que passou meses fora de "Envio Sienge"
// aparecia com 110 dias de espera sendo que estava na fila havia um dia. O vigia
// carimba `pendente_desde` na primeira vez que VÊ a reserva pendente e mede a
// partir dali.

export function defineEnvioSiengeWatchSettings(sequelize, DataTypes) {
    return sequelize.define('EnvioSiengeWatchSettings', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        active: {
            type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false,
            comment: 'Liga a varredura diária do vigia.',
        },

        // Qual etapa do CV significa "esperando o ERP". Id do tenant, não constante.
        idsituacao_vigiada: {
            type: DataTypes.INTEGER, allowNull: true, defaultValue: 17,
            comment: 'Situação CV que representa a espera pelo envio ao ERP (17 = Envio Sienge).',
        },

        // Os limiares nascem da distribuição REAL medida em 27/08/2026 sobre 1274
        // envios de 2026: p50 20h, p75 116h (~5 dias), p90 605h (~25 dias).
        // Por isso "não enviado" não é alarme: alarme é esperar MAIS do que a fila
        // costuma levar.
        dias_atraso: {
            type: DataTypes.INTEGER, allowNull: true, defaultValue: 5,
            comment: 'Dias de espera a partir dos quais a venda entra como ATRASADA (default 5 = p75 medido).',
        },
        dias_critico: {
            type: DataTypes.INTEGER, allowNull: true, defaultValue: 15,
            comment: 'Dias de espera a partir dos quais a venda entra como CRÍTICA.',
        },

        // Ato pago sem contrato no ERP é crítico independente do tempo: o dinheiro
        // entrou e o ERP não sabe. Foram 28 casos assim no passivo de agosto/2026.
        ato_pago_e_critico: {
            type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true,
            comment: 'Ato pago sem contrato no ERP entra como crítico mesmo dentro do prazo.',
        },

        // A confirmação no Sienge é a fonte definitiva (o flag do CV bateu 89/89 na
        // medição, mas é o ERP que manda). Fica só para os críticos porque é 1
        // chamada por reserva.
        confirmar_no_sienge: {
            type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true,
            comment: 'Confirma na API do Sienge (por externalId) antes de alarmar um caso crítico.',
        },

        notify_user_ids: {
            type: DataTypes.JSONB, allowNull: false, defaultValue: [],
            comment: 'Quem recebe o aviso. Vazio = ninguém é avisado (só fica no histórico).',
        },
        cron_expression: {
            type: DataTypes.STRING, allowNull: true, defaultValue: '30 9 * * *',
            comment: 'Quando a varredura roda (cron, fuso de Brasília).',
        },

        last_run_at: { type: DataTypes.DATE, allowNull: true },
        last_run_resumo: { type: DataTypes.JSONB, allowNull: true },
        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'envio_sienge_watch_settings',
        underscored: true,
        timestamps: true,
    });
}

export function defineEnvioSiengeWatchItem(sequelize, DataTypes) {
    return sequelize.define('EnvioSiengeWatchItem', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        idreserva: { type: DataTypes.INTEGER, allowNull: false, unique: true },

        empreendimento: { type: DataTypes.STRING, allowNull: true },
        unidade: { type: DataTypes.STRING, allowNull: true },
        titular_nome: { type: DataTypes.STRING, allowNull: true },

        // Relógio do vigia - ver o cabeçalho.
        pendente_desde: { type: DataTypes.DATE, allowNull: false },
        // Quando o CV preparou o registro do ERP. NÃO serve de relógio (reserva
        // que passou meses fora da etapa aparece com 110 dias de espera tendo
        // entrado na fila ontem), mas é o contexto que a pessoa precisa para
        // saber se o caso é antigo. Fica ao lado, não no lugar.
        data_cad_erp: { type: DataTypes.DATE, allowNull: true },
        ultima_verificacao: { type: DataTypes.DATE, allowNull: true },

        severidade: {
            type: DataTypes.STRING(20), allowNull: false, defaultValue: 'na_fila',
            comment: 'na_fila | atrasada | critica',
        },
        ato_pago: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        confirmado_sem_contrato: {
            type: DataTypes.BOOLEAN, allowNull: true,
            comment: 'true = a API do Sienge confirmou que não existe contrato; null = não conferido.',
        },

        resolvido_em: { type: DataTypes.DATE, allowNull: true },
        espera_horas: {
            type: DataTypes.INTEGER, allowNull: true,
            comment: 'Horas entre pendente_desde e a resolução. Alimenta a calibragem dos limiares.',
        },
        contrato_erp: { type: DataTypes.STRING, allowNull: true },

        avisado_em: { type: DataTypes.DATE, allowNull: true },
        avisado_severidade: { type: DataTypes.STRING(20), allowNull: true },
    }, {
        tableName: 'envio_sienge_watch_items',
        underscored: true,
        timestamps: true,
        indexes: [
            { fields: ['idreserva'], unique: true },
            { fields: ['resolvido_em'] },
            { fields: ['severidade'] },
        ],
    });
}

export default { defineEnvioSiengeWatchSettings, defineEnvioSiengeWatchItem };
