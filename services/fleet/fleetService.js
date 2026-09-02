// services/fleet/fleetService.js
//
// A regra do veículo corporativo. O que este módulo resolve e o grupo do Teams
// não resolvia: saber, no momento do pedido, o que já está ocupado.
//
// TRÊS COISAS DIFERENTES, DE PROPÓSITO
//   agenda  - a janela reservada (futuro, cancelável)
//   posse   - quem está com a chave AGORA (presente, um só)
//   bordo   - km, combustível, avaria (passado, vira relatório)
// Confundir as três é o que faz sistema de frota virar planilha morta.
import { Op } from 'sequelize';
import db from '../../models/sequelize/index.js';
import NotificationService from '../notification/NotificationService.js';
import { NotificationType } from '../notification/notificationTypes.js';
import { ROTA_FROTA, FALLBACK, getSettings, saveSettings, usuariosDaAlcada } from './fleetConfig.js';
import fleetCalendarService from './fleetCalendarService.js';
import { conferirLeitura } from './fleetOdometerService.js';
import { conferirRosto } from '../../lib/faceMatch.js';

export { ROTA_FROTA, getSettings, saveSettings, usuariosDaAlcada };

const OCUPAM = ['reservada', 'em_uso'];
const NIVEIS_COMBUSTIVEL = ['reserva', '1/4', '1/2', '3/4', 'cheio'];

// Brasil não tem horário de verão desde 2019, então o deslocamento é fixo.
// Montar a data como string ISO com o fuso explícito evita o erro clássico de
// "reservou 24/08 e apareceu 23/08": o Railway roda em UTC e o `new Date('...')`
// sem fuso seria interpretado como UTC, jogando a manhã para o dia anterior.
const TZ_OFFSET = '-03:00';

function erro(mensagem, status = 400, extra = {}) {
    const e = new Error(mensagem);
    e.status = status;
    Object.assign(e, extra);
    return e;
}


/**
 * Gestor da frota é regra de NEGÓCIO do módulo, não capacidade de tela: a
 * tabela de capacidades só sabe responder "tem a tela" x "é admin", e aqui
 * existe um terceiro papel (quem cuida do carro sem administrar o Office).
 */
export async function isGestor(user, settings = null) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    const cfg = settings || await getSettings();
    return (cfg.gestor_user_ids || []).map(Number).includes(Number(user.id));
}

// ── Janela ────────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' + 'HH:MM' -> Date no fuso de Brasília. */
export function montarData(dia, hora) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dia || ''))) throw erro('Data inválida (use AAAA-MM-DD).');
    if (!/^\d{2}:\d{2}$/.test(String(hora || ''))) throw erro('Hora inválida (use HH:MM).');
    const data = new Date(`${dia}T${hora}:00${TZ_OFFSET}`);
    if (Number.isNaN(data.getTime())) throw erro('Data ou hora inválida.');
    return data;
}

/**
 * Traduz o jeito que a pessoa pensa ("dia 24 à tarde até o 28") para a janela
 * que o banco entende. `fim` fecha no fim do período escolhido, então manhã e
 * tarde do mesmo dia não colidem.
 */
export function resolverJanela({ dia_inicio, dia_fim, periodo, hora_inicio, hora_fim }, settings) {
    const cfg = settings || FALLBACK;
    const fimDia = dia_fim || dia_inicio;

    if (periodo === 'personalizado') {
        const inicio = montarData(dia_inicio, hora_inicio);
        const fim = montarData(fimDia, hora_fim);
        return { inicio, fim, periodo };
    }

    const mapa = {
        manha: [cfg.hora_inicio_manha, cfg.hora_fim_manha],
        tarde: [cfg.hora_inicio_tarde, cfg.hora_fim_tarde],
        dia: [cfg.hora_inicio_manha, cfg.hora_fim_tarde],
    };
    const faixa = mapa[periodo];
    if (!faixa) throw erro('Período inválido (manha, tarde, dia ou personalizado).');

    // Reserva de vários dias sempre começa no início do primeiro período e
    // termina no fim do expediente do último: "24 a tarde até 28" quer dizer
    // que o carro só volta no dia 28, não que ele volta toda noite.
    const horaInicial = faixa[0];
    const horaFinal = fimDia !== dia_inicio ? cfg.hora_fim_tarde : faixa[1];

    return { inicio: montarData(dia_inicio, horaInicial), fim: montarData(fimDia, horaFinal), periodo };
}

// ── Conflito ──────────────────────────────────────────────────────────────

/**
 * O que ocupa o veículo nesta janela. Duas janelas se sobrepõem quando uma
 * começa antes da outra terminar - e o fim é exclusivo, senão devolver 12:00 e
 * retirar 12:00 no mesmo dia seria considerado choque.
 */
export async function conflitos(vehicleId, inicio, fim, { ignorarReservaId = null } = {}) {
    const sobrepoe = { inicio: { [Op.lt]: fim }, fim: { [Op.gt]: inicio } };

    const [reservas, bloqueios] = await Promise.all([
        db.VehicleReservation.findAll({
            where: {
                vehicle_id: vehicleId,
                status: { [Op.in]: OCUPAM },
                ...(ignorarReservaId ? { id: { [Op.ne]: ignorarReservaId } } : {}),
                ...sobrepoe,
            },
            include: [{ model: db.User, as: 'condutor', attributes: ['id', 'username', 'email'], required: false }],
            order: [['inicio', 'ASC']],
        }),
        db.VehicleBlock.findAll({
            where: { vehicle_id: vehicleId, ...sobrepoe },
            order: [['inicio', 'ASC']],
        }),
    ]);

    return { reservas, bloqueios, livre: reservas.length === 0 && bloqueios.length === 0 };
}

function nomeDe(user) {
    // `users` não tem coluna `name`: o nome legível é o username.
    return user?.username || user?.email || 'alguém';
}

function descreverConflito({ reservas, bloqueios }) {
    if (bloqueios.length) {
        const b = bloqueios[0];
        return `O veículo está indisponível nesse período (${b.motivo || b.tipo}).`;
    }
    const r = reservas[0];
    const fmt = new Intl.DateTimeFormat('pt-BR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
    });
    return `Já reservado por ${nomeDe(r.condutor)} de ${fmt.format(r.inicio)} até ${fmt.format(r.fim)}.`;
}

// ── Estado atual (a pergunta que o grupo do Teams nunca respondia) ─────────

export async function estadoDoVeiculo(vehicleId) {
    const agora = new Date();

    const [emUso, proxima, bloqueioAtivo] = await Promise.all([
        db.VehicleReservation.findOne({
            where: { vehicle_id: vehicleId, status: 'em_uso' },
            include: [{ model: db.User, as: 'condutor', attributes: ['id', 'username', 'email'], required: false }],
            order: [['retirado_em', 'DESC']],
        }),
        db.VehicleReservation.findOne({
            where: { vehicle_id: vehicleId, status: 'reservada', fim: { [Op.gt]: agora } },
            include: [{ model: db.User, as: 'condutor', attributes: ['id', 'username', 'email'], required: false }],
            order: [['inicio', 'ASC']],
        }),
        db.VehicleBlock.findOne({
            where: { vehicle_id: vehicleId, inicio: { [Op.lte]: agora }, fim: { [Op.gt]: agora } },
        }),
    ]);

    let situacao = 'livre';
    if (emUso) situacao = 'em_uso';
    else if (bloqueioAtivo) situacao = 'indisponivel';
    else if (proxima && proxima.inicio <= agora) situacao = 'reservado_agora';

    return {
        situacao,
        atrasado: Boolean(emUso && emUso.fim < agora),
        em_uso: emUso,
        proxima,
        bloqueio: bloqueioAtivo,
    };
}

export async function listarVeiculos({ apenasAtivos = true } = {}) {
    const veiculos = await db.Vehicle.findAll({
        where: apenasAtivos ? { ativo: true } : {},
        order: [['ativo', 'DESC'], ['tipo', 'ASC'], ['id', 'ASC']],
    });

    return Promise.all(veiculos.map(async v => ({
        ...v.toJSON(),
        estado: await estadoDoVeiculo(v.id),
    })));
}

