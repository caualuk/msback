const pool = require("../../../database/db");

const PERIODS = {
  MORNING: { key: "MORNING", label: "manha", start: "08:00", end: "12:00" },
  AFTERNOON: {
    key: "AFTERNOON",
    label: "tarde",
    start: "12:00",
    end: "18:00",
  },
  EVENING: { key: "EVENING", label: "noite", start: "18:00", end: "22:00" },
};

const PERIOD_KEYS = Object.keys(PERIODS);

function toMinutes(timeStr) {
  const [h, m] = String(timeStr || "00:00")
    .split(":")
    .map((v) => parseInt(v, 10));
  return h * 60 + m;
}

function toTime(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function normalizeDate(value) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

function normalizeTime(value) {
  const raw = String(value || "").trim();
  if (!/^\d{2}:\d{2}$/.test(raw)) return null;

  const [h, m] = raw.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  if (m % 30 !== 0) return null;

  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function normalizeWeekday(value) {
  const wd = Number(value);
  if (!Number.isInteger(wd) || wd < 0 || wd > 6) return null;
  return wd;
}

function normalizeSchedule(scheduleInput) {
  if (!Array.isArray(scheduleInput)) return [];

  const normalized = [];

  for (const item of scheduleInput) {
    const weekday = normalizeWeekday(item?.weekday);
    if (weekday === null) continue;

    const periods = Array.isArray(item?.periods)
      ? item.periods
          .map((period) => String(period || "").toUpperCase())
          .filter((period) => PERIOD_KEYS.includes(period))
      : [];

    const uniquePeriods = [...new Set(periods)];
    if (uniquePeriods.length === 0) continue;

    normalized.push({ weekday, periods: uniquePeriods });
  }

  return normalized;
}

function normalizeWorkingIntervals(input) {
  if (!Array.isArray(input)) return [];

  const normalized = [];

  for (const day of input) {
    const weekday = normalizeWeekday(day?.weekday);
    if (weekday === null) continue;

    if (!Array.isArray(day?.intervals) || day.intervals.length === 0) continue;

    const intervals = [];

    for (const interval of day.intervals) {
      const start = normalizeTime(interval?.start);
      const end = normalizeTime(interval?.end);
      if (!start || !end) continue;
      if (toMinutes(start) >= toMinutes(end)) continue;
      intervals.push({ start, end });
    }

    intervals.sort((a, b) => toMinutes(a.start) - toMinutes(b.start));

    let valid = true;
    for (let index = 1; index < intervals.length; index += 1) {
      const prev = intervals[index - 1];
      const curr = intervals[index];

      if (toMinutes(curr.start) < toMinutes(prev.end)) {
        valid = false;
        break;
      }
    }

    if (!valid || intervals.length === 0) continue;

    normalized.push({ weekday, intervals });
  }

  return normalized;
}

function scheduleRowsToPayload(rows) {
  const byWeekday = new Map();

  for (const row of rows) {
    const weekday = Number(row.weekday);
    if (!byWeekday.has(weekday)) {
      byWeekday.set(weekday, { weekday, periods: [] });
    }
    byWeekday.get(weekday).periods.push(String(row.period).toUpperCase());
  }

  return [...byWeekday.values()]
    .map((item) => ({
      weekday: item.weekday,
      periods: [...new Set(item.periods)],
    }))
    .sort((a, b) => a.weekday - b.weekday);
}

async function getShiftAvailabilityRows(professionalId) {
  const result = await pool.query(
    `SELECT weekday, period, start_time, end_time
     FROM professional_shift_availability
     WHERE professional_id = $1
     ORDER BY weekday, period`,
    [professionalId],
  );

  return result.rows;
}

async function getWorkIntervalsRows(professionalId) {
  const result = await pool.query(
    `SELECT weekday, start_time, end_time
     FROM professional_work_intervals
     WHERE professional_id = $1
     ORDER BY weekday, start_time`,
    [professionalId],
  );

  return result.rows;
}

function intervalRowsToPayload(rows) {
  const byWeekday = new Map();

  for (const row of rows) {
    const weekday = Number(row.weekday);
    if (!byWeekday.has(weekday)) {
      byWeekday.set(weekday, { weekday, intervals: [] });
    }

    byWeekday.get(weekday).intervals.push({
      start: String(row.start_time).slice(0, 5),
      end: String(row.end_time).slice(0, 5),
    });
  }

  return [...byWeekday.values()].sort((a, b) => a.weekday - b.weekday);
}

async function saveShiftAvailability(professionalId, normalizedSchedule) {
  await pool.query(
    `DELETE FROM professional_shift_availability WHERE professional_id = $1`,
    [professionalId],
  );

  for (const day of normalizedSchedule) {
    for (const periodKey of day.periods) {
      const period = PERIODS[periodKey];
      await pool.query(
        `INSERT INTO professional_shift_availability (
          professional_id,
          weekday,
          period,
          start_time,
          end_time
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (professional_id, weekday, period)
        DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time`,
        [professionalId, day.weekday, period.key, period.start, period.end],
      );
    }
  }

  await pool.query(
    `DELETE FROM professional_availability WHERE professional_id = $1`,
    [professionalId],
  );

  for (const day of normalizedSchedule) {
    const ranges = day.periods
      .map((periodKey) => PERIODS[periodKey])
      .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));

    if (ranges.length === 0) continue;

    const workStart = ranges[0].start;
    const workEnd = ranges[ranges.length - 1].end;

    await pool.query(
      `INSERT INTO professional_availability (professional_id, weekday, start_time, end_time)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (professional_id, weekday)
       DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time`,
      [professionalId, day.weekday, workStart, workEnd],
    );
  }

  const allRanges = normalizedSchedule
    .flatMap((day) => day.periods.map((periodKey) => PERIODS[periodKey]))
    .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));

  if (allRanges.length > 0) {
    await pool.query(
      `UPDATE professionals SET work_start = $1, work_end = $2 WHERE id = $3`,
      [allRanges[0].start, allRanges[allRanges.length - 1].end, professionalId],
    );
  }
}

