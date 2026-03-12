const pool = require("../../../database/db");
const {
  resolveProfessionalByIdOrUserId,
  calculateAvailableTimes,
  toMinutes,
  toTime,
} = require("../../Booking/repository/Booking");

// Criar uma solicitação de serviço
async function createServiceRequest(req, res) {
  try {
    const { employeeId, description } = req.body;
    const clientId = req.user.id;

    if (!employeeId) {
      return res.status(400).json({ error: "Funcionário é obrigatório" });
    }

    const rawEmployeeId = Number(employeeId);
    if (!Number.isInteger(rawEmployeeId) || rawEmployeeId <= 0) {
      return res.status(400).json({ error: "Funcionário inválido" });
    }

    let targetEmployeeUserId = rawEmployeeId;
    const professional = await resolveProfessionalByIdOrUserId(rawEmployeeId);
    if (professional?.user_id) {
      targetEmployeeUserId = Number(professional.user_id);
    }

    const employeeUserResult = await pool.query(
      `SELECT id FROM users WHERE id = $1 AND role = 'EMPLOYEE' LIMIT 1`,
      [targetEmployeeUserId],
    );

    if (employeeUserResult.rows.length === 0) {
      return res.status(404).json({ error: "Funcionário não encontrado" });
    }

    if (!description || !String(description).trim()) {
      return res
        .status(400)
        .json({ error: "Descrição do serviço é obrigatória" });
    }

    console.log("[SERVICE REQUEST] Criando solicitação:", {
      clientId,
      employeeId: targetEmployeeUserId,
      description,
    });

    // Buscar informações do cliente para a notificação
    const clientInfo = await pool.query(
      `SELECT
          u.name as client_name,
          c.name as client_city,
          u.zip_code,
          u.neighborhood,
          u.street,
          u.number,
          u.complement,
          u.reference
       FROM users u
       LEFT JOIN cities c ON u.city_id = c.id
       WHERE u.id = $1`,
      [clientId],
    );

    const clientRow = clientInfo.rows[0] || {};

    if (
      !clientRow.zip_code ||
      !clientRow.neighborhood ||
      !clientRow.street ||
      !clientRow.number
    ) {
      return res.status(400).json({
        error:
          "Endereço do cliente incompleto no cadastro. Atualize CEP, bairro, rua e número.",
      });
    }

    const result = await pool.query(
      `INSERT INTO service_requests (
        client_id,
        employee_id,
        description,
        client_zip_code,
        client_neighborhood,
        client_street,
        client_number,
        client_complement,
        client_reference,
        status,
        created_at
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING', NOW())
       RETURNING *`,
      [
        clientId,
        targetEmployeeUserId,
        description,
        clientRow.zip_code,
        clientRow.neighborhood,
        clientRow.street,
        clientRow.number,
        clientRow.complement || null,
        clientRow.reference || null,
      ],
    );

    const serviceRequest = result.rows[0];
    console.log("[SERVICE REQUEST] Solicitação criada:", serviceRequest);

    // Criar notificação para o funcionário
    const clientName = clientInfo.rows[0]?.client_name || "Cliente";
    const clientCity = clientInfo.rows[0]?.client_city || null;

    await pool.query(
      `INSERT INTO notifications (
        user_id,
        type,
        service_request_id,
        from_user_id,
        from_user_name,
        from_user_city,
        description,
        client_zip_code,
        client_neighborhood,
        client_street,
        client_number,
        client_complement,
        client_reference,
        created_at
      )
       VALUES ($1, 'service_request', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
      [
        targetEmployeeUserId,
        serviceRequest.id,
        clientId,
        clientName,
        clientCity,
        description,
        serviceRequest.client_zip_code,
        serviceRequest.client_neighborhood,
        serviceRequest.client_street,
        serviceRequest.client_number,
        serviceRequest.client_complement,
        serviceRequest.client_reference,
      ],
    );

    console.log(
      "[SERVICE REQUEST] Notificação criada para funcionário:",
      targetEmployeeUserId,
    );

    res.status(201).json(serviceRequest);
  } catch (error) {
    console.error("Erro ao criar solicitação de serviço:", error);
    res.status(500).json({ error: "Erro ao criar solicitação de serviço" });
  }
}

// Aceitar solicitação de serviço e enviar valor
async function acceptServiceRequest(req, res) {
  try {
    const { id } = req.params;
    const { price, durationMinutes } = req.body;
    const employeeId = req.user.id;

    console.log("[ACCEPT SERVICE] Funcionário aceitando:", {
      requestId: id,
      employeeId,
      price,
      durationMinutes,
    });

    const parsedDuration = Number(durationMinutes);
    if (!Number.isInteger(parsedDuration) || parsedDuration <= 0) {
      return res.status(400).json({ error: "Duração do serviço inválida" });
    }

    // Verificar se a solicitação existe e pertence ao funcionário
    const checkResult = await pool.query(
      `SELECT sr.*, 
              u.name as employee_name,
              u.profile_color as employee_color,
              c.name as employee_city
       FROM service_requests sr
       JOIN users u ON sr.employee_id = u.id
       LEFT JOIN cities c ON u.city_id = c.id
       WHERE sr.id = $1 AND sr.employee_id = $2`,
      [id, employeeId],
    );

    if (checkResult.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Solicitação de serviço não encontrada" });
    }

    const serviceRequest = checkResult.rows[0];

    // Atualizar status, preço e duração (já com 20% de taxa aplicada)
    const updateResult = await pool.query(
      `UPDATE service_requests 
       SET status = 'ACCEPTED', final_price = $1, proposed_duration_minutes = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [price, parsedDuration, id],
    );

    // Criar notificação para o cliente
    await pool.query(
      `INSERT INTO notifications (
        user_id,
        type,
        service_request_id,
        from_user_id,
        from_user_name,
        from_user_city,
        description,
        proposal_price,
        created_at
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        serviceRequest.client_id,
        "service_accepted",
        id,
        employeeId,
        serviceRequest.employee_name,
        serviceRequest.employee_city,
        serviceRequest.description,
        price,
      ],
    );

    console.log(
      "[ACCEPT SERVICE] Notificação criada para cliente:",
      serviceRequest.client_id,
    );

    // Deletar a notificação antiga do funcionário (service_request)
    await pool.query(
      `DELETE FROM notifications WHERE user_id = $1 AND service_request_id = $2 AND type = 'service_request'`,
      [employeeId, id],
    );

    console.log("[ACCEPT SERVICE] Notificação antiga do funcionário deletada");

    res.json(updateResult.rows[0]);
  } catch (error) {
    console.error("Erro ao aceitar solicitação de serviço:", error);
    res.status(500).json({ error: "Erro ao aceitar solicitação de serviço" });
  }
}

// Recusar solicitação de serviço
async function declineServiceRequest(req, res) {
  try {
    const { id } = req.params;
    const employeeId = req.user.id;

    // Verificar se a solicitação existe e pertence ao funcionário
    const checkResult = await pool.query(
      `SELECT * FROM service_requests WHERE id = $1 AND employee_id = $2`,
      [id, employeeId],
    );

    if (checkResult.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Solicitação de serviço não encontrada" });
    }

    // Atualizar status para DECLINED
    const updateResult = await pool.query(
      `UPDATE service_requests 
       SET status = 'DECLINED', updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id],
    );

    // Deletar a notificação do funcionário (service_request)
    await pool.query(
      `DELETE FROM notifications WHERE user_id = $1 AND service_request_id = $2 AND type = 'service_request'`,
      [employeeId, id],
    );

    console.log("[DECLINE SERVICE] Notificação do funcionário deletada");

    res.json(updateResult.rows[0]);
  } catch (error) {
    console.error("Erro ao recusar solicitação de serviço:", error);
    res.status(500).json({ error: "Erro ao recusar solicitação de serviço" });
  }
}