export async function agenda({ vehicleId = null, de, ate }) {
    const janela = { inicio: { [Op.lt]: ate }, fim: { [Op.gt]: de } };
    const filtroVeiculo = vehicleId ? { vehicle_id: vehicleId } : {};

    const [reservas, bloqueios] = await Promise.all([
        db.VehicleReservation.findAll({
            where: { ...filtroVeiculo, status: { [Op.in]: OCUPAM }, ...janela },
            include: [{ model: db.User, as: 'condutor', attributes: ['id', 'username', 'email'], required: false }],
            order: [['inicio', 'ASC']],
        }),
        db.VehicleBlock.findAll({ where: { ...filtroVeiculo, ...janela }, order: [['inicio', 'ASC']] }),
    ]);

    return { reservas, bloqueios };
}

// ── Reserva ───────────────────────────────────────────────────────────────

export async function criarReserva(payload, user) {
    const settings = await getSettings();

    const veiculo = await db.Vehicle.findByPk(payload.vehicle_id);
    if (!veiculo || !veiculo.ativo) throw erro('Veículo não encontrado ou inativo.', 404);

    const { inicio, fim, periodo } = resolverJanela(payload, settings);
    if (fim <= inicio) throw erro('O fim da reserva precisa ser depois do início.');

    const dias = (fim - inicio) / 86400000;
    if (dias > settings.max_dias_reserva) {
        throw erro(`Reserva de no máximo ${settings.max_dias_reserva} dias (esta tem ${Math.ceil(dias)}).`);
    }
    const antecedencia = (inicio - Date.now()) / 86400000;
    if (antecedencia > settings.antecedencia_max_dias) {
        throw erro(`Só é possível reservar com até ${settings.antecedencia_max_dias} dias de antecedência.`);
    }
    // Reserva no passado é sempre erro de digitação, e ela nasceria já expirada.
    if (fim < new Date()) throw erro('Esse período já passou.');

    if (settings.exigir_destino && !String(payload.destino || '').trim()) {
        throw erro('Informe o destino ou a rota prevista.');
    }

    const choque = await conflitos(veiculo.id, inicio, fim);
    if (!choque.livre) throw erro(descreverConflito(choque), 409, { conflito: true });

    const condutorId = Number(payload.user_id) || user.id;

    const reserva = await db.VehicleReservation.create({
        vehicle_id: veiculo.id,
        user_id: condutorId,
        created_by_user_id: user.id,
        departamento: payload.departamento || null,
        inicio,
        fim,
        periodo,
        destino: payload.destino || null,
        solicitado_por: payload.solicitado_por || null,
        observacao: payload.observacao || null,
        status: 'reservada',
    });

    await fleetCalendarService.sincronizarEvento(reserva.id).catch(() => {});
    await avisarReservaCriada(reserva, veiculo, user);

    return carregarReserva(reserva.id);
}

export async function carregarReserva(id) {
    return db.VehicleReservation.findByPk(id, {
        include: [
            { model: db.User, as: 'condutor', attributes: ['id', 'username', 'email'], required: false },
            { model: db.Vehicle, as: 'veiculo', required: false },
        ],
    });
}

/** Dono da reserva, quem a cadastrou, gestor da frota ou admin. */
export async function podeMexer(reserva, user, settings = null) {
    if (!reserva || !user) return false;
    if (Number(reserva.user_id) === Number(user.id)) return true;
    if (Number(reserva.created_by_user_id) === Number(user.id)) return true;
    return isGestor(user, settings);
}

