// api/models/buildingModel.js
const Building = {
    addBuilding: async (db, { title, description, buildingDate, tags, images, address, created_by }) => {
        console.log('Tags:', JSON.stringify(tags)); // Confirma a conversão
        console.log('Images:', JSON.stringify(images)); // Confirma a conversão
        console.log('Address:', JSON.stringify(address)); // Confirma a conversão
        const sql = `INSERT INTO buildings (title, description, building_date, tags, images, address, created_by)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`;
        const [result] = await db.execute(sql, [
            title,
            description,
            buildingDate,
            JSON.stringify(tags),
            JSON.stringify(images),
            JSON.stringify(address),
            created_by
        ]);
        return result;
    },

    getBuildings: async (db) => {
        const sql = `SELECT id, title, description, post_date, building_date, tags, images, address, created_by FROM buildings ORDER BY building_date ASC`;
        const [rows] = await db.execute(sql);

        return rows.map(building => ({
            ...building,
            tags: typeof building.tags === 'string' ? JSON.parse(building.tags) : building.tags,
            images: typeof building.images === 'string' ? JSON.parse(building.images) : building.images,
            address: typeof building.address === 'string' ? JSON.parse(building.address) : building.address
        }));
    },

    updateBuilding: async (db, id, { title, description, buildingDate, tags, images, address }) => {
        const sql = `UPDATE buildings 
                     SET title = ?, description = ?, building_date = ?, tags = ?, images = ?, address = ? 
                     WHERE id = ?`;
        const [result] = await db.execute(sql, [
            title,
            description,
            buildingDate,
            JSON.stringify(tags),
            JSON.stringify(images),
            JSON.stringify(address), 
            id
        ]);
        return result;
    },

    deleteBuilding: async (db, id) => {
        const sql = `DELETE FROM buildings WHERE id = ?`;
        const [result] = await db.execute(sql, [id]);
        return result;
    }

};

export default Building;