// Listar solicitações do funcionário
async function getEmployeeRequests(req, res) {
  try {
    const employeeId = req.user.id;

    console.log(
      "[SERVICE REQUEST] Buscando solicitações para funcionário:",
      employeeId,
    );

    const result = await pool.query(
      `SELECT sr.*, 
              u.name as client_name, 
              u.email as client_email, 
              c.name as client_city
       FROM service_requests sr
       JOIN users u ON sr.client_id = u.id
       LEFT JOIN cities c ON u.city_id = c.id
       WHERE sr.employee_id = $1
       ORDER BY sr.created_at DESC`,
      [employeeId],
    );

    console.log(
      "[SERVICE REQUEST] Solicitações encontradas:",
      result.rows.length,
      result.rows,
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Erro ao listar solicitações do funcionário:", error);
    res.status(500).json({ error: "Erro ao listar solicitações" });
  }
}

// Listar solicitações do cliente
async function getClientRequests(req, res) {
  try {
    const clientId = req.user.id;

    const result = await pool.query(
      `SELECT sr.*, 
              u.name as employee_name, 
              u.email as employee_email, 
              c.name as employee_city,
              closed_service.status as service_status,
              pay.status as payment_status
       FROM service_requests sr
       JOIN users u ON sr.employee_id = u.id
       LEFT JOIN cities c ON u.city_id = c.id
       LEFT JOIN LATERAL (
         SELECT s.id, s.status
         FROM services s
         WHERE s.client_id = sr.client_id
           AND s.employee_id = sr.employee_id
           AND s.description = sr.description
           AND s.type = 'FECHADO'
           AND s.added_as = 'CLIENT'
         ORDER BY s.created_at DESC
         LIMIT 1
       ) closed_service ON true
       LEFT JOIN payments pay ON pay.service_id = closed_service.id
       WHERE sr.client_id = $1
       ORDER BY sr.created_at DESC`,
      [clientId],
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Erro ao listar solicitações do cliente:", error);
    res.status(500).json({ error: "Erro ao listar solicitações" });
  }
}

// Cliente aprova a proposta de preço - Cria serviço na tabela services
async function approveProposal(req, res) {
  try {
    const { id } = req.params;
    const clientId = req.user.id;
    const requestId = Number(id);

    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.status(400).json({ error: "ID da solicitação inválido" });
    }

    console.log("[APPROVE PROPOSAL] Cliente aprovando proposta:", {
      requestId: id,
      clientId,
    });

    // Buscar a solicitação com dados do cliente e funcionário
    const checkResult = await pool.query(
      `SELECT sr.*, 
              u2.name as employee_name,
              c.name as employee_city
       FROM service_requests sr
       JOIN users u2 ON sr.employee_id = u2.id
       LEFT JOIN cities c ON u2.city_id = c.id
       WHERE sr.id = $1
         AND sr.client_id = $2
         AND sr.status IN ('ACCEPTED', 'APPROVED')`,
      [requestId, clientId],
    );

    if (checkResult.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Proposta de preço não encontrada" });
    }

    const serviceRequest = checkResult.rows[0];

    if (!serviceRequest.proposed_duration_minutes) {
      return res.status(400).json({
        error: "Proposta sem duração informada pelo profissional",
      });
    }

    if (String(serviceRequest.status || "").toUpperCase() === "ACCEPTED") {
      await pool.query(
        `UPDATE service_requests
         SET status = 'APPROVED', updated_at = NOW()
         WHERE id = $1`,
        [requestId],
      );
    }

    res.json({
      success: true,
      requestId: serviceRequest.id,
      employeeId: serviceRequest.employee_id,
      employeeName: serviceRequest.employee_name,
      employeeCity: serviceRequest.employee_city,
      price: Number(serviceRequest.final_price || 0),
      durationMinutes: Number(serviceRequest.proposed_duration_minutes),
      message: "Proposta aceita. Escolha um horário para confirmar o agendamento.",
    });
  } catch (error) {
    console.error("Erro ao aprovar proposta:", error);
    res.status(500).json({ error: "Erro ao aprovar proposta" });
  }
}

async function getProposalAvailableSlots(req, res) {
  try {
    const { id } = req.params;
    const { date } = req.query;
    const clientId = req.user.id;

    if (!date) {
      return res.status(400).json({ error: "Informe a data no formato YYYY-MM-DD" });
    }

    const requestResult = await pool.query(
      `SELECT id, employee_id, proposed_duration_minutes, status
       FROM service_requests
       WHERE id = $1 AND client_id = $2`,
      [id, clientId],
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: "Solicitação não encontrada" });
    }

    const serviceRequest = requestResult.rows[0];
    if (!["ACCEPTED", "APPROVED"].includes(String(serviceRequest.status || "").toUpperCase())) {
      return res.status(400).json({ error: "Solicitação não está disponível para agendamento" });
    }

    const available = await calculateAvailableTimes({
      professionalIdOrUserId: serviceRequest.employee_id,
      date,
      serviceDuration: serviceRequest.proposed_duration_minutes,
    });

    if (available.error) {
      return res.status(400).json({ error: available.error });
    }

    return res.json({
      requestId: Number(serviceRequest.id),
      date,
      durationMinutes: Number(serviceRequest.proposed_duration_minutes),
      times: available.times,
    });
  } catch (error) {
    console.error("Erro ao buscar horários da proposta:", error);
    return res.status(500).json({ error: "Erro ao buscar horários disponíveis" });
  }
}