async function saveWorkIntervals(professionalId, normalizedIntervals) {
  await pool.query(
    `DELETE FROM professional_work_intervals WHERE professional_id = $1`,
    [professionalId],
  );

  for (const day of normalizedIntervals) {
    for (const interval of day.intervals) {
      await pool.query(
        `INSERT INTO professional_work_intervals (professional_id, weekday, start_time, end_time)
         VALUES ($1, $2, $3, $4)`,
        [professionalId, day.weekday, interval.start, interval.end],
      );
    }
  }

  await pool.query(
    `DELETE FROM professional_shift_availability WHERE professional_id = $1`,
    [professionalId],
  );

  await pool.query(
    `DELETE FROM professional_availability WHERE professional_id = $1`,
    [professionalId],
  );

  for (const day of normalizedIntervals) {
    const start = day.intervals[0].start;
    const end = day.intervals[day.intervals.length - 1].end;

    await pool.query(
      `INSERT INTO professional_availability (professional_id, weekday, start_time, end_time)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (professional_id, weekday)
       DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time`,
      [professionalId, day.weekday, start, end],
    );
  }

  const allIntervals = normalizedIntervals
    .flatMap((day) => day.intervals)
    .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));

  if (allIntervals.length > 0) {
    await pool.query(
      `UPDATE professionals SET work_start = $1, work_end = $2 WHERE id = $3`,
      [allIntervals[0].start, allIntervals[allIntervals.length - 1].end, professionalId],
    );
  }
}

async function getEmployeeWorkingHoursPayload(professionalId) {
  const intervalRows = await getWorkIntervalsRows(professionalId);

  if (intervalRows.length > 0) {
    return {
      hasScheduleConfigured: true,
      mode: "INTERVALS",
      workingIntervals: intervalRowsToPayload(intervalRows),
      schedule: [],
    };
  }

  const shiftRows = await getShiftAvailabilityRows(professionalId);

  return {
    hasScheduleConfigured: shiftRows.length > 0,
    mode: shiftRows.length > 0 ? "PERIODS" : "NONE",
    workingIntervals: [],
    schedule: scheduleRowsToPayload(shiftRows),
  };
}

async function resolveProfessionalByIdOrUserId(idOrUserId) {
  const numericId = Number(idOrUserId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return null;
  }

  const byProfessionalId = await pool.query(
    `SELECT id, user_id, name, work_start, work_end
     FROM professionals
     WHERE id = $1
     LIMIT 1`,
    [numericId],
  );

  if (byProfessionalId.rows.length > 0) {
    return byProfessionalId.rows[0];
  }

  const byUserId = await pool.query(
    `SELECT id, user_id, name, work_start, work_end
     FROM professionals
     WHERE user_id = $1
     LIMIT 1`,
    [numericId],
  );

  return byUserId.rows[0] || null;
}

async function ensureDefaultBookingServiceForProfessional(professionalId) {
  const existingServices = await pool.query(
    `SELECT id
     FROM booking_services
     WHERE professional_id = $1
       AND active = TRUE
     LIMIT 1`,
    [professionalId],
  );

  if (existingServices.rows.length > 0) {
    return existingServices.rows[0].id;
  }

  const insertedService = await pool.query(
    `INSERT INTO booking_services (professional_id, name, description, duration_minutes, price, active)
     VALUES ($1, 'Atendimento Geral', 'Serviço padrão para agendamento.', 60, 80.00, TRUE)
     RETURNING id`,
    [professionalId],
  );

  const serviceId = insertedService.rows[0].id;

  await pool.query(
    `INSERT INTO professional_services (professional_id, service_id)
     VALUES ($1, $2)
     ON CONFLICT (professional_id, service_id) DO NOTHING`,
    [professionalId, serviceId],
  );

  return serviceId;
}

async function ensureProfessionalFromUser(userId) {
  const userRes = await pool.query(
    `SELECT id, name FROM users WHERE id = $1 AND role = 'EMPLOYEE' LIMIT 1`,
    [userId],
  );

  if (userRes.rows.length === 0) {
    return null;
  }

  const user = userRes.rows[0];

  const existing = await pool.query(
    `SELECT id, user_id, name, work_start, work_end
     FROM professionals
     WHERE user_id = $1
     LIMIT 1`,
    [user.id],
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const inserted = await pool.query(
    `INSERT INTO professionals (user_id, name)
     VALUES ($1, $2)
     RETURNING id, user_id, name, work_start, work_end`,
    [user.id, user.name],
  );

  const professional = inserted.rows[0];

  await pool.query(
    `INSERT INTO professional_availability (professional_id, weekday, start_time, end_time)
     SELECT $1, d.weekday, '08:00', '18:00'
     FROM (VALUES (1), (2), (3), (4), (5)) AS d(weekday)
     ON CONFLICT (professional_id, weekday) DO NOTHING`,
    [professional.id],
  );

  await ensureDefaultBookingServiceForProfessional(professional.id);

  return professional;
}

async function calculateAvailableTimes({ professionalIdOrUserId, date, serviceDuration }) {
  const normalizedDate = normalizeDate(date);
  if (!normalizedDate) {
    return { error: "Data inválida. Use YYYY-MM-DD" };
  }

  const professional = await resolveProfessionalByIdOrUserId(professionalIdOrUserId);
  if (!professional) {
    return { error: "Profissional não encontrado" };
  }

  const [year, month, day] = normalizedDate.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  const workIntervalsRes = await pool.query(
    `SELECT start_time, end_time
     FROM professional_work_intervals
     WHERE professional_id = $1 AND weekday = $2
     ORDER BY start_time`,
    [professional.id, weekday],
  );

  const intervals = workIntervalsRes.rows.map((row) => ({
    startMinutes: toMinutes(String(row.start_time).slice(0, 5)),
    endMinutes: toMinutes(String(row.end_time).slice(0, 5)),
  }));

  if (intervals.length === 0) {
    const shiftAvailabilityRes = await pool.query(
      `SELECT start_time, end_time
       FROM professional_shift_availability
       WHERE professional_id = $1 AND weekday = $2
       ORDER BY start_time`,
      [professional.id, weekday],
    );

    for (const row of shiftAvailabilityRes.rows) {
      intervals.push({
        startMinutes: toMinutes(String(row.start_time).slice(0, 5)),
        endMinutes: toMinutes(String(row.end_time).slice(0, 5)),
      });
    }
  }

  if (intervals.length === 0) {
    const availabilityRes = await pool.query(
      `SELECT start_time, end_time
       FROM professional_availability
       WHERE professional_id = $1 AND weekday = $2
       LIMIT 1`,
      [professional.id, weekday],
    );

    if (availabilityRes.rows.length === 0) {
      return {
        professional,
        date: normalizedDate,
        times: [],
      };
    }

    const availability = availabilityRes.rows[0];
    intervals.push({
      startMinutes: toMinutes(String(availability.start_time).slice(0, 5)),
      endMinutes: toMinutes(String(availability.end_time).slice(0, 5)),
    });
  }
  const duration = Number(serviceDuration);

  if (!Number.isInteger(duration) || duration <= 0) {
    return { error: "Duração do serviço inválida" };
  }

  const appointmentsRes = await pool.query(
    `SELECT start_time, end_time
     FROM appointments
     WHERE professional_id = $1
       AND date = $2
       AND status <> 'CANCELLED'`,
    [professional.id, normalizedDate],
  );

  const appointments = appointmentsRes.rows.map((row) => ({
    start: toMinutes(String(row.start_time).slice(0, 5)),
    end: toMinutes(String(row.end_time).slice(0, 5)),
  }));

  const step = 30;
  const available = [];

  for (const interval of intervals) {
    for (
      let cursor = interval.startMinutes;
      cursor + duration <= interval.endMinutes;
      cursor += step
    ) {
      const slotStart = cursor;
      const slotEnd = cursor + duration;

      const hasConflict = appointments.some(
        (appt) => slotStart < appt.end && slotEnd > appt.start,
      );

      if (!hasConflict) {
        available.push(toTime(slotStart));
      }
    }
  }

  return {
    professional,
    date: normalizedDate,
    times: available,
  };
}

async function listServices(req, res) {
  try {
    const { professional_id, professional_user_id } = req.query;

    let professionalFilter = null;

    if (professional_id) {
      const prof = await resolveProfessionalByIdOrUserId(professional_id);
      if (!prof) {
        return res.status(404).json({ error: "Profissional não encontrado" });
      }
      professionalFilter = prof.id;
      await ensureDefaultBookingServiceForProfessional(professionalFilter);
    }

    if (!professionalFilter && professional_user_id) {
      const prof = await resolveProfessionalByIdOrUserId(professional_user_id);
      if (!prof) {
        return res.status(404).json({ error: "Profissional não encontrado" });
      }
      professionalFilter = prof.id;
      await ensureDefaultBookingServiceForProfessional(professionalFilter);
    }

    const result = professionalFilter
      ? await pool.query(
          `SELECT s.id, s.name, s.description, s.duration_minutes, s.price, s.professional_id,
                  p.user_id AS professional_user_id, p.name AS professional_name
           FROM booking_services s
           JOIN professionals p ON p.id = s.professional_id
           WHERE s.active = TRUE AND s.professional_id = $1
           ORDER BY s.name`,
          [professionalFilter],
        )
      : await pool.query(
          `SELECT s.id, s.name, s.description, s.duration_minutes, s.price, s.professional_id,
                  p.user_id AS professional_user_id, p.name AS professional_name
           FROM booking_services s
           JOIN professionals p ON p.id = s.professional_id
           WHERE s.active = TRUE
           ORDER BY s.name`,
        );

    res.json(result.rows);
  } catch (error) {
    console.error("Erro ao listar serviços de agenda:", error);
    res.status(500).json({ error: "Erro ao listar serviços" });
  }
}

async function createCatalogService(req, res) {
  try {
    const userId = req.user.id;
    const { name, description, duration, price } = req.body;

    if (!name || !duration || !price) {
      return res.status(400).json({
        error: "Nome, duração e preço são obrigatórios",
      });
    }

    const durationMinutes = Number(duration);
    const priceNumber = Number(price);

    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
      return res.status(400).json({ error: "Duração inválida" });
    }

    if (!Number.isFinite(priceNumber) || priceNumber <= 0) {
      return res.status(400).json({ error: "Preço inválido" });
    }

    const professional = await ensureProfessionalFromUser(userId);
    if (!professional) {
      return res.status(403).json({
        error: "Apenas funcionários podem cadastrar serviços de agenda",
      });
    }

    const inserted = await pool.query(
      `INSERT INTO booking_services (professional_id, name, description, duration_minutes, price)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        professional.id,
        String(name).trim(),
        description ? String(description).trim() : null,
        durationMinutes,
        priceNumber,
      ],
    );

    await pool.query(
      `INSERT INTO professional_services (professional_id, service_id)
       VALUES ($1, $2)
       ON CONFLICT (professional_id, service_id) DO NOTHING`,
      [professional.id, inserted.rows[0].id],
    );

    res.status(201).json(inserted.rows[0]);
  } catch (error) {
    console.error("Erro ao cadastrar serviço de agenda:", error);
    res.status(500).json({ error: "Erro ao cadastrar serviço" });
  }
}

async function listProfessionals(req, res) {
  try {
    const result = await pool.query(
      `SELECT p.id, p.user_id, p.name, p.work_start, p.work_end,
              u.city_id, c.name AS city_name, c.state AS city_state
       FROM professionals p
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN cities c ON c.id = u.city_id
       ORDER BY p.name`,
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Erro ao listar profissionais:", error);
    res.status(500).json({ error: "Erro ao listar profissionais" });
  }
}

async function updateWorkingHours(req, res) {
  try {
    const professionalRef = req.params.id;
    const { workStart, workEnd, weekdays, schedule, workingIntervals } = req.body;

    const professional = await resolveProfessionalByIdOrUserId(professionalRef);

    if (!professional) {
      return res.status(404).json({ error: "Profissional não encontrado" });
    }

    const normalizedIntervals = normalizeWorkingIntervals(workingIntervals);
    let normalizedSchedule = normalizeSchedule(schedule);

    if (normalizedIntervals.length > 0) {
      await saveWorkIntervals(professional.id, normalizedIntervals);

      const payload = await getEmployeeWorkingHoursPayload(professional.id);

      return res.json({
        message: "Horários de trabalho atualizados",
        professional_id: professional.id,
        ...payload,
      });
    }

    if (normalizedSchedule.length === 0 && Array.isArray(weekdays) && workStart && workEnd) {
      const start = String(workStart).slice(0, 5);
      const end = String(workEnd).slice(0, 5);
      const startMins = toMinutes(start);
      const endMins = toMinutes(end);

      if (startMins < endMins) {
        normalizedSchedule = weekdays
          .map((wd) => normalizeWeekday(wd))
          .filter((wd) => wd !== null)
          .map((wd) => {
            const periods = PERIOD_KEYS.filter((key) => {
              const range = PERIODS[key];
              const periodStart = toMinutes(range.start);
              const periodEnd = toMinutes(range.end);
              return startMins < periodEnd && endMins > periodStart;
            });

            return { weekday: wd, periods };
          })
          .filter((item) => item.periods.length > 0);
      }
    }

    if (normalizedSchedule.length === 0) {
      return res.status(400).json({
        error: "Informe schedule com ao menos um dia/periodo de trabalho",
      });
    }

    await saveShiftAvailability(professional.id, normalizedSchedule);

    const payload = await getEmployeeWorkingHoursPayload(professional.id);

    return res.json({
      message: "Horários de trabalho atualizados",
      professional_id: professional.id,
      ...payload,
    });
  } catch (error) {
    console.error("Erro ao atualizar horários do profissional:", error);
    res.status(500).json({ error: "Erro ao atualizar horários" });
  }
}

async function getMyWorkingHours(req, res) {
  try {
    const professional = await ensureProfessionalFromUser(req.user.id);

    if (!professional) {
      return res.status(403).json({
        error: "Apenas funcionários podem acessar horários de trabalho",
      });
    }

    const payload = await getEmployeeWorkingHoursPayload(professional.id);

    return res.json({
      professional_id: professional.id,
      ...payload,
    });
  } catch (error) {
    console.error("Erro ao buscar horários do funcionário:", error);
    return res.status(500).json({ error: "Erro ao buscar horários de trabalho" });
  }
}

async function updateMyWorkingHours(req, res) {
  try {
    const { schedule, workingIntervals } = req.body;
    const normalizedIntervals = normalizeWorkingIntervals(workingIntervals);
    const normalizedSchedule = normalizeSchedule(schedule);

    const professional = await ensureProfessionalFromUser(req.user.id);

    if (!professional) {
      return res.status(403).json({
        error: "Apenas funcionários podem atualizar horários de trabalho",
      });
    }

    if (normalizedIntervals.length > 0) {
      await saveWorkIntervals(professional.id, normalizedIntervals);
    } else if (normalizedSchedule.length > 0) {
      await saveShiftAvailability(professional.id, normalizedSchedule);
    } else {
      return res.status(400).json({
        error: "Selecione ao menos um dia e horário de trabalho",
      });
    }

    const payload = await getEmployeeWorkingHoursPayload(professional.id);

    return res.json({
      message: "Horários de trabalho atualizados",
      professional_id: professional.id,
      ...payload,
    });
  } catch (error) {
    console.error("Erro ao atualizar horários do funcionário:", error);
    return res.status(500).json({ error: "Erro ao atualizar horários de trabalho" });
  }
}

async function getAvailableTimes(req, res) {
  try {
    const { id } = req.params;
    const { date, service_id } = req.query;

    if (!date || !service_id) {
      return res.status(400).json({
        error: "Informe date e service_id",
      });
    }

    const serviceRes = await pool.query(
      `SELECT s.id, s.professional_id, s.duration_minutes
       FROM booking_services s
       WHERE s.id = $1 AND s.active = TRUE
       LIMIT 1`,
      [service_id],
    );

    if (serviceRes.rows.length === 0) {
      return res.status(404).json({ error: "Serviço não encontrado" });
    }

    const service = serviceRes.rows[0];

    const professional = await resolveProfessionalByIdOrUserId(id);
    if (!professional) {
      return res.status(404).json({ error: "Profissional não encontrado" });
    }

    if (Number(service.professional_id) !== Number(professional.id)) {
      return res.status(400).json({
        error: "Serviço não pertence ao profissional informado",
      });
    }

    const available = await calculateAvailableTimes({
      professionalIdOrUserId: professional.id,
      date,
      serviceDuration: service.duration_minutes,
    });

    if (available.error) {
      return res.status(400).json({ error: available.error });
    }

    return res.json(available.times);
  } catch (error) {
    console.error("Erro ao buscar horários disponíveis:", error);
    return res.status(500).json({ error: "Erro ao buscar horários disponíveis" });
  }
}

async function createAppointment(req, res) {
  try {
    const userId = req.user.id;
    const { professional_id, service_id, date, start_time, notes } = req.body;

    if (!professional_id || !service_id || !date || !start_time) {
      return res.status(400).json({
        error: "professional_id, service_id, date e start_time são obrigatórios",
      });
    }

    const serviceRes = await pool.query(
      `SELECT id, professional_id, duration_minutes, price
       FROM booking_services
       WHERE id = $1 AND active = TRUE
       LIMIT 1`,
      [service_id],
    );

    if (serviceRes.rows.length === 0) {
      return res.status(404).json({ error: "Serviço não encontrado" });
    }

    const service = serviceRes.rows[0];
    const professional = await resolveProfessionalByIdOrUserId(professional_id);

    if (!professional) {
      return res.status(404).json({ error: "Profissional não encontrado" });
    }

    if (Number(service.professional_id) !== Number(professional.id)) {
      return res.status(400).json({
        error: "Serviço não pertence ao profissional informado",
      });
    }

    const available = await calculateAvailableTimes({
      professionalIdOrUserId: professional.id,
      date,
      serviceDuration: service.duration_minutes,
    });

    if (available.error) {
      return res.status(400).json({ error: available.error });
    }

    const normalizedStart = String(start_time).slice(0, 5);

    if (!available.times.includes(normalizedStart)) {
      return res.status(409).json({
        error: "Horário indisponível para este serviço",
      });
    }

    const endTime = toTime(toMinutes(normalizedStart) + Number(service.duration_minutes));

    const inserted = await pool.query(
      `INSERT INTO appointments (user_id, professional_id, service_id, date, start_time, end_time, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, 'BOOKED', $7)
       RETURNING *`,
      [userId, professional.id, service.id, date, normalizedStart, endTime, notes || null],
    );

    return res.status(201).json(inserted.rows[0]);
  } catch (error) {
    console.error("Erro ao criar agendamento:", error);
    return res.status(500).json({ error: "Erro ao criar agendamento" });
  }
}

async function deleteAppointment(req, res) {
  try {
    const appointmentId = Number(req.params.id);
    const userId = req.user.id;

    if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const result = await pool.query(
      `UPDATE appointments a
       SET status = 'CANCELLED'
       WHERE a.id = $1
         AND (a.user_id = $2 OR EXISTS (
           SELECT 1 FROM professionals p
           WHERE p.id = a.professional_id AND p.user_id = $2
         ))
       RETURNING *`,
      [appointmentId, userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Agendamento não encontrado" });
    }

    return res.json({ success: true, appointment: result.rows[0] });
  } catch (error) {
    console.error("Erro ao cancelar agendamento:", error);
    return res.status(500).json({ error: "Erro ao cancelar agendamento" });
  }
}

module.exports = {
  toMinutes,
  toTime,
  calculateAvailableTimes,
  resolveProfessionalByIdOrUserId,
  listServices,
  createCatalogService,
  listProfessionals,
  updateWorkingHours,
  getMyWorkingHours,
  updateMyWorkingHours,
  getAvailableTimes,
  createAppointment,
  deleteAppointment,
};
