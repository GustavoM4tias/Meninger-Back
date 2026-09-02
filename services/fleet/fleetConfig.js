// services/fleet/fleetConfig.js
//
// Configuração da frota e a lista de quem tem a tela.
//
// Mora num arquivo só para quebrar o ciclo: o fleetService chama o calendário
// para espelhar o evento, e o calendário precisa da configuração e dos
// participantes. Com tudo no mesmo arquivo, os dois se importariam.
import db from '../../models/sequelize/index.js';
import { getEffectiveRoutesBulk } from '../permissions/permissionAccessService.js';

export const ROTA_FROTA = '/frota';

// Fallbacks de código. Valem só enquanto a linha de fleet_settings não existe:
// o painel sempre ganha do código.
export const FALLBACK = {
    horas_expirar_sem_retirada: 4,
    max_dias_reserva: 15,
    antecedencia_max_dias: 90,
    lembrete_retirada_horas: 24,
    exigir_km: true,
    exigir_combustivel: true,
    exigir_destino: true,
    exigir_face: true,
    min_fotos_saida: 1,
    min_fotos_chegada: 1,
    km_max_por_dia: 1000,
    hora_inicio_manha: '07:00',
    hora_fim_manha: '12:00',
    hora_inicio_tarde: '13:00',
    hora_fim_tarde: '18:00',
    departamentos: [],
    gestor_user_ids: [],
    evento_ativo: true,
    evento_organizador_email: null,
    evento_participantes: 'alcada',
    evento_mostrar_como: 'free',
    evento_lembrete_minutos: 0,
    teams_webhook_url: null,
    teams_webhook_ativo: false,
};

function erro(mensagem, status = 400) {
    const e = new Error(mensagem);
    e.status = status;
    return e;
}

export async function getSettings() {
    const row = await db.FleetSettings.findByPk(1);
    if (!row) return { ...FALLBACK, id: 1 };
    const json = row.toJSON();
    // Coluna nula (banco antigo) não pode derrubar a regra: cai no fallback.
    for (const [chave, valor] of Object.entries(FALLBACK)) {
        if (json[chave] === null || json[chave] === undefined) json[chave] = valor;
    }
    return json;
}

export async function saveSettings(patch = {}) {
    const permitido = [
        'horas_expirar_sem_retirada', 'max_dias_reserva', 'antecedencia_max_dias',
        'lembrete_retirada_horas', 'exigir_km', 'exigir_combustivel', 'exigir_destino', 'exigir_face',
        'min_fotos_saida', 'min_fotos_chegada', 'km_max_por_dia', 'hora_inicio_manha', 'hora_fim_manha', 'hora_inicio_tarde',
        'hora_fim_tarde', 'departamentos', 'gestor_user_ids', 'evento_ativo',
        'evento_organizador_email', 'evento_participantes', 'evento_mostrar_como',
        'evento_lembrete_minutos', 'teams_webhook_url', 'teams_webhook_ativo',
    ];

    const dados = {};
    for (const chave of permitido) {
        if (chave in patch) dados[chave] = patch[chave];
    }

    // Validação: config que entra torta quebra a agenda inteira depois.
    const inteiros = {
        horas_expirar_sem_retirada: [1, 72],
        max_dias_reserva: [1, 365],
        antecedencia_max_dias: [1, 730],
        lembrete_retirada_horas: [0, 168],
        evento_lembrete_minutos: [0, 1440],
        min_fotos_saida: [0, 8],
        min_fotos_chegada: [0, 8],
        // Teto largo de propósito: barra o dedo gordo, não a viagem longa.
        km_max_por_dia: [100, 5000],
    };
    for (const [chave, [min, max]] of Object.entries(inteiros)) {
        if (!(chave in dados)) continue;
        const n = Number(dados[chave]);
        if (!Number.isInteger(n) || n < min || n > max) {
            throw erro(`${chave} deve ser um número inteiro entre ${min} e ${max}.`);
        }
        dados[chave] = n;
    }
    for (const chave of ['hora_inicio_manha', 'hora_fim_manha', 'hora_inicio_tarde', 'hora_fim_tarde']) {
        if (chave in dados && !/^\d{2}:\d{2}$/.test(String(dados[chave]))) {
            throw erro(`${chave} deve estar no formato HH:MM.`);
        }
    }
    for (const chave of ['departamentos', 'gestor_user_ids']) {
        if (chave in dados && !Array.isArray(dados[chave])) throw erro(`${chave} deve ser uma lista.`);
    }
    if ('evento_participantes' in dados && !['alcada', 'nenhum'].includes(dados.evento_participantes)) {
        throw erro('evento_participantes aceita apenas "alcada" ou "nenhum".');
    }
    if ('evento_mostrar_como' in dados && !['free', 'busy'].includes(dados.evento_mostrar_como)) {
        throw erro('evento_mostrar_como aceita apenas "free" ou "busy".');
    }
    if ('evento_organizador_email' in dados && dados.evento_organizador_email) {
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(dados.evento_organizador_email))) {
            throw erro('A caixa que organiza o evento precisa ser um e-mail válido.');
        }
    }

    const [row] = await db.FleetSettings.findOrCreate({ where: { id: 1 }, defaults: { id: 1 } });
    await row.update(dados);
    return getSettings();
}

/**
 * Quem entra como participante do evento: as pessoas com `/frota` DECLARADA na
 * alçada.
 *
 * Admin NÃO entra por ser admin. O bypass de administrador é sobre poder abrir
 * a tela; convite de calendário é outra coisa - é uma inscrição. Enquanto os
 * dois estavam juntos, toda reserva convidava os 7 administradores do Office
 * (a diretoria inteira), sem que ninguém tivesse pedido a tela: a lista de
 * convidados era "quem é admin", não "quem usa o carro". Um diretor recebeu
 * convite de uma viagem que não era dele, e foi assim que o problema apareceu.
 *
 * Consequência aceita: enquanto ninguém tiver `/frota` na alçada, o evento
 * nasce SEM convidados. É o certo - convidar quem não pediu é pior do que não
 * convidar ninguém. O admin continua abrindo a tela normalmente.
 */
export async function usuariosDaAlcada() {
    const usuarios = await db.User.findAll({
        where: { status: true, approval_status: 'approved' },
        attributes: ['id', 'username', 'email', 'role'],
        raw: true,
    });
    if (!usuarios.length) return [];

    const rotasPorUsuario = await getEffectiveRoutesBulk(usuarios.map(u => u.id));

    return usuarios.filter(u => {
        const rotas = (rotasPorUsuario.get(Number(u.id)) || []).map(r => String(r).toLowerCase());
        return rotas.includes(ROTA_FROTA);
    });
}

export default { ROTA_FROTA, FALLBACK, getSettings, saveSettings, usuariosDaAlcada };