async function scheduleApprovedProposal(req, res) {
  try {
    const { id } = req.params;
    const { appointmentDate, appointmentStartTime } = req.body;
    const clientId = req.user.id;

    if (!appointmentDate || !appointmentStartTime) {
      return res.status(400).json({ error: "appointmentDate e appointmentStartTime são obrigatórios" });
    }

    const requestResult = await pool.query(
      `SELECT sr.*, u.name as client_name, c.name as client_city
       FROM service_requests sr
       JOIN users u ON u.id = sr.client_id
       LEFT JOIN cities c ON c.id = u.city_id
       WHERE sr.id = $1 AND sr.client_id = $2`,
      [id, clientId],
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json({ error: "Solicitação não encontrada" });
    }

    const serviceRequest = requestResult.rows[0];

    if (!["ACCEPTED", "APPROVED"].includes(String(serviceRequest.status || "").toUpperCase())) {
      return res.status(400).json({ error: "Solicitação não está disponível para agendamento" });
    }

    const durationMinutes = Number(serviceRequest.proposed_duration_minutes);
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
      return res.status(400).json({ error: "Duração da proposta inválida" });
    }

    const available = await calculateAvailableTimes({
      professionalIdOrUserId: serviceRequest.employee_id,
      date: appointmentDate,
      serviceDuration: durationMinutes,
    });

    if (available.error) {
      return res.status(400).json({ error: available.error });
    }

    const normalizedStart = String(appointmentStartTime).slice(0, 5);
    if (!available.times.includes(normalizedStart)) {
      return res.status(409).json({ error: "Horário não disponível para este serviço" });
    }

    const endTime = toTime(toMinutes(normalizedStart) + durationMinutes);

    const professional = await resolveProfessionalByIdOrUserId(serviceRequest.employee_id);
    if (!professional) {
      return res.status(404).json({ error: "Profissional não encontrado" });
    }

    const serviceRes = await pool.query(
      `SELECT id, duration_minutes
       FROM booking_services
       WHERE professional_id = $1 AND active = TRUE
       ORDER BY CASE WHEN duration_minutes = $2 THEN 0 ELSE 1 END, id
       LIMIT 1`,
      [professional.id, durationMinutes],
    );

    if (serviceRes.rows.length === 0) {
      return res.status(400).json({ error: "Profissional sem serviço ativo para agendamento" });
    }

    const bookingService = serviceRes.rows[0];

    const appointmentResult = await pool.query(
      `INSERT INTO appointments (
        user_id,
        professional_id,
        service_id,
        date,
        start_time,
        end_time,
        status,
        notes
      )
       VALUES ($1, $2, $3, $4, $5, $6, 'BOOKED', $7)
       RETURNING *`,
      [
        clientId,
        professional.id,
        bookingService.id,
        appointmentDate,
        normalizedStart,
        endTime,
        serviceRequest.description,
      ],
    );

    const appointment = appointmentResult.rows[0];

    const createdServiceResult = await pool.query(
      `INSERT INTO services (
        client_id,
        employee_id,
        profession_id,
        value,
        description,
        client_zip_code,
        client_neighborhood,
        client_street,
        client_number,
        client_complement,
        client_reference,
        status,
        added_as,
        type,
        created_at
      )
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING', 'CLIENT', 'FECHADO', NOW())
       RETURNING id`,
      [
        serviceRequest.client_id,
        serviceRequest.employee_id,
        Number(serviceRequest.final_price || 0),
        serviceRequest.description,
        serviceRequest.client_zip_code,
        serviceRequest.client_neighborhood,
        serviceRequest.client_street,
        serviceRequest.client_number,
        serviceRequest.client_complement,
        serviceRequest.client_reference,
      ],
    );

    const createdServiceId = createdServiceResult.rows[0]?.id || null;

    await pool.query(
      `UPDATE service_requests
       SET status = 'COMPLETED',
           booking_service_id = $1,
           appointment_id = $2,
           appointment_date = $3,
           appointment_start_time = $4,
           appointment_end_time = $5,
           updated_at = NOW()
       WHERE id = $6`,
      [
        bookingService.id,
        appointment.id,
        appointmentDate,
        normalizedStart,
        endTime,
        id,
      ],
    );

    await pool.query(
      `INSERT INTO notifications (
        user_id,
        type,
        service_request_id,
        from_user_id,
        from_user_name,
        from_user_city,
        description,
        created_at
      )
       VALUES ($1, 'proposal_approved', $2, $3, $4, $5, $6, NOW())`,
      [
        serviceRequest.employee_id,
        id,
        clientId,
        serviceRequest.client_name,
        serviceRequest.client_city,
        `${serviceRequest.description} | Agendado para ${appointmentDate} ${normalizedStart}`,
      ],
    );

    await pool.query(
      `DELETE FROM notifications WHERE user_id = $1 AND service_request_id = $2 AND type = 'service_accepted'`,
      [clientId, id],
    );

    return res.json({
      success: true,
      requestId: Number(id),
      serviceId: createdServiceId,
      appointment,
      message: "Agendamento criado com sucesso",
    });
  } catch (error) {
    console.error("Erro ao agendar proposta aprovada:", error);
    return res.status(500).json({ error: "Erro ao criar agendamento" });
  }
}

