import express from 'express';
import upload from '../middlewares/uploadMiddleware.js';
import { uploadFile } from '../controllers/uploadController.js';
// import authenticate from '../middlewares/authenticate.js';

const router = express.Router();

router.post(
    '/',
    // authenticate,
    upload.single('file'),
    uploadFile
);

export default router;