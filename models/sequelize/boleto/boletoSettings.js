// models/sequelize/boleto/boletoSettings.js
// Configurações globais do módulo Boleto Caixa — tabela singleton (sempre 1 linha, id=1)
export default (sequelize, DataTypes) => {
    const BoletoSettings = sequelize.define('BoletoSettings', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        // ── Credenciais Ecobrança ────────────────────────────────────────────
        eco_usuario: {
            type: DataTypes.STRING,
            allowNull: true,
            comment: 'CPF/usuário de acesso ao Ecobrança Caixa',
        },
        eco_senha: {
            type: DataTypes.STRING,
            allowNull: true,
            comment: 'Senha de acesso ao Ecobrança Caixa (6 dígitos)',
        },

        // ── Configuração de séries ─────────────────────────────────────────────
        // Armazena JSON array de IDs: [21] ou [21, 22, 35]
        idserie_ra: {
            type: DataTypes.TEXT,
            defaultValue: '[21]',
            comment: 'IDs das séries de entrada aceitas (JSON array). Ex: [21] ou [21,22]',
            get() {
                const raw = this.getDataValue('idserie_ra');
                let parsed;
                try { parsed = JSON.parse(raw || '[21]'); } catch { return [21]; }
                // Tolera dados legados aninhados como [[[21,9]]] vindos do sync alter
                if (Array.isArray(parsed)) {
                    const flat = parsed.flat(Infinity).map(Number).filter(n => Number.isFinite(n) && n > 0);
                    return Array.from(new Set(flat));
                }
                const n = Number(parsed);
                return Number.isFinite(n) && n > 0 ? [n] : [];
            },
            set(val) {
                const raw = Array.isArray(val) ? val : [val];
                const flat = raw.flat(Infinity).map(Number).filter(n => Number.isFinite(n) && n > 0);
                const unique = Array.from(new Set(flat));
                this.setDataValue('idserie_ra', JSON.stringify(unique));
            },
        },

        // ── Reserva morta: cancelada, distratada, vencida ─────────────────────
        // IDs de situação do CV que significam "essa reserva não vai andar".
        // Boleto que ficou pelo caminho nessas reservas não é trabalho pendente:
        // o cartão "Com erro" contava reserva cancelada há semanas junto com
        // erro de verdade, e não havia como resolver aquela linha - o cliente
        // desistiu. Sai do erro e vira "Cancelada" na tela.
        //
        // Qual id significa o quê é dado do tenant, não constante: no CV da
        // Menin hoje 4 = Cancelada e 11 = Vencida. O padrão cobre só a
        // cancelada; incluir outras é decisão da tela.
        cv_situacoes_reserva_morta: {
            type: DataTypes.TEXT,
            defaultValue: '[4]',
            comment: 'IDs de situação CV que marcam reserva morta (JSON array). Ex: [4] ou [4,11]. Vazio desliga o bucket.',
            get() {
                const raw = this.getDataValue('cv_situacoes_reserva_morta');
                let parsed;
                try { parsed = JSON.parse(raw ?? '[4]'); } catch { return [4]; }
                if (!Array.isArray(parsed)) parsed = [parsed];
                const flat = parsed.flat(Infinity).map(Number).filter(n => Number.isFinite(n) && n > 0);
                return Array.from(new Set(flat));
            },
            set(val) {
                const raw = Array.isArray(val) ? val : (val == null ? [] : [val]);
                const flat = raw.flat(Infinity).map(Number).filter(n => Number.isFinite(n) && n > 0);
                this.setDataValue('cv_situacoes_reserva_morta', JSON.stringify(Array.from(new Set(flat))));
            },
        },

        // ── Configuração de anexo CV ───────────────────────────────────────────
        cv_idtipo_documento: {
            type: DataTypes.INTEGER,
            allowNull: true,
            comment: 'idtipo para anexar boleto na reserva do CV (obtido na API de tipos de arquivo)',
        },

        // ── Etapa da reserva no CV: NÃO mexemos mais ─────────────────────────
        // Até 26/08/2026 havia aqui situacao_sucesso_id / erro / pago / baixado e
        // o delay alinhado ao lote. O Office movia a reserva para Ato Emitido /
        // Divergente / Pago / Vencido assim que o ato era resolvido - e ao sair de
        // "Envio Sienge" a venda deixava de ser alcançada pelo lote que a manda ao
        // ERP: 13% a 16% das vendas do ato ficavam sem contrato no Sienge. Agora a
        // reserva fica em Envio Sienge e o status do ato vai na MENSAGEM
        // (lib/atoStatus.js). As colunas seguem no banco, sem uso, para não perder
        // o histórico; o CV está excluindo as quatro etapas do workflow.

        tolerancia_dias_uteis: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 1,
            comment: 'Dias úteis após vencimento (já considerando fim de semana/feriado) para baixar o boleto. 1 = boleto pago compensa em D+1 útil.',
        },

        revalidacao_baixado_dias: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 5,
            comment: 'Por quantos dias após a baixa o boleto continua sendo reconsultado no Ecobrança. O banco já devolveu "BAIXADO POR DEVOLUÇÃO" em título que dias depois constava LIQUIDADO no extrato; nessa janela a consulta é só leitura e o único desfecho é promover para pago. 0 desliga.',
        },

        max_dias_vencimento: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 10,
            comment: 'Dias corridos máximos entre hoje e a data de vencimento do boleto. Vencimento acima → erro "excede limite". Override por empreendimento em boleto_comission_rules.max_dias_vencimento.',
        },

        // Teto de segurança: o valor vem cru da série do CV, sem validação de
        // origem. Um valor absurdo (série em centavos, série errada, digitação)
        // virava boleto real no banco. Acima deste teto a emissão para com
        // status 'error' em vez de registrar no Ecobrança.
        valor_maximo: {
            type: DataTypes.DECIMAL(15, 2),
            allowNull: true,
            defaultValue: 300000,
            comment: 'Valor máximo (R$) aceito para emissão. Série acima disto → erro "excede teto", sem registrar no banco. Vazio = sem teto.',
        },

        // ── Comissão fora do contrato ─────────────────────────────────────────
        // A série de ato pode trazer embutida a comissão que o cliente paga
        // direto à imobiliária; só o que sobra é da incorporadora e vira
        // cobrança. O CV informa quanto é essa comissão NA VENDA INTEIRA
        // (valor_contrato menos valor_liquido), mas não diz em qual série ela
        // está: no Verona ela cai toda no ato, no Ipês e no Urban ela está
        // espalhada nas parcelas (medido em 03/09/2026 - lá o ato chega a ser
        // menor que a comissão da venda). Por isso o padrão é 'nenhum', o
        // comportamento de sempre, e deduzir a comissão do CV é opção que se
        // liga empreendimento a empreendimento em boleto_comission_rules.modo,
        // depois de conferir na tela de condições do CV que a coluna "sem
        // comissão fora do contrato" só muda na linha do ato.
        comissao_modo: {
            type: DataTypes.STRING(20),
            allowNull: false,
            defaultValue: 'nenhum',
            comment: "Modo padrão de cálculo do valor: 'nenhum' (emite o valor cheio da série) ou 'cv' (deduz a comissão fora do contrato informada pelo CV). Vale para empreendimento sem regra própria.",
        },

        // ── Janela de funcionamento (horário de Brasília) ──────────────────────
        // Acionamentos recebidos fora da janela não são processados na hora: a
        // emissão fica agendada pra próxima abertura (ver lib/boletoJanela.js e
        // scheduler/boletoWindowScheduler.js). Padrão 06:00-23:00 desde
        // 19/08/2026 (era 08:00-20:00) — só a madrugada fica de fora.
        janela_ativa: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: true,
            comment: 'Liga a janela de funcionamento. Desligada = emite a qualquer hora (comportamento antigo).',
        },
        janela_inicio_hora: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 6,
            comment: 'Hora cheia de abertura da janela, no fuso de Brasília (0-23).',
        },
        janela_fim_hora: {
            type: DataTypes.INTEGER,
            allowNull: true,
            defaultValue: 23,
            comment: 'Hora cheia de fechamento da janela, no fuso de Brasília (1-24). Janela aberta em [início, fim).',
        },

        // ── Parcelas mensais (plano por reserva) ─────────────────────────────
        // Depois do ato pago, o Office cobra as mensais ate o Sienge faturar o
        // contrato. Defaults em lib/atoParcelas.js (PARCELAS_DEFAULTS); a tela
        // e a dona do valor. `parcelas_ativo` nasce DESLIGADO: o deploy so
        // calcula e mostra os planos; nada e emitido ate ligar.
        parcelas_ativo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        parcelas_idseries: {
            type: DataTypes.TEXT,
            defaultValue: '[20,1,37]',
            comment: 'IDs de serie do CV tratadas como mensais (JSON array).',
            get() {
                const raw = this.getDataValue('parcelas_idseries');
                let parsed;
                try { parsed = JSON.parse(raw ?? '[20,1,37]'); } catch { return [20, 1, 37]; }
                if (!Array.isArray(parsed)) parsed = [parsed];
                const flat = parsed.flat(Infinity).map(Number).filter(n => Number.isFinite(n) && n > 0);
                return Array.from(new Set(flat));
            },
            set(val) {
                const raw = Array.isArray(val) ? val : (val == null ? [] : [val]);
                const flat = raw.flat(Infinity).map(Number).filter(n => Number.isFinite(n) && n > 0);
                this.setDataValue('parcelas_idseries', JSON.stringify(Array.from(new Set(flat))));
            },
        },
        parcelas_exigir_ato_pago: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, comment: 'Plano so nasce com o ato pago (boleto ou cartao).' },
        parcelas_antecedencia_dias: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 10, comment: 'Boleto da parcela sai N dias corridos antes do vencimento.' },
        parcelas_encerrar_quando_faturado: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, comment: 'Encerra o plano quando o contrato ganha titulo no Sienge (contracts.receivable_bill_id).' },
        parcelas_vencidas_na_adesao: { type: DataTypes.STRING(10), allowNull: true, defaultValue: 'emitir', comment: "'emitir' (hoje + prazo, sem encargos) | 'ignorar' para parcelas ja vencidas quando o plano nasce." },
        parcelas_prazo_vencida_dias: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 5, comment: 'Dias corridos ate o novo vencimento de parcela ja vencida (adesao e reemissao).' },
        parcelas_hora_rodada: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 9, comment: 'Hora cheia (Brasilia) da rodada diaria de parcelas.' },
        parcelas_max_emissoes_rodada: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 40, comment: 'Teto de boletos emitidos por rodada (o resto sai no dia seguinte).' },
        atraso_reemitir: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, comment: 'Parcela vencida e baixada e reemitida automaticamente.' },
        atraso_max_reemissoes: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 3, comment: 'Quantas vias novas por parcela antes de parar e chamar gente.' },
        atraso_cobrar_encargos: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, comment: 'Reemissao por atraso leva multa + juros.' },
        atraso_multa_pct: { type: DataTypes.DECIMAL(6, 2), allowNull: true, defaultValue: 2, comment: 'Multa (%) sobre o valor original, uma vez.' },
        atraso_juros_mes_pct: { type: DataTypes.DECIMAL(6, 2), allowNull: true, defaultValue: 1, comment: 'Juros (% ao mes) pro rata dia sobre o valor original.' },
        lembrete_dias_antes: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 3, comment: 'Lembrete ao cliente N dias antes do vencimento (0 desliga).' },
        aviso_atraso_dias_depois: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 1, comment: 'Aviso de vencido N dias depois do vencimento (0 desliga).' },
        parcelas_ultima_rodada_em: { type: DataTypes.DATE, allowNull: true, comment: 'Quando a rodada diaria de parcelas rodou pela ultima vez (sobrevive a restart).' },

        // ── Controle ───────────────────────────────────────────────────────────
        active: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
            comment: 'Habilita/desabilita o processamento automático de boletos',
        },

        updated_by: { type: DataTypes.INTEGER, allowNull: true },
    }, {
        tableName: 'boleto_settings',
        underscored: true,
        timestamps: true,
    });

    BoletoSettings.associate = () => {};
    return BoletoSettings;
};
