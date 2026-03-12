const { randomUUID } = require("crypto");
const pool = require("../../../database/db");

let schemaReady = false;

async function ensurePaymentsTable() {
  if (schemaReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id UUID PRIMARY KEY,
      service_id BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      preference_id TEXT NOT NULL,
      payment_id TEXT UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'failed')),
      amount NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(service_id)
    );
  `);

  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_payments_preference_id ON payments(preference_id);",
  );

  schemaReady = true;
}

async function findServiceById(serviceId) {
  const result = await pool.query(
    `SELECT id, client_id, employee_id, description, value, status
     FROM services
     WHERE id = $1`,
    [serviceId],
  );

  return result.rows[0] || null;
}

async function upsertPendingPayment({ serviceId, preferenceId, amount }) {
  const id = randomUUID();

  const result = await pool.query(
    `INSERT INTO payments (id, service_id, preference_id, status, amount, updated_at)
     VALUES ($1, $2, $3, 'pending', $4, NOW())
     ON CONFLICT (service_id)
     DO UPDATE SET
       preference_id = EXCLUDED.preference_id,
       payment_id = NULL,
       status = 'pending',
       amount = EXCLUDED.amount,
       updated_at = NOW()
     RETURNING *`,
    [id, serviceId, preferenceId, amount],
  );

  return result.rows[0];
}

async function findPaymentByPaymentId(paymentId) {
  const result = await pool.query(
    `SELECT * FROM payments WHERE payment_id = $1 LIMIT 1`,
    [paymentId],
  );
  return result.rows[0] || null;
}

async function findPaymentByPreferenceId(preferenceId) {
  const result = await pool.query(
    `SELECT * FROM payments WHERE preference_id = $1 LIMIT 1`,
    [preferenceId],
  );
  return result.rows[0] || null;
}

async function findPaymentByServiceId(serviceId) {
  const result = await pool.query(
    `SELECT * FROM payments WHERE service_id = $1 LIMIT 1`,
    [serviceId],
  );
  return result.rows[0] || null;
}

async function markPaymentApproved({ paymentId, preferenceId }) {
  const result = await pool.query(
    `UPDATE payments
     SET payment_id = $1,
         status = 'approved',
         updated_at = NOW()
     WHERE preference_id = $2
     RETURNING *`,
    [paymentId, preferenceId],
  );

  return result.rows[0] || null;
}

async function markPaymentFailed({ paymentId, preferenceId }) {
  const result = await pool.query(
    `UPDATE payments
     SET payment_id = COALESCE(payment_id, $1),
         status = 'failed',
         updated_at = NOW()
     WHERE preference_id = $2
     RETURNING *`,
    [paymentId, preferenceId],
  );

  return result.rows[0] || null;
}

async function updateServiceStatus(serviceId, status) {
  const serviceResult = await pool.query(
    `SELECT id, client_id, employee_id, description, value, type
     FROM services
     WHERE id = $1
     LIMIT 1`,
    [serviceId],
  );

  const service = serviceResult.rows[0];
  if (!service) return;

  await pool.query(
    `UPDATE services
     SET status = $1
     WHERE client_id = $2
       AND employee_id = $3
       AND description = $4
       AND value = $5
       AND type = 'FECHADO'`,
    [
      status,
      service.client_id,
      service.employee_id,
      service.description,
      service.value,
    ],
  );
}

async function listPaymentsByUser({ userId, role }) {
  const isEmployee = String(role || "").toUpperCase() === "EMPLOYEE";

  const result = await pool.query(
    `SELECT
       p.id,
       p.service_id,
       p.preference_id,
       p.payment_id,
       p.status,
       p.amount,
       p.created_at,
       p.updated_at,
       s.description,
       s.value,
       s.status AS service_status,
       employee.name AS employee_name,
       client.name AS client_name
     FROM payments p
     JOIN services s ON s.id = p.service_id
     JOIN users employee ON employee.id = s.employee_id
     JOIN users client ON client.id = s.client_id
     WHERE s.type = 'FECHADO'
       AND s.added_as = 'CLIENT'
       AND (
         ($2 = true AND s.employee_id = $1)
         OR
         ($2 = false AND s.client_id = $1)
       )
     ORDER BY p.created_at DESC`,
    [userId, isEmployee],
  );

  return result.rows;
}

async function getPaymentMetricsByUser({ userId, role }) {
  const normalizedRole = String(role || "").toUpperCase();

  if (normalizedRole === "CLIENT") {
    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE p.status = 'approved') AS paid_count,
         COUNT(*) FILTER (WHERE p.status = 'pending') AS pending_count,
         COALESCE(SUM(CASE WHEN p.status = 'approved' THEN p.amount ELSE 0 END), 0) AS total_spent,
         COALESCE(SUM(CASE WHEN p.status = 'pending' THEN p.amount ELSE 0 END), 0) AS total_pending
       FROM payments p
       JOIN services s ON s.id = p.service_id
       WHERE s.client_id = $1
         AND s.type = 'FECHADO'
         AND s.added_as = 'CLIENT'`,
      [userId],
    );

    return result.rows[0];
  }

  const earnedRes = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE p.status = 'approved') AS services_done,
       COUNT(*) FILTER (WHERE p.status = 'pending') AS pending_receivables,
       COALESCE(SUM(CASE WHEN p.status = 'approved' THEN p.amount ELSE 0 END), 0) AS total_earned,
       COALESCE(SUM(CASE WHEN p.status = 'pending' THEN p.amount ELSE 0 END), 0) AS total_to_receive
     FROM payments p
     JOIN services s ON s.id = p.service_id
     WHERE s.employee_id = $1
       AND s.type = 'FECHADO'
       AND s.added_as = 'CLIENT'`,
    [userId],
  );

  const spentRes = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN p.status = 'approved' THEN p.amount ELSE 0 END), 0) AS total_spent
     FROM payments p
     JOIN services s ON s.id = p.service_id
     WHERE s.client_id = $1
       AND s.type = 'FECHADO'
       AND s.added_as = 'CLIENT'`,
    [userId],
  );

  return {
    ...earnedRes.rows[0],
    total_spent: spentRes.rows[0]?.total_spent || 0,
  };
}

async function getPaymentLineChartByUser({ userId, role }) {
  const normalizedRole = String(role || "").toUpperCase();

  if (normalizedRole === "CLIENT") {
    const result = await pool.query(
      `SELECT
         DATE(COALESCE(p.updated_at, p.created_at)) AS date,
         COALESCE(SUM(CASE WHEN p.status = 'approved' THEN p.amount ELSE 0 END), 0) AS gastos
       FROM payments p
       JOIN services s ON s.id = p.service_id
       WHERE s.client_id = $1
         AND s.type = 'FECHADO'
         AND s.added_as = 'CLIENT'
       GROUP BY DATE(COALESCE(p.updated_at, p.created_at))
       ORDER BY DATE(COALESCE(p.updated_at, p.created_at))
       LIMIT 30`,
      [userId],
    );

    return result.rows;
  }

  const ganhosRes = await pool.query(
    `SELECT
       DATE(COALESCE(p.updated_at, p.created_at)) AS date,
       COALESCE(SUM(CASE WHEN p.status = 'approved' THEN p.amount ELSE 0 END), 0) AS ganhos
     FROM payments p
     JOIN services s ON s.id = p.service_id
     WHERE s.employee_id = $1
       AND s.type = 'FECHADO'
       AND s.added_as = 'CLIENT'
     GROUP BY DATE(COALESCE(p.updated_at, p.created_at))
     ORDER BY DATE(COALESCE(p.updated_at, p.created_at))
     LIMIT 30`,
    [userId],
  );

  const gastosRes = await pool.query(
    `SELECT
       DATE(COALESCE(p.updated_at, p.created_at)) AS date,
       COALESCE(SUM(CASE WHEN p.status = 'approved' THEN p.amount ELSE 0 END), 0) AS gastos
     FROM payments p
     JOIN services s ON s.id = p.service_id
     WHERE s.client_id = $1
       AND s.type = 'FECHADO'
       AND s.added_as = 'CLIENT'
     GROUP BY DATE(COALESCE(p.updated_at, p.created_at))
     ORDER BY DATE(COALESCE(p.updated_at, p.created_at))
     LIMIT 30`,
    [userId],
  );

  return {
    ganhos: ganhosRes.rows,
    gastos: gastosRes.rows,
  };
}

async function getPaymentStatusChartByUser({ userId, role }) {
  const isEmployee = String(role || "").toUpperCase() === "EMPLOYEE";

  const result = await pool.query(
    `SELECT p.status, COUNT(*)::int AS total
     FROM payments p
     JOIN services s ON s.id = p.service_id
     WHERE s.type = 'FECHADO'
       AND s.added_as = 'CLIENT'
       AND (
         ($2 = true AND s.employee_id = $1)
         OR
         ($2 = false AND s.client_id = $1)
       )
     GROUP BY p.status
     ORDER BY p.status`,
    [userId, isEmployee],
  );

  return result.rows;
}

module.exports = {
  ensurePaymentsTable,
  findServiceById,
  upsertPendingPayment,
  findPaymentByPaymentId,
  findPaymentByPreferenceId,
  findPaymentByServiceId,
  markPaymentApproved,
  markPaymentFailed,
  updateServiceStatus,
  listPaymentsByUser,
  getPaymentMetricsByUser,
  getPaymentLineChartByUser,
  getPaymentStatusChartByUser,
};
