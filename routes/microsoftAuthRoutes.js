import express from 'express';
import {
    loginMicrosoft,
    callbackMicrosoft,
    getMicrosoftMe
} from '../controllers/microsoft/microsoftController.js';

const router = express.Router();

router.get('/auth/login', loginMicrosoft);
router.get('/auth/callback', callbackMicrosoft);
router.get('/auth/me', getMicrosoftMe);

export default router;
