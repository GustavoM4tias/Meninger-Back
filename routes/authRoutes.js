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
} from '../controllers/authController.js';
import authenticate from '../middlewares/authMiddleware.js';
import { authorizeByRole } from '../middlewares/permissionMiddleware.js';

const router = express.Router();

router.post('/register', authenticate, authorizeByRole(['admin']), registerUser);
router.post('/login', loginUser);

router.post('/forgot-password/request', requestPasswordReset);
router.post('/forgot-password/reset', resetPassword);
router.put('/user/password', authenticate, changePassword);

router.get('/user', authenticate, getUserInfo);
router.put('/user', authenticate, updateMe);
router.get('/user/:id', authenticate, authorizeByRole(['admin']), getUserById);
router.get('/users', authenticate, authorizeByRole(['admin']), getAllUsers);
router.put('/users', authenticate, authorizeByRole(['admin']), updateUser);
router.post('/face/enroll', authenticate, enrollFace);
router.post('/face/identify', identifyFace);

export default router;