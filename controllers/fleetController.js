// controllers/fleetController.js
//
// A API da tela do veículo corporativo. Toda regra vive no fleetService; aqui
// só entram tradução de HTTP e o status certo do erro - 409 quando é choque de
// agenda, para a tela saber a diferença entre "você errou o formulário" e "o
// carro já está com alguém".
import db from '../models/sequelize/index.js';
import responseHandler from '../utils/responseHandler.js';
import fleetService from '../services/fleet/fleetService.js';
import fleetCalendarService from '../services/fleet/fleetCalendarService.js';
import fleetPhotoService from '../services/fleet/fleetPhotoService.js';
import { lerOdometro } from '../services/fleet/fleetOdometerService.js';

function responder(res, err) {
    const status = err?.status || 500;
    // Mensagem de erro de regra é deliberada e pode ir ao usuário; o resto o
    // responseHandler troca por genérico sozinho.
    return responseHandler.error(res, status >= 500 ? err : err.message, status);
}

const fleetController = {

    /** Tudo que a tela precisa para abrir: veículos, estado, config e alçada. */
    async overview(req, res) {
        try {
            const [veiculos, settings] = await Promise.all([
                // Só os ativos: veículo desativado não pode aparecer no seletor
                // de quem vai reservar. O admin vê a lista completa em
                // GET /vehicles, que é a tela de cadastro.
                fleetService.listarVeiculos({ apenasAtivos: true }),
                fleetService.getSettings(),
            ]);
            const gestor = await fleetService.isGestor(req.user, settings);

            return responseHandler.success(res, {
                veiculos,
                gestor,
                config: {
                    departamentos: settings.departamentos,
                    horas_expirar_sem_retirada: settings.horas_expirar_sem_retirada,
                    max_dias_reserva: settings.max_dias_reserva,
                    antecedencia_max_dias: settings.antecedencia_max_dias,
                    exigir_km: settings.exigir_km,
                    exigir_combustivel: settings.exigir_combustivel,
                    exigir_destino: settings.exigir_destino,
                    exigir_face: settings.exigir_face,
                    min_fotos_saida: settings.min_fotos_saida,
                    min_fotos_chegada: settings.min_fotos_chegada,
                    km_max_por_dia: settings.km_max_por_dia,
                    hora_inicio_manha: settings.hora_inicio_manha,
                    hora_fim_manha: settings.hora_fim_manha,
                    hora_inicio_tarde: settings.hora_inicio_tarde,
                    hora_fim_tarde: settings.hora_fim_tarde,
                },
            });
        } catch (err) { return responder(res, err); }
    },

    /** Agenda de uma janela. A tela pede 14 dias e recorta no cliente. */
    async agenda(req, res) {
        try {
            const de = req.query.de ? new Date(req.query.de) : new Date();
            const ate = req.query.ate
                ? new Date(req.query.ate)
                : new Date(Date.now() + 30 * 86400000);
            if (Number.isNaN(de.getTime()) || Number.isNaN(ate.getTime())) {
                return responseHandler.error(res, 'Período inválido.', 400);
            }

            const vehicleId = req.query.vehicle_id ? Number(req.query.vehicle_id) : null;
            const dados = await fleetService.agenda({ vehicleId, de, ate });
            return responseHandler.success(res, dados);
        } catch (err) { return responder(res, err); }
    },

    /** Minhas reservas: o que eu tenho para retirar, devolver ou cancelar. */
    async minhasReservas(req, res) {
        try {
            const reservas = await db.VehicleReservation.findAll({
                where: { user_id: req.user.id },
                include: [{ model: db.Vehicle, as: 'veiculo', required: false }],
                order: [['inicio', 'DESC']],
                limit: 50,
            });
            return responseHandler.success(res, reservas);
        } catch (err) { return responder(res, err); }
    },

    /** Consulta de disponibilidade ANTES de mandar o formulário. */
    async verificar(req, res) {
        try {
            const settings = await fleetService.getSettings();
            const { inicio, fim } = fleetService.resolverJanela(req.body, settings);
            const choque = await fleetService.conflitos(Number(req.body.vehicle_id), inicio, fim, {
                ignorarReservaId: req.body.ignorar_reserva_id ? Number(req.body.ignorar_reserva_id) : null,
            });
            return responseHandler.success(res, {
                livre: choque.livre,
                inicio,
                fim,
                reservas: choque.reservas,
                bloqueios: choque.bloqueios,
            });
        } catch (err) { return responder(res, err); }
    },

    async criarReserva(req, res) {
        try {
            const reserva = await fleetService.criarReserva(req.body, req.user);
            return responseHandler.success(res, reserva);
        } catch (err) { return responder(res, err); }
    },

    async cancelarReserva(req, res) {
        try {
            const reserva = await fleetService.cancelarReserva(Number(req.params.id), req.user, req.body?.motivo);
            return responseHandler.success(res, reserva);
        } catch (err) { return responder(res, err); }
    },

    async retirar(req, res) {
        try {
            const reserva = await fleetService.retirar(Number(req.params.id), req.body, req.user);
            return responseHandler.success(res, reserva);
        } catch (err) { return responder(res, err); }
    },

    async devolver(req, res) {
        try {
            const reserva = await fleetService.devolver(Number(req.params.id), req.body, req.user);
            return responseHandler.success(res, reserva);
        } catch (err) { return responder(res, err); }
    },

    /**
     * Retirada sem reserva prévia: a pessoa está na frente do carro e vai sair
     * agora. Sem isso, o módulo obrigaria a fingir uma reserva antes de cada
     * saída de última hora - e é exatamente aí que a operação abandona o
     * sistema e volta para o grupo do Teams.
     */
    async retiradaDireta(req, res) {
        try {
            const agora = new Date();
            const fim = req.body.fim_previsto ? new Date(req.body.fim_previsto) : null;
            if (!fim || Number.isNaN(fim.getTime())) {
                return responseHandler.error(res, 'Informe a previsão de devolução.', 400);
            }
            if (fim <= agora) {
                return responseHandler.error(res, 'A previsão de devolução precisa ser no futuro.', 400);
            }

            const choque = await fleetService.conflitos(Number(req.body.vehicle_id), agora, fim);

            // A reserva que atrapalha pode ser a SUA. Antes isto devolvia
            // "já reservado por Fulano" com o Fulano sendo a própria pessoa -
            // ela tinha feito tudo certo (reservou e foi pegar) e o sistema
            // dizia não. Agora a retirada acontece EM CIMA da própria reserva,
            // que é o que ela queria dizer com "vou pegar agora".
            const minha = choque.reservas.find(r =>
                Number(r.user_id) === Number(req.user.id) && r.status === 'reservada');
            if (minha) {
                const comRetirada = await fleetService.retirar(minha.id, req.body, req.user);
                return responseHandler.success(res, comRetirada);
            }

            if (!choque.livre) {
                const dono = choque.reservas[0];
                const mensagem = dono
                    ? `O veículo já está reservado por ${dono.condutor?.username || 'outra pessoa'} nesse horário. Escolha outro horário de devolução ou fale com quem reservou.`
                    : 'O veículo está indisponível nesse período (manutenção).';
                return responseHandler.error(res, mensagem, 409);
            }

            const reserva = await db.VehicleReservation.create({
                vehicle_id: Number(req.body.vehicle_id),
                user_id: req.user.id,
                created_by_user_id: req.user.id,
                departamento: req.body.departamento || null,
                inicio: agora,
                fim,
                periodo: 'personalizado',
                destino: req.body.destino || null,
                solicitado_por: req.body.solicitado_por || null,
                observacao: req.body.observacao || null,
                status: 'reservada',
            });

            // Duas escritas, um gesto só: se a saída for recusada, a reserva
            // recém-criada tem que sumir junto. Sem isto ela ficava no banco
            // ocupando a agenda, e a segunda tentativa da MESMA pessoa batia
            // no próprio resto da primeira ("já reservado por você").
            try {
                const comRetirada = await fleetService.retirar(reserva.id, req.body, req.user);
                return responseHandler.success(res, comRetirada);
            } catch (falha) {
                await reserva.destroy().catch(() => {});
                throw falha;
            }
        } catch (err) { return responder(res, err); }
    },

    // ── Gestor da frota ───────────────────────────────────────────────────

    async criarBloqueio(req, res) {
        try {
            const resultado = await fleetService.criarBloqueio(req.body, req.user);
            return responseHandler.success(res, resultado);
        } catch (err) { return responder(res, err); }
    },

    async removerBloqueio(req, res) {
        try {
            const resultado = await fleetService.removerBloqueio(Number(req.params.id), req.user);
            return responseHandler.success(res, resultado);
        } catch (err) { return responder(res, err); }
    },

    /** Diário de bordo do veículo: abastecimento, avaria, multa, manutenção. */
    async listarRegistros(req, res) {
        try {
            const registros = await db.VehicleLog.findAll({
                where: { vehicle_id: Number(req.params.id) },
                include: [{ model: db.User, as: 'autor', attributes: ['id', 'username'], required: false }],
                order: [['ocorrido_em', 'DESC'], ['id', 'DESC']],
                limit: 200,
            });
            return responseHandler.success(res, registros);
        } catch (err) { return responder(res, err); }
    },

    async criarRegistro(req, res) {
        try {
            const tipos = ['abastecimento', 'avaria', 'multa', 'manutencao', 'observacao'];
            if (!tipos.includes(req.body.tipo)) {
                return responseHandler.error(res, `Tipo inválido (use: ${tipos.join(', ')}).`, 400);
            }
            const registro = await db.VehicleLog.create({
                vehicle_id: Number(req.params.id),
                reservation_id: req.body.reservation_id || null,
                tipo: req.body.tipo,
                descricao: req.body.descricao || null,
                valor: req.body.valor ?? null,
                litros: req.body.litros ?? null,
                km: req.body.km ?? null,
                ocorrido_em: req.body.ocorrido_em || new Date(),
                anexo_url: req.body.anexo_url || null,
                created_by_user_id: req.user.id,
            });
            return responseHandler.success(res, registro);
        } catch (err) { return responder(res, err); }
    },

    // ── Configuração (admin) ──────────────────────────────────────────────

    async getSettings(req, res) {
        try {
            return responseHandler.success(res, await fleetService.getSettings());
        } catch (err) { return responder(res, err); }
    },

    async saveSettings(req, res) {
        try {
            return responseHandler.success(res, await fleetService.saveSettings(req.body));
        } catch (err) { return responder(res, err); }
    },

    /**
     * Lista enxuta para escolher o gestor da frota. Existe aqui em vez de
     * reusar /auth/users porque aquela rota devolve o cadastro inteiro de todo
     * mundo (gerente, subordinados, telefone, face) para preencher um seletor
     * de dois campos.
     */
    async listarUsuarios(req, res) {
        try {
            const usuarios = await db.User.findAll({
                where: { status: true, approval_status: 'approved' },
                attributes: ['id', 'username', 'email'],
                order: [['username', 'ASC']],
                raw: true,
            });
            return responseHandler.success(res, usuarios);
        } catch (err) { return responder(res, err); }
    },

    /**
     * Sobe UMA foto e devolve a URL. A tela chama isto enquanto a pessoa tira
     * as fotos, e só manda as URLs no formulário de retirada/devolução.
     *
     * Por que separado do formulário: assim a pessoa vê a foto subir na hora e
     * não descobre no fim que a conexão do estacionamento não deu conta. O
     * preço é a foto órfã quando alguém desiste no meio - lixo barato no
     * bucket, e nunca um formulário perdido.
     */
    async subirFoto(req, res) {
        try {
            const { base64, mime_type, vehicle_id, reservation_id, momento, indice } = req.body;
            if (!vehicle_id) return responseHandler.error(res, 'Veículo não informado.', 400);
            if (!['saida', 'chegada'].includes(momento)) {
                return responseHandler.error(res, 'Momento inválido.', 400);
            }

            const foto = await fleetPhotoService.subirFoto({
                base64,
                mimeType: mime_type,
                vehicleId: Number(vehicle_id),
                // Sem reserva ainda (retirada direta): a foto vai para uma
                // pasta "avulsa" do próprio veículo.
                reservationId: reservation_id ? Number(reservation_id) : 'avulsa',
                momento,
                indice: Number(indice) || 0,
            });
            return responseHandler.success(res, foto);
        } catch (err) { return responder(res, err); }
    },

    /**
     * Lê o odômetro numa foto do painel. Devolve SUGESTÃO: a tela preenche o
     * campo e a pessoa confirma. Falha aqui nunca trava a retirada - sem
     * leitura, digita-se o número.
     */
    async lerOdometro(req, res) {
        try {
            const r = await lerOdometro({ base64: req.body.base64, mimeType: req.body.mime_type });
            return responseHandler.success(res, r);
        } catch (err) { return responder(res, err); }
    },

    async listarVeiculosAdmin(req, res) {
        try {
            const veiculos = await db.Vehicle.findAll({ order: [['id', 'ASC']] });
            return responseHandler.success(res, veiculos);
        } catch (err) { return responder(res, err); }
    },

    async salvarVeiculo(req, res) {
        try {
            const dados = {
                placa: String(req.body.placa || '').toUpperCase().trim(),
                modelo: req.body.modelo,
                apelido: req.body.apelido || null,
                cor: req.body.cor || null,
                ano: req.body.ano || null,
                tipo: req.body.tipo === 'reserva' ? 'reserva' : 'proprio',
                km_atual: req.body.km_atual ?? null,
                observacao: req.body.observacao || null,
                ativo: req.body.ativo !== false,
            };
            if (!dados.placa || !dados.modelo) {
                return responseHandler.error(res, 'Placa e modelo são obrigatórios.', 400);
            }

            if (req.params.id) {
                const veiculo = await db.Vehicle.findByPk(Number(req.params.id));
                if (!veiculo) return responseHandler.error(res, 'Veículo não encontrado.', 404);
                await veiculo.update(dados);
                return responseHandler.success(res, veiculo);
            }

            const criado = await db.Vehicle.create(dados);
            return responseHandler.success(res, criado);
        } catch (err) {
            if (err?.name === 'SequelizeUniqueConstraintError') {
                return responseHandler.error(res, 'Já existe um veículo com essa placa.', 409);
            }
            return responder(res, err);
        }
    },

    /**
     * Reenvia o evento ao calendário. Existe porque o Graph pode estar fora do
     * ar na hora da reserva, e sem isto a única saída seria cancelar e refazer.
     */
    async ressincronizarEvento(req, res) {
        try {
            const evento = await fleetCalendarService.sincronizarEvento(Number(req.params.id));
            const reserva = await fleetService.carregarReserva(Number(req.params.id));
            return responseHandler.success(res, { ok: Boolean(evento), reserva });
        } catch (err) { return responder(res, err); }
    },
};

export default fleetController;
