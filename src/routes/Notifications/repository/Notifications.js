const pool = require("../../../database/db");

// Criar notificação
async function createNotification(req, res) {
  try {
    const {
      userId,
      type,
      serviceRequestId,
      fromUserId,
      fromUserName,
      fromUserCity,
      description,
      proposalPrice,
      clientZipCode,
      clientNeighborhood,
      clientStreet,
      clientNumber,
      clientComplement,
      clientReference,
    } = req.body;

    const result = await pool.query(
      `INSERT INTO notifications (
        user_id,
        type,
        service_request_id,
        from_user_id,
        from_user_name,
        from_user_city,
        description,
        proposal_price,
        client_zip_code,
        client_neighborhood,
        client_street,
        client_number,
        client_complement,
        client_reference,
        created_at
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
       RETURNING *`,
      [
        userId,
        type,
        serviceRequestId,
        fromUserId,
        fromUserName,
        fromUserCity,
        description,
        proposalPrice,
        clientZipCode,
        clientNeighborhood,
        clientStreet,
        clientNumber,
        clientComplement,
        clientReference,
      ],
    );

    console.log("[NOTIFICATION] Criada:", result.rows[0]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("[NOTIFICATION] Erro ao criar:", error);
    res.status(500).json({ error: "Erro ao criar notificação" });
  }
}

// Buscar notificações do usuário
async function getUserNotifications(req, res) {
  try {
    const userId = req.user.id;

    // Limpar notificações com mais de 7 dias
    await pool.query(
      `DELETE FROM notifications WHERE user_id = $1 AND created_at < NOW() - INTERVAL '7 days'`,
      [userId],
    );

    await pool.query(
      `WITH ranked AS (
         SELECT
           id,
           ROW_NUMBER() OVER (
             PARTITION BY user_id, type, COALESCE(service_request_id, -1), COALESCE(from_user_id, -1)
             ORDER BY created_at DESC, id DESC
           ) AS rn
         FROM notifications
         WHERE user_id = $1
       )
       DELETE FROM notifications n
       USING ranked r
       WHERE n.id = r.id
         AND r.rn > 1`,
      [userId],
    );

    const result = await pool.query(
      `SELECT
         n.*,
         u.profile_color AS from_user_profile_color,
         sr.status AS request_status,
         sr.proposed_duration_minutes
       FROM notifications n
       LEFT JOIN users u ON u.id = n.from_user_id
       LEFT JOIN service_requests sr ON sr.id = n.service_request_id
       WHERE n.user_id = $1
       ORDER BY n.created_at DESC, n.id DESC`,
      [userId],
    );

    console.log(
      "[NOTIFICATION] Notificações do usuário",
      userId,
      ":",
      result.rows.length,
    );
    res.json(result.rows);
  } catch (error) {
    console.error("[NOTIFICATION] Erro ao buscar:", error);
    res.status(500).json({ error: "Erro ao buscar notificações" });
  }
}

// Marcar notificação como lida
async function markAsRead(req, res) {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE notifications SET read = true WHERE id = $1 RETURNING *`,
      [id],
    );

    console.log("[NOTIFICATION] Marcada como lida:", id);
    res.json(result.rows[0]);
  } catch (error) {
    console.error("[NOTIFICATION] Erro ao marcar como lida:", error);
    res.status(500).json({ error: "Erro ao marcar notificação como lida" });
  }
}

// Deletar notificação
async function deleteNotification(req, res) {
  try {
    const { id } = req.params;

    await pool.query(`DELETE FROM notifications WHERE id = $1`, [id]);

    console.log("[NOTIFICATION] Deletada:", id);
    res.json({ success: true });
  } catch (error) {
    console.error("[NOTIFICATION] Erro ao deletar:", error);
    res.status(500).json({ error: "Erro ao deletar notificação" });
  }
}

module.exports = {
  createNotification,
  getUserNotifications,
  markAsRead,
  deleteNotification,
};
