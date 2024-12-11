// api/controllers/eventController.js
import Event from '../models/eventModel.js';
import responseHandler from '../utils/responseHandler.js';
import { sendEmailWithTemplate } from '../utils/emailService.js';

export const addEvent = async (req, res) => {
    const { title, description, eventDate, tags, images, address, created_by, notification } = req.body;

    try {
        const newEvent = await Event.addEvent(req.db, {
            title,
            description,
            eventDate,
            tags: tags || [], // Array de tags (adjetivos)
            images: images || [], // Array de URLs de imagens
            address: address || [], // Array de endereco
            created_by
        });
        responseHandler.success(res, { message: 'Evento criado com sucesso', eventId: newEvent.insertId });

        if (notification) {
            try {
                await sendEmailWithTemplate(
                    'gustavodiniz200513@gmail.com', // E-mail do destinatário
                    'Novo Evento Criado', // Assunto do e-mail
                    './templates/emailEventTemplate.html', // Caminho para o template
                    { title, description, eventDate, tags, images, address, created_by }
                );
            } catch (emailError) {
                console.error('Erro ao enviar e-mail:', emailError.message);
            }
        }

    } catch (error) {
        responseHandler.error(res, error);
    }
};

export const getEvents = async (req, res) => {
    try {
        const events = await Event.getEvents(req.db);
        responseHandler.success(res, { events });
    } catch (error) {
        responseHandler.error(res, error);
    }
};

export const updateEvent = async (req, res) => {
    const { id } = req.params;
    const { title, description, eventDate, tags, images, address } = req.body;

    try {
        const result = await Event.updateEvent(req.db, id, { title, description, eventDate, tags, images, address });

        if (result.affectedRows === 0) {
            return responseHandler.error(res, 'Evento não encontrado');
        }

        responseHandler.success(res, 'Evento atualizado com sucesso');
    } catch (error) {
        responseHandler.error(res, error.message);
    }
};

export const deleteEvent = async (req, res) => {
    const { id } = req.params;

    try {
        const result = await Event.deleteEvent(req.db, id);

        if (result.affectedRows === 0) {
            return responseHandler.error(res, 'Evento não encontrado');
        }

        responseHandler.success(res, 'Evento excluído com sucesso');
    } catch (error) {
        responseHandler.error(res, error.message);
    }
};