export async function cancelarReserva(id, user, motivo = null) {
    const settings = await getSettings();
    const reserva = await carregarReserva(id);
    if (!reserva) throw erro('Reserva não encontrada.', 404);
    if (!await podeMexer(reserva, user, settings)) throw erro('Você não pode cancelar esta reserva.', 403);
    if (reserva.status === 'devolvida') throw erro('Essa reserva já foi encerrada.');
    if (reserva.status === 'em_uso') throw erro('O veículo está em uso: registre a devolução em vez de cancelar.');
    if (reserva.status === 'cancelada') return reserva;

    await reserva.update({
        status: 'cancelada',
        cancelado_em: new Date(),
        cancelado_por_user_id: user.id,
        motivo_cancelamento: motivo || null,
    });

    await fleetCalendarService.removerEvento(reserva).catch(() => {});

    // Cancelou a reserva de outra pessoa: ela precisa saber, e por quem.
    if (Number(reserva.user_id) !== Number(user.id)) {
        await notificar({
            type: NotificationType.FLEET_RESERVATION_CANCELLED,
            users: [reserva.user_id],
            title: 'Sua reserva do veículo foi cancelada',
            body: `${nomeDe(user)} cancelou a reserva de ${formatarJanela(reserva)}${motivo ? `. Motivo: ${motivo}` : '.'}`,
            data: { reservationId: reserva.id },
        });
    }

    return reserva;
}

// ── Retirada e devolução ──────────────────────────────────────────────────

/**
 * Conferência facial da retirada.
 *
 * A pergunta que ela responde é "quem está com a chave na mão é mesmo quem
 * está logado?". Sessão aberta em celular emprestado, ou alguém retirando no
 * lugar de outro, deixava o registro apontando para a pessoa errada - e é o
 * registro que responde por multa, avaria e combustível depois.
 *
 * Quem ainda não tem rosto cadastrado NÃO é barrado com um "não pode": a tela
 * manda cadastrar e volta. Barrar sem caminho de saída é o que faz a operação
 * abandonar o sistema.
 */
async function conferirFace(user, payload, settings) {
    if (!settings.exigir_face) return;

    const dono = await db.User.findByPk(user.id, {
        attributes: ['id', 'username', 'face_enabled', 'face_template', 'face_threshold'],
    });

    if (!dono?.face_enabled || !dono.face_template) {
        const e = erro('Cadastre seu rosto para retirar o veículo.', 428);
        e.code = 'FACE_NAO_CADASTRADA';
        throw e;
    }

    const embedding = payload.face_descriptor;
    if (!Array.isArray(embedding) || !embedding.length) {
        const e = erro('Confirme seu rosto para registrar a retirada.', 428);
        e.code = 'FACE_OBRIGATORIA';
        throw e;
    }

    const r = conferirRosto(embedding, dono.face_template, dono.face_threshold);
    if (!r.ok) {
        const e = erro('Não reconheci o rosto. Tente de novo com mais luz e o rosto centralizado.', 403);
        e.code = 'FACE_NAO_CONFERE';
        throw e;
    }
}

/**
 * As fotos do estado do veículo.
 *
 * Obrigatórias nos dois momentos, e é a simetria que dá valor: foto só na saída
 * mostra como o carro estava, foto só na chegada mostra como ficou; as duas
 * juntas mostram o que ACONTECEU naquela viagem. Uma sozinha não prova nada.
 */
function conferirFotos(fotos, minimo, momento) {
    const lista = Array.isArray(fotos) ? fotos.filter(f => f?.url) : [];
    if (lista.length < minimo) {
        throw erro(
            minimo === 1
                ? `Anexe ao menos uma foto do estado do veículo ${momento}.`
                : `Anexe ao menos ${minimo} fotos do estado do veículo ${momento}.`,
        );
    }
    return lista;
}

export async function retirar(id, payload, user) {
    const settings = await getSettings();
    const reserva = await carregarReserva(id);
    if (!reserva) throw erro('Reserva não encontrada.', 404);
    if (!await podeMexer(reserva, user, settings)) throw erro('Você não pode retirar nesta reserva.', 403);
    if (reserva.status === 'em_uso') throw erro('Esta reserva já está com o veículo retirado.');
    if (reserva.status !== 'reservada') throw erro('Só dá para retirar numa reserva ativa.');

    // Outra pessoa está com a chave: retirar aqui deixaria o registro mentindo
    // sobre quem tem o carro.
    const estado = await estadoDoVeiculo(reserva.vehicle_id);
    if (estado.em_uso && Number(estado.em_uso.id) !== Number(reserva.id)) {
        throw erro(`O veículo ainda está com ${nomeDe(estado.em_uso.condutor)}. A devolução precisa ser registrada antes.`, 409);
    }

    if (settings.exigir_km && !Number.isInteger(Number(payload.km_saida))) {
        throw erro('Informe o KM do odômetro na saída.');
    }
    if (settings.exigir_combustivel && !NIVEIS_COMBUSTIVEL.includes(payload.combustivel_saida)) {
        throw erro('Informe o nível de combustível na saída.');
    }
    // Avaria NÃO se pergunta na retirada.
    //
    // Exigir que a pessoa escrevesse todas as avarias existentes antes de sair
    // era um pedágio impossível: um carro rodado tem dezenas de marcas, e
    // ninguém as descreve com a chave na mão. A avaria virou histórico do
    // VEÍCULO (vehicle_logs), alimentado na devolução por quem viu o dano
    // acontecer, e mostrado na retirada como leitura - que é o que de fato
    // protege quem está pegando o carro.

    // Rosto antes de tudo: não faz sentido validar km de uma retirada que pode
    // não ser da pessoa que está logada.
    await conferirFace(user, payload, settings);

    const fotos = conferirFotos(payload.fotos, settings.min_fotos_saida, 'na saída');

    const km = Number(payload.km_saida);
    const veiculo = await db.Vehicle.findByPk(reserva.vehicle_id);

    // O padrão do odômetro: nunca menor que a última leitura, e sem salto
    // impossível desde ela. Vale para o número digitado e para o que a IA leu
    // na foto do painel - a origem não muda a regra.
    if (Number.isInteger(km)) {
        const conferencia = conferirLeitura({
            valor: km,
            piso: veiculo?.km_atual,
            desde: veiculo?.km_atualizado_em,
            kmMaxDia: settings.km_max_por_dia,
        });
        if (!conferencia.ok) throw erro(conferencia.motivo);
    }

    await reserva.update({
        status: 'em_uso',
        retirado_em: new Date(),
        km_saida: Number.isInteger(km) ? km : null,
        combustivel_saida: payload.combustivel_saida || null,
        obs_saida: payload.obs_saida || null,
        fotos_saida: fotos,
    });

    if (Number.isInteger(km) && veiculo) {
        await veiculo.update({ km_atual: km, km_atualizado_em: new Date() });
    }

    await fleetCalendarService.sincronizarEvento(reserva.id).catch(() => {});
    await avisarRetirada(reserva, user);

    return carregarReserva(reserva.id);
}

export async function devolver(id, payload, user) {
    const settings = await getSettings();
    const reserva = await carregarReserva(id);
    if (!reserva) throw erro('Reserva não encontrada.', 404);
    if (!await podeMexer(reserva, user, settings)) throw erro('Você não pode devolver nesta reserva.', 403);
    if (reserva.status !== 'em_uso') throw erro('Esta reserva não está com o veículo retirado.');

    if (settings.exigir_km && !Number.isInteger(Number(payload.km_chegada))) {
        throw erro('Informe o KM do odômetro na devolução.');
    }
    if (settings.exigir_combustivel && !NIVEIS_COMBUSTIVEL.includes(payload.combustivel_chegada)) {
        throw erro('Informe o nível de combustível na devolução.');
    }

    const fotos = conferirFotos(payload.fotos, settings.min_fotos_chegada, 'na devolução');

    const km = Number(payload.km_chegada);
    if (Number.isInteger(km)) {
        // O piso aqui é o km da SAÍDA desta viagem, e o prazo é o tempo que o
        // carro ficou fora - não a última leitura do veículo, que é a mesma
        // saída. Assim o teto acompanha a duração real da viagem.
        const conferencia = conferirLeitura({
            valor: km,
            piso: reserva.km_saida,
            desde: reserva.retirado_em,
            kmMaxDia: settings.km_max_por_dia,
        });
        if (!conferencia.ok) throw erro(conferencia.motivo);
    }

    const houveAbastecimento = payload.houve_abastecimento === true;
    const houveAvaria = payload.houve_avaria === true;
    if (houveAbastecimento && !String(payload.abastecimento_desc || '').trim()) {
        throw erro('Informe os litros e o valor do abastecimento.');
    }
    if (houveAvaria && !String(payload.avaria_desc || '').trim()) {
        throw erro('Descreva a avaria ou ocorrência.');
    }

    const agora = new Date();
    await reserva.update({
        status: 'devolvida',
        devolvido_em: agora,
        km_chegada: Number.isInteger(km) ? km : null,
        combustivel_chegada: payload.combustivel_chegada || null,
        houve_abastecimento: houveAbastecimento,
        abastecimento_desc: houveAbastecimento ? payload.abastecimento_desc : null,
        houve_avaria: houveAvaria,
        avaria_desc: houveAvaria ? payload.avaria_desc : null,
        obs_chegada: payload.obs_chegada || null,
        fotos_chegada: fotos,
    });

    if (Number.isInteger(km)) {
        const veiculo = await db.Vehicle.findByPk(reserva.vehicle_id);
        if (veiculo) await veiculo.update({ km_atual: km, km_atualizado_em: agora });
    }

    // O que a pessoa acabou de contar vira diário de bordo. Sem isto, o dado
    // ficaria preso na reserva e nunca viraria custo por departamento.
    if (houveAbastecimento) {
        await db.VehicleLog.create({
            vehicle_id: reserva.vehicle_id, reservation_id: reserva.id, tipo: 'abastecimento',
            descricao: payload.abastecimento_desc, km: Number.isInteger(km) ? km : null,
            valor: extrairValor(payload.abastecimento_desc), ocorrido_em: agora, created_by_user_id: user.id,
        });
    }
    if (houveAvaria) {
        await db.VehicleLog.create({
            vehicle_id: reserva.vehicle_id, reservation_id: reserva.id, tipo: 'avaria',
            descricao: payload.avaria_desc, km: Number.isInteger(km) ? km : null,
            // A primeira foto da devolução vira a prova da avaria no histórico
            // do carro: sem ela, o próximo condutor lê "risco na porta" e não
            // sabe qual risco.
            anexo_url: fotos[0]?.url || null,
            ocorrido_em: agora, created_by_user_id: user.id,
        });
    }

    await fleetCalendarService.encerrarEvento(reserva).catch(() => {});
    await avisarDevolucao(reserva, user);

    return carregarReserva(reserva.id);
}

/** "45 litros, R$ 280,50" -> 280.5. Só para poupar digitação; nunca inventa. */
function extrairValor(texto) {
    const m = String(texto || '').match(/R\$\s*([\d.]+,\d{2}|\d+[.,]?\d*)/i);
    if (!m) return null;
    const bruto = m[1].replace(/\./g, '').replace(',', '.');
    const n = Number(bruto);
    return Number.isFinite(n) ? n : null;
}

// ── Bloqueio (manutenção) ─────────────────────────────────────────────────

export async function criarBloqueio(payload, user) {
    const settings = await getSettings();
    if (!await isGestor(user, settings)) throw erro('Só o gestor da frota pode bloquear o veículo.', 403);

    const veiculo = await db.Vehicle.findByPk(payload.vehicle_id);
    if (!veiculo) throw erro('Veículo não encontrado.', 404);

    const { inicio, fim } = resolverJanela(payload, settings);
    if (fim <= inicio) throw erro('O fim do bloqueio precisa ser depois do início.');

    // Reserva que cai dentro do bloqueio NÃO é apagada calada: o gestor vê
    // quem vai ser afetado e a pessoa recebe aviso nominal.
    const afetadas = await db.VehicleReservation.findAll({
        where: {
            vehicle_id: veiculo.id, status: { [Op.in]: OCUPAM },
            inicio: { [Op.lt]: fim }, fim: { [Op.gt]: inicio },
        },
        include: [{ model: db.User, as: 'condutor', attributes: ['id', 'username', 'email'], required: false }],
    });
    const emUso = afetadas.find(r => r.status === 'em_uso');
    if (emUso) throw erro(`O veículo está em uso por ${nomeDe(emUso.condutor)}. Registre a devolução antes de bloquear.`, 409);

    const bloqueio = await db.VehicleBlock.create({
        vehicle_id: veiculo.id,
        inicio,
        fim,
        tipo: payload.tipo === 'indisponivel' ? 'indisponivel' : 'manutencao',
        motivo: payload.motivo || null,
        observacao: payload.observacao || null,
        created_by_user_id: user.id,
    });

    for (const reserva of afetadas) {
        await reserva.update({
            status: 'cancelada',
            cancelado_em: new Date(),
            cancelado_por_user_id: user.id,
            motivo_cancelamento: `Veículo bloqueado: ${bloqueio.motivo || bloqueio.tipo}`,
        });
        await fleetCalendarService.removerEvento(reserva).catch(() => {});
        await notificar({
            type: NotificationType.FLEET_RESERVATION_CANCELLED,
            users: [reserva.user_id],
            title: 'Veículo indisponível: sua reserva foi cancelada',
            body: `${nomeDe(user)} bloqueou o veículo (${bloqueio.motivo || bloqueio.tipo}) e sua reserva de ${formatarJanela(reserva)} foi cancelada.`,
            data: { reservationId: reserva.id },
        });
    }

    await fleetCalendarService.sincronizarBloqueio(bloqueio.id).catch(() => {});

    return { bloqueio, canceladas: afetadas.length };
}

export async function removerBloqueio(id, user) {
    const settings = await getSettings();
    if (!await isGestor(user, settings)) throw erro('Só o gestor da frota pode remover o bloqueio.', 403);
    const bloqueio = await db.VehicleBlock.findByPk(id);
    if (!bloqueio) throw erro('Bloqueio não encontrado.', 404);
    await fleetCalendarService.removerEvento(bloqueio).catch(() => {});
    await bloqueio.destroy();
    return { ok: true };
}

// ── Avisos ────────────────────────────────────────────────────────────────

function formatarJanela(reserva) {
    const fmt = new Intl.DateTimeFormat('pt-BR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
    });
    return `${fmt.format(reserva.inicio)} até ${fmt.format(reserva.fim)}`;
}

async function notificar({ type, users, title, body, data = {} }) {
    const alvos = [...new Set((users || []).map(Number).filter(Boolean))];
    if (!alvos.length) return;
    try {
        await NotificationService.notify({
            type,
            recipients: { users: alvos },
            title,
            body,
            data,
            link: '/frota',
        });
    } catch (err) {
        // Aviso que falha não pode derrubar a reserva que já foi gravada.
        console.warn(`[Frota] Falha ao notificar (${type}): ${err.message}`);
    }
}

async function avisarReservaCriada(reserva, veiculo, autor) {
    if (Number(reserva.user_id) === Number(autor.id)) return;
    await notificar({
        type: NotificationType.FLEET_RESERVATION_CREATED,
        users: [reserva.user_id],
        title: 'Reservaram o veículo em seu nome',
        body: `${nomeDe(autor)} reservou ${veiculo.apelido || veiculo.modelo} para você: ${formatarJanela(reserva)}.`,
        data: { reservationId: reserva.id },
    });
}

async function avisarRetirada(reserva, user) {
    await notificarWebhookTeams(`🚗 ${nomeDe(user)} retirou o veículo. Previsão de devolução: ${formatarJanela(reserva).split(' até ')[1]}.`);
}

async function avisarDevolucao(reserva, user) {
    await notificarWebhookTeams(`🔑 ${nomeDe(user)} devolveu o veículo. O carro está livre.`);
}

/**
 * O grupo do Teams continua recebendo aviso. Webhook de canal funciona sem
 * permissão do Graph - o app lê todo o Teams da empresa e não consegue
 * escrever nada, então este é o único caminho disponível hoje.
 */
export async function notificarWebhookTeams(texto) {
    try {
        const cfg = await getSettings();
        if (!cfg.teams_webhook_ativo || !cfg.teams_webhook_url) return;
        await fetch(cfg.teams_webhook_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: texto }),
        });
    } catch (err) {
        console.warn(`[Frota] Webhook do Teams falhou: ${err.message}`);
    }
}

// ── Rotina ────────────────────────────────────────────────────────────────

/**
 * Reserva que ninguém retirou libera a janela. É o que impede a agenda de
 * virar ficção: sem isto, meia dúzia de reservas fantasma bloqueiam o carro e
 * todo mundo volta a combinar pelo Teams.
 */
export async function expirarNaoRetiradas() {
    const settings = await getSettings();
    const limite = new Date(Date.now() - settings.horas_expirar_sem_retirada * 3600000);

    const vencidas = await db.VehicleReservation.findAll({
        where: { status: 'reservada', inicio: { [Op.lt]: limite } },
        include: [{ model: db.Vehicle, as: 'veiculo', required: false }],
    });

    for (const reserva of vencidas) {
        await reserva.update({ status: 'expirada' });
        await fleetCalendarService.removerEvento(reserva).catch(() => {});
        await notificar({
            type: NotificationType.FLEET_RESERVATION_EXPIRED,
            users: [reserva.user_id],
            title: 'Sua reserva do veículo expirou',
            body: `A retirada não foi registrada em até ${settings.horas_expirar_sem_retirada}h do início (${formatarJanela(reserva)}), então o período foi liberado para outras pessoas.`,
            data: { reservationId: reserva.id },
        });
    }

    return vencidas.length;
}

/** Passou da hora de devolver e o carro não voltou. */
export async function avisarAtrasos() {
    const agora = new Date();
    const atrasadas = await db.VehicleReservation.findAll({
        where: { status: 'em_uso', fim: { [Op.lt]: agora } },
    });

    let avisados = 0;
    for (const reserva of atrasadas) {
        // Uma cobrança por hora seria perseguição; o aviso sai uma vez só, na
        // primeira passada depois do horário.
        if (reserva.atraso_avisado_em) continue;
        await notificar({
            type: NotificationType.FLEET_RETURN_OVERDUE,
            users: [reserva.user_id],
            title: 'Devolução do veículo em atraso',
            body: `A devolução estava prevista para ${formatarJanela(reserva).split(' até ')[1]}. Registre a devolução ou avise quem está esperando.`,
            data: { reservationId: reserva.id },
        });
        await reserva.update({ atraso_avisado_em: agora });
        avisados++;
    }
    return avisados;
}

/** Lembrete da retirada, na véspera. */
export async function lembrarRetiradas() {
    const settings = await getSettings();
    if (!settings.lembrete_retirada_horas) return 0;

    const agora = new Date();
    const ate = new Date(agora.getTime() + settings.lembrete_retirada_horas * 3600000);

    const proximas = await db.VehicleReservation.findAll({
        where: { status: 'reservada', inicio: { [Op.gt]: agora, [Op.lte]: ate } },
        include: [{ model: db.Vehicle, as: 'veiculo', required: false }],
    });

    let avisados = 0;
    for (const reserva of proximas) {
        if (reserva.lembrete_enviado_em) continue;
        await notificar({
            type: NotificationType.FLEET_PICKUP_REMINDER,
            users: [reserva.user_id],
            title: 'Você reservou o veículo',
            body: `Sua reserva começa em ${formatarJanela(reserva).split(' até ')[0]}${reserva.destino ? ` (${reserva.destino})` : ''}. Registre a retirada ao pegar a chave.`,
            data: { reservationId: reserva.id },
        });
        await reserva.update({ lembrete_enviado_em: new Date() });
        avisados++;
    }
    return avisados;
}

export default {
    getSettings, saveSettings, isGestor, listarVeiculos, agenda, estadoDoVeiculo,
    conflitos, criarReserva, cancelarReserva, retirar, devolver, criarBloqueio,
    removerBloqueio, carregarReserva, podeMexer, usuariosDaAlcada,
    expirarNaoRetiradas, avisarAtrasos, lembrarRetiradas, resolverJanela, montarData,
};
