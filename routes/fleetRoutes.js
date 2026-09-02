// routes/fleetRoutes.js
// Frota — veículo corporativo. Uma linha por AÇÃO, com a regra em
// lib/screenCapabilities.js (a mesma que a tela consulta):
//   view      → ver agenda e estado
//   reservar  → reservar, retirar, devolver, cancelar a própria reserva
//   configurar → cadastro de veículo e configuração (admin)
//
// Bloqueio de manutenção e cancelamento da reserva de terceiro passam por
// 'reservar' na porta e pelo gestor da frota DENTRO do serviço: quem decide
// isso é papel do módulo, não alçada.
import express from 'express';
import fleetController from '../controllers/fleetController.js';
import authenticate from '../middlewares/authMiddleware.js';
import requireInternal from '../middlewares/requireInternal.js';
import requireCapability from '../middlewares/requireCapability.js';

const router = express.Router();

const TELA = '/frota';
const ver = [authenticate, requireInternal, requireCapability(TELA, 'view')];
const usar = [authenticate, requireInternal, requireCapability(TELA, 'reservar')];
const configurar = [authenticate, requireInternal, requireCapability(TELA, 'configurar')];

// ───────────── Leitura ─────────────
router.get('/overview', ...ver, fleetController.overview);
router.get('/agenda', ...ver, fleetController.agenda);
router.get('/minhas-reservas', ...ver, fleetController.minhasReservas);
router.post('/verificar', ...ver, fleetController.verificar);
router.get('/vehicles/:id(\\d+)/logs', ...ver, fleetController.listarRegistros);

// ───────────── Uso do veículo ─────────────
router.post('/reservations', ...usar, fleetController.criarReserva);
router.post('/reservations/:id(\\d+)/cancel', ...usar, fleetController.cancelarReserva);
router.post('/reservations/:id(\\d+)/pickup', ...usar, fleetController.retirar);
router.post('/reservations/:id(\\d+)/return', ...usar, fleetController.devolver);
router.post('/reservations/:id(\\d+)/resync-event', ...usar, fleetController.ressincronizarEvento);
router.post('/pickup-now', ...usar, fleetController.retiradaDireta);
router.post('/vehicles/:id(\\d+)/logs', ...usar, fleetController.criarRegistro);

// Foto do estado do veículo e leitura do odômetro pela foto do painel: são
// passos da própria retirada/devolução, então seguem a mesma capacidade.
router.post('/photos', ...usar, fleetController.subirFoto);
router.post('/odometer/read', ...usar, fleetController.lerOdometro);

// ───────────── Gestor da frota (o serviço confere o papel) ─────────────
router.post('/blocks', ...usar, fleetController.criarBloqueio);
router.delete('/blocks/:id(\\d+)', ...usar, fleetController.removerBloqueio);

// ───────────── Configuração ─────────────
router.get('/settings', ...configurar, fleetController.getSettings);
router.put('/settings', ...configurar, fleetController.saveSettings);
router.get('/users', ...configurar, fleetController.listarUsuarios);
router.get('/vehicles', ...configurar, fleetController.listarVeiculosAdmin);
router.post('/vehicles', ...configurar, fleetController.salvarVeiculo);
router.put('/vehicles/:id(\\d+)', ...configurar, fleetController.salvarVeiculo);

export default router;
