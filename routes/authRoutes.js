import express from 'express';
import {
  registerUser,
  loginUser,
  changePassword,
  requestPasswordReset,
  resetPassword,
  enrollFace,
  identifyFace,
  getUserInfo,
  updateMe,
  updateUser,
  getAllUsers,
  getUserById,
  getSiengeCredentials,
  saveSiengeCredentials,
  adminResetUserPassword,
  refreshSession,
  logoutSession,
} from '../controllers/authController.js';
import { getSignupOptions, completeSignup, requestSignup, activateUser, rejectUser } from '../controllers/signupController.js';
import authenticate from '../middlewares/authMiddleware.js';
import { authorizeByRole } from '../middlewares/permissionMiddleware.js';
import { loginLimiter, passwordResetLimiter } from '../middlewares/rateLimiters.js';

const router = express.Router();

router.post('/register', authenticate, authorizeByRole(['admin']), registerUser);
router.post('/login', loginLimiter, loginUser);

// Sessão: refresh rotaciona o par de tokens; logout revoga o refresh token.
// Ambas públicas — o access token pode já estar expirado.
router.post('/refresh', refreshSession);
router.post('/logout', logoutSession);

router.post('/forgot-password/request', passwordResetLimiter, requestPasswordReset);
router.post('/forgot-password/reset', passwordResetLimiter, resetPassword);
router.put('/user/password', authenticate, changePassword);

router.get('/user', authenticate, getUserInfo);
router.put('/user', authenticate, updateMe);

// ── Cadastro de primeiro acesso ──────────────────────────────────────────────
// signup-options é PÚBLICA (o "Solicite acesso" da tela de login usa sem
// sessão; só devolve nomes de departamentos e cidades ativas).
router.get('/signup-options', getSignupOptions);
// complete-signup: usuário Microsoft não-aprovado (liberada no PENDING_ALLOWED).
router.post('/complete-signup', authenticate, completeSignup);
// signup-request: pública ("Solicite acesso" sem Microsoft), com rate limit.
router.post('/signup-request', loginLimiter, requestSignup);

// ── Credenciais Sienge — deve vir ANTES de /user/:id para evitar conflito de rota
router.get('/user/sienge-credentials', authenticate, getSiengeCredentials);
router.put('/user/sienge-credentials', authenticate, saveSiengeCredentials);

router.get('/user/:id', authenticate, authorizeByRole(['admin']), getUserById);
router.get('/users', authenticate, authorizeByRole(['admin']), getAllUsers);
router.put('/users', authenticate, authorizeByRole(['admin']), updateUser);
router.post('/users/:id/reset-password', authenticate, authorizeByRole(['admin']), adminResetUserPassword);
// Ativação de cadastro pendente: aplica alçadas padrão do departamento, gera
// senha provisória e envia o e-mail de liberação. Reprovação avisa por e-mail.
router.post('/users/:id/activate', authenticate, authorizeByRole(['admin']), activateUser);
router.post('/users/:id/reject', authenticate, authorizeByRole(['admin']), rejectUser);
router.post('/face/enroll', authenticate, enrollFace);
router.post('/face/identify', loginLimiter, identifyFace);

export default router;