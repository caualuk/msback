async function createService(req, res) {
  const { employee_id, service_name, price } = req.body;
  const client_id = req.user.id;

  try {
    const result = await pool.query(
      `INSERT INTO services (client_id, employee_id, service_name, price)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [client_id, employee_id, service_name, price]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Erro ao criar serviço" });
  }
}

async function startService(req, res) {
  const { serviceId } = req.params;
  const employeeId = req.user.id;

  try {
    await pool.query(
      `UPDATE services
       SET started_at = NOW()
       WHERE id = $1
       AND employee_id = $2
       AND started_at IS NULL`,
      [serviceId, employeeId]
    );

    res.json({ message: "Serviço iniciado" });
  } catch (err) {
    res.status(500).json({ error: "Erro ao iniciar serviço" });
  }
}

async function finishService(req, res) {
  const { serviceId } = req.params;
  const employeeId = req.user.id;

  try {
    await pool.query(
      `UPDATE services
       SET finished_at = NOW()
       WHERE id = $1
       AND employee_id = $2
       AND started_at IS NOT NULL
       AND finished_at IS NULL`,
      [serviceId, employeeId]
    );

    res.json({ message: "Serviço finalizado" });
  } catch (err) {
    res.status(500).json({ error: "Erro ao finalizar serviço" });
  }
}

async function updateServiceStatus(req, res) {
  const { id } = req.params;
  const { status } = req.body;

  const allowedStatus = ["PAID", "PENDING", "OVERDUE"];

  if (!allowedStatus.includes(status)) {
    return res.status(400).json({ error: "Status inválido" });
  }

  try {
    const service = await pool.query(
      "SELECT * FROM services WHERE id = $1",
      [id]
    );

    if (service.rowCount === 0) {
      return res.status(404).json({ error: "Serviço não encontrado" });
    }

    const paidAt = status === "PAID" ? new Date() : null;

    const updated = await pool.query(
      `UPDATE services
       SET status = $1,
           paid_at = $2
       WHERE id = $3
       RETURNING *`,
      [status, paidAt, id]
    );

    res.json(updated.rows[0]);

  } catch (err) {
    res.status(500).json({ error: "Erro ao atualizar status" });
  }
}

async function listServices(req, res) {
  const userId = req.user.id;
  const userRole = req.user.role;

  try {
    let result;

    if (userRole === "CLIENT") {
      result = await pool.query(
        `SELECT s.*, 
                u.name AS employee_name
         FROM services s
         JOIN users u ON u.id = s.employee_id
         WHERE s.client_id = $1
         ORDER BY s.created_at DESC`,
        [userId]
      );
    } else if (userRole === "EMPLOYEE") {
      result = await pool.query(
        `SELECT s.*, 
                u.name AS client_name
         FROM services s
         JOIN users u ON u.id = s.client_id
         WHERE s.employee_id = $1
         ORDER BY s.created_at DESC`,
        [userId]
      );
    }

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar serviços" });
  }
}

module.exports = {
  createService,
  startService,
  finishService,
  updateServiceStatus,
  listServices
};