// services/microsoft/MicrosoftOrgUsersService.js
import graphService from './MicrosoftGraphService.js';
import db from '../../models/sequelize/index.js';

const SELECT_FIELDS = 'id,displayName,mail,userPrincipalName,mobilePhone,businessPhones,city';

class MicrosoftOrgUsersService {

    // Busca todos os usuários da organização com paginação automática
    async listOrgUsers(adminUser) {
        const users = [];
        let path = `/users?$select=${SELECT_FIELDS}&$top=999`;

        while (path) {
            const result = await graphService.get(adminUser, path);
            if (Array.isArray(result.value)) users.push(...result.value);

            const nextLink = result['@odata.nextLink'];
            path = nextLink
                ? nextLink.replace('https://graph.microsoft.com/v1.0', '')
                : null;
        }

        return users.map(u => this._normalize(u));
    }

    // Retorna lista de microsoft_ids já importados no sistema
    async getImportedIds() {
        const rows = await db.User.findAll({
            attributes: ['microsoft_id'],
            where: { microsoft_id: { [db.Sequelize.Op.ne]: null } },
            raw: true,
        });
        return new Set(rows.map(r => r.microsoft_id));
    }

    _normalize(msUser) {
        const email = msUser.mail || msUser.userPrincipalName || null;
        const phone =
            msUser.mobilePhone ||
            (Array.isArray(msUser.businessPhones) && msUser.businessPhones[0]) ||
            null;

        return {
            microsoft_id: msUser.id,
            name: msUser.displayName || null,
            email,
            phone: phone ? phone.replace(/\s+/g, '') : null,
            city: msUser.city || null,
        };
    }
}

export default new MicrosoftOrgUsersService();