// Cliente recusa a proposta de preço
async function rejectProposal(req, res) {
  try {
    const { id } = req.params;
    const clientId = req.user.id;

    console.log("[REJECT PROPOSAL] Cliente recusando proposta:", {
      requestId: id,
      clientId,
    });

    // Buscar a solicitação com dados do cliente e funcionário
    const checkResult = await pool.query(
      `SELECT sr.*, 
              u.name as client_name,
              u.profile_color as client_color,
              c2.name as client_city,
              u2.id as employee_id
       FROM service_requests sr
       JOIN users u ON sr.client_id = u.id
       LEFT JOIN cities c2 ON u.city_id = c2.id
       JOIN users u2 ON sr.employee_id = u2.id
       WHERE sr.id = $1 AND sr.client_id = $2 AND sr.status = 'ACCEPTED'`,
      [id, clientId],
    );

    if (checkResult.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Proposta de preço não encontrada" });
    }

    const serviceRequest = checkResult.rows[0];

    // Atualizar status para REJECTED
    const updateResult = await pool.query(
      `UPDATE service_requests SET status = 'REJECTED', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id],
    );

    // Criar notificação para o funcionário
    await pool.query(
      `INSERT INTO notifications (
        user_id,
        type,
        service_request_id,
        from_user_id,
        from_user_name,
        from_user_city,
        description,
        client_zip_code,
        client_neighborhood,
        client_street,
        client_number,
        client_complement,
        client_reference,
        created_at
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())`,
      [
        serviceRequest.employee_id,
        "proposal_rejected",
        id,
        clientId,
        serviceRequest.client_name,
        serviceRequest.client_city,
        serviceRequest.description,
        serviceRequest.client_zip_code,
        serviceRequest.client_neighborhood,
        serviceRequest.client_street,
        serviceRequest.client_number,
        serviceRequest.client_complement,
        serviceRequest.client_reference,
      ],
    );

    // Deletar a notificação antiga do cliente (service_accepted)
    await pool.query(
      `DELETE FROM notifications WHERE user_id = $1 AND service_request_id = $2 AND type = 'service_accepted'`,
      [clientId, id],
    );

    console.log("[REJECT PROPOSAL] Proposta recusada:", updateResult.rows[0]);
    console.log(
      "[REJECT PROPOSAL] Notificação criada para funcionário:",
      serviceRequest.employee_id,
    );
    console.log("[REJECT PROPOSAL] Notificação antiga do cliente deletada");

    res.json({
      success: true,
      client_name: serviceRequest.client_name,
      client_color: serviceRequest.client_color,
      client_city: serviceRequest.client_city,
      message: "Proposta recusada",
    });
  } catch (error) {
    console.error("Erro ao recusar proposta:", error);
    res.status(500).json({ error: "Erro ao recusar proposta" });
  }
}

module.exports = {
  createServiceRequest,
  acceptServiceRequest,
  declineServiceRequest,
  getEmployeeRequests,
  getClientRequests,
  approveProposal,
  rejectProposal,
  getProposalAvailableSlots,
  scheduleApprovedProposal,
};
