const { Pool } = require("pg");
const path = require("path");
const dns = require("dns");

if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}

require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
  override: true,
});

function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl) return rawUrl;

  // Accept accidental formats like 'DATABASE_URL=postgres://...', '"postgres://...";' from .env edits.
  let sanitizedUrl = rawUrl.trim().replace(/^"|"$/g, "").replace(/;$/, "");

  if (sanitizedUrl.toUpperCase().startsWith("DATABASE_URL=")) {
    sanitizedUrl = sanitizedUrl.slice("DATABASE_URL=".length).trim();
  }

  // Handles DATABASE_URL values where password contains unescaped '@'.
  const protocolMatch = sanitizedUrl.match(/^(postgres(?:ql)?):\/\//i);
  if (!protocolMatch) return sanitizedUrl;

  const protocol = protocolMatch[0];
  const rest = sanitizedUrl.slice(protocol.length);
  const pathStart = rest.indexOf("/");
  const authority = pathStart >= 0 ? rest.slice(0, pathStart) : rest;
  const path = pathStart >= 0 ? rest.slice(pathStart) : "";

  const atIndex = authority.lastIndexOf("@");
  if (atIndex < 0) return sanitizedUrl;

  const credentials = authority.slice(0, atIndex);
  const hostPart = authority.slice(atIndex + 1);
  const colonIndex = credentials.indexOf(":");
  if (colonIndex < 0) return sanitizedUrl;

  const user = credentials.slice(0, colonIndex);
  const rawPassword = credentials.slice(colonIndex + 1);
  const password = rawPassword.replace(/^"|"$/g, "");

  // Avoid double-encoding when URL is already encoded.
  const encodedPassword = password.includes("%")
    ? password
    : encodeURIComponent(password);

  return `${protocol}${user}:${encodedPassword}@${hostPart}${path}`;
}

const connectionString = normalizeDatabaseUrl(process.env.DATABASE_URL);
const requiresSsl = /sslmode=require/i.test(connectionString || "");
const effectiveConnectionString = requiresSsl
  ? (connectionString || "")
      .replace(/([?&])sslmode=require(&|$)/i, (_, sep, tail) =>
        tail === "&" ? sep : "",
      )
      .replace(/[?&]$/, "")
  : connectionString;

const pool = new Pool({
  connectionString: effectiveConnectionString,
  ssl: requiresSsl ? { rejectUnauthorized: false } : undefined,
});

//TABELA CIDADES
async function citiesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cities (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        state VARCHAR(100) NOT NULL,
        zip_code VARCHAR(20),
        country VARCHAR(100) NOT NULL,
        latitude FLOAT,
        longitude FLOAT
  );
`);

  await pool.query(
    `ALTER TABLE cities ADD COLUMN IF NOT EXISTS zip_code VARCHAR(20)`,
  );
  // Compatibilidade: parte do código usa lat/lon e outra parte usa latitude/longitude.
  await pool.query(`ALTER TABLE cities ADD COLUMN IF NOT EXISTS lat FLOAT`);
  await pool.query(`ALTER TABLE cities ADD COLUMN IF NOT EXISTS lon FLOAT`);

  await pool.query(`
    UPDATE cities
    SET lat = COALESCE(lat, latitude),
        lon = COALESCE(lon, longitude)
  `);

  await pool.query(`
    UPDATE cities
    SET latitude = COALESCE(latitude, lat),
        longitude = COALESCE(longitude, lon)
  `);
}

// TABELA CEPS (cache local para CEP especifico e generico)
async function zipCodesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS zip_codes (
      id SERIAL PRIMARY KEY,
      cep VARCHAR(20) UNIQUE NOT NULL,
      street VARCHAR(160),
      neighborhood VARCHAR(120),
      city_id INTEGER NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_zip_codes_city_id ON zip_codes(city_id)`,
  );
}

//TABELA USUÁRIOS
async function usersTable() {
  await pool.query(
    `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) UNIQUE,
    password VARCHAR(100),
    phone VARCHAR(20),
    role VARCHAR(20) CHECK (role IN ('CLIENT', 'EMPLOYEE')),
    radius INTEGER,
    has_set_radius BOOLEAN DEFAULT FALSE,
    profile_color VARCHAR(20),
    city_id INTEGER NOT NULL,
    profession_id INTEGER,
    zip_code VARCHAR(20),
    neighborhood VARCHAR(120),
    street VARCHAR(160),
    number VARCHAR(30),
    complement VARCHAR(160),
    reference VARCHAR(200),
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT fk_city
      FOREIGN KEY(city_id)
      REFERENCES cities(id)
      ON DELETE CASCADE
    );
;
`,
  );

  await pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS profession_id INTEGER`,
  );
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS radius INTEGER`);
  await pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS has_set_radius BOOLEAN DEFAULT FALSE`,
  );
  await pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_color VARCHAR(20)`,
  );
  await pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS zip_code VARCHAR(20)`,
  );
  await pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS neighborhood VARCHAR(120)`,
  );
  await pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS street VARCHAR(160)`,
  );
  await pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS number VARCHAR(30)`,
  );
  await pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS complement VARCHAR(160)`,
  );
  await pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS reference VARCHAR(200)`,
  );
}

//TABELA SERVIÇOS (pode já existir, mas garantimos campos mínimos)
async function servicesTable() {
  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS services (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profession_id INTEGER,
      value NUMERIC,
      description TEXT,
      client_zip_code VARCHAR(20),
      client_neighborhood VARCHAR(120),
      client_street VARCHAR(160),
      client_number VARCHAR(30),
      client_complement VARCHAR(160),
      client_reference VARCHAR(200),
      employee_message TEXT,
      status VARCHAR(20) DEFAULT 'PENDING',
      added_as VARCHAR(20) DEFAULT 'CLIENT',
      type VARCHAR(20) CHECK (type IN ('GASTO', 'GANHO', 'FECHADO')),
      created_at TIMESTAMP DEFAULT NOW()
    );
    `,
  );

  // se a tabela já existia, podemos garantir que as colunas extra estejam presentes
  await pool.query(
    `ALTER TABLE services ADD COLUMN IF NOT EXISTS description TEXT`,
  );
  await pool.query(
    `ALTER TABLE services ADD COLUMN IF NOT EXISTS client_zip_code VARCHAR(20)`,
  );
  await pool.query(
    `ALTER TABLE services ADD COLUMN IF NOT EXISTS client_neighborhood VARCHAR(120)`,
  );
  await pool.query(
    `ALTER TABLE services ADD COLUMN IF NOT EXISTS client_street VARCHAR(160)`,
  );
  await pool.query(
    `ALTER TABLE services ADD COLUMN IF NOT EXISTS client_number VARCHAR(30)`,
  );
  await pool.query(
    `ALTER TABLE services ADD COLUMN IF NOT EXISTS client_complement VARCHAR(160)`,
  );
  await pool.query(
    `ALTER TABLE services ADD COLUMN IF NOT EXISTS client_reference VARCHAR(200)`,
  );
  await pool.query(
    `ALTER TABLE services ADD COLUMN IF NOT EXISTS employee_message TEXT`,
  );
  // se a tabela já existia, podemos garantir que a coluna added_as esteja presente
  await pool.query(
    `ALTER TABLE services ADD COLUMN IF NOT EXISTS added_as VARCHAR(20) DEFAULT 'CLIENT'`,
  );

  // Atualizar a constraint para incluir FECHADO
  // PostgreSQL: encontrar e remover constraint antiga se existir
  try {
    const constraintResult = await pool.query(
      `SELECT constraint_name FROM information_schema.table_constraints 
       WHERE table_name='services' AND constraint_type='CHECK'`,
    );

    // Se encontrou uma constraint CHECK, remover e recriar com valores corretos
    for (const row of constraintResult.rows) {
      await pool.query(
        `ALTER TABLE services DROP CONSTRAINT ${row.constraint_name}`,
      );
    }

    // Adicionar a constraint corrigida
    await pool.query(
      `ALTER TABLE services ADD CHECK (type IN ('GASTO', 'GANHO', 'FECHADO'))`,
    );
  } catch (e) {
    // Se falhar, a constraint já está correta ou não existe
    console.log(
      "Nota: CHECK constraint update skipped (pode estar correto já)",
    );
  }
}

// TABELA SERVICE REQUESTS (para contratação via plataforma)
async function serviceRequestsTable() {
  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS service_requests (
      id SERIAL PRIMARY KEY,
      client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      proposed_duration_minutes INTEGER,
      client_zip_code VARCHAR(20),
      client_neighborhood VARCHAR(120),
      client_street VARCHAR(160),
      client_number VARCHAR(30),
      client_complement VARCHAR(160),
      client_reference VARCHAR(200),
      status VARCHAR(20) DEFAULT 'PENDING',
      final_price NUMERIC,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    `,
  );

  await pool.query(
    `ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS client_zip_code VARCHAR(20)`,
  );
  await pool.query(
    `ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS proposed_duration_minutes INTEGER`,
  );
  await pool.query(
    `ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS client_neighborhood VARCHAR(120)`,
  );
  await pool.query(
    `ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS client_street VARCHAR(160)`,
  );
  await pool.query(
    `ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS client_number VARCHAR(30)`,
  );
  await pool.query(
    `ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS client_complement VARCHAR(160)`,
  );
  await pool.query(
    `ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS client_reference VARCHAR(200)`,
  );
  await pool.query(
    `ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS booking_service_id INTEGER`,
  );
  await pool.query(
    `ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS appointment_id INTEGER`,
  );
  await pool.query(
    `ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS appointment_date DATE`,
  );
  await pool.query(
    `ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS appointment_start_time TIME`,
  );
  await pool.query(
    `ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS appointment_end_time TIME`,
  );
}

// TABELAS DE AGENDAMENTO (inspirado no Booksy)
async function bookingTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS professionals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(120) NOT NULL,
      work_start TIME DEFAULT '08:00',
      work_end TIME DEFAULT '18:00',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS booking_services (
      id SERIAL PRIMARY KEY,
      professional_id INTEGER NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      name VARCHAR(140) NOT NULL,
      description TEXT,
      duration_minutes INTEGER NOT NULL,
      price NUMERIC(12,2) NOT NULL,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS professional_services (
      professional_id INTEGER NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      service_id INTEGER NOT NULL REFERENCES booking_services(id) ON DELETE CASCADE,
      PRIMARY KEY (professional_id, service_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS professional_availability (
      id SERIAL PRIMARY KEY,
      professional_id INTEGER NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      UNIQUE (professional_id, weekday)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS professional_shift_availability (
      id SERIAL PRIMARY KEY,
      professional_id INTEGER NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      period VARCHAR(20) NOT NULL CHECK (period IN ('MORNING', 'AFTERNOON', 'EVENING')),
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (professional_id, weekday, period)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS professional_work_intervals (
      id SERIAL PRIMARY KEY,
      professional_id INTEGER NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS appointments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      professional_id INTEGER NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
      service_id INTEGER NOT NULL REFERENCES booking_services(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'BOOKED',
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT ck_appointments_status CHECK (status IN ('BOOKED', 'CANCELLED', 'COMPLETED'))
    );
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_appointments_professional_date ON appointments(professional_id, date)`,
  );

  // Garante profissionais para usuários do tipo EMPLOYEE
  await pool.query(`
    INSERT INTO professionals (user_id, name)
    SELECT u.id, u.name
    FROM users u
    WHERE u.role = 'EMPLOYEE'
    ON CONFLICT (user_id) DO NOTHING
  `);

  // Disponibilidade padrão: seg-sex 08:00-18:00
  await pool.query(`
    INSERT INTO professional_availability (professional_id, weekday, start_time, end_time)
    SELECT p.id, d.weekday, p.work_start, p.work_end
    FROM professionals p
    CROSS JOIN (VALUES (1), (2), (3), (4), (5)) AS d(weekday)
    ON CONFLICT (professional_id, weekday) DO NOTHING
  `);

  // Serviço padrão para profissionais sem catálogo
  await pool.query(`
    INSERT INTO booking_services (professional_id, name, description, duration_minutes, price, active)
    SELECT p.id,
           'Atendimento Geral',
           'Servico padrao para solicitacoes com agendamento.',
           60,
           80.00,
           TRUE
    FROM professionals p
    WHERE NOT EXISTS (
      SELECT 1 FROM booking_services s WHERE s.professional_id = p.id
    )
  `);

  await pool.query(`
    INSERT INTO professional_services (professional_id, service_id)
    SELECT s.professional_id, s.id
    FROM booking_services s
    ON CONFLICT (professional_id, service_id) DO NOTHING
  `);
}

// TABELA NOTIFICAÇÕES (armazenar notificações por usuário)
async function notificationsTable() {
  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(50) NOT NULL,
      service_request_id INTEGER REFERENCES service_requests(id) ON DELETE CASCADE,
      from_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      from_user_name VARCHAR(100),
      from_user_city VARCHAR(100),
      description TEXT,
      client_zip_code VARCHAR(20),
      client_neighborhood VARCHAR(120),
      client_street VARCHAR(160),
      client_number VARCHAR(30),
      client_complement VARCHAR(160),
      client_reference VARCHAR(200),
      proposal_price NUMERIC,
      read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    `,
  );

  // Criar índice para melhorar performance
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id)`,
  );

  await pool.query(
    `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS client_zip_code VARCHAR(20)`,
  );
  await pool.query(
    `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS client_neighborhood VARCHAR(120)`,
  );
  await pool.query(
    `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS client_street VARCHAR(160)`,
  );
  await pool.query(
    `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS client_number VARCHAR(30)`,
  );
  await pool.query(
    `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS client_complement VARCHAR(160)`,
  );
  await pool.query(
    `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS client_reference VARCHAR(200)`,
  );
}

//INICIALIZAÇÃO DAS TABELAS -> VERIFICAR MELHOR OPÇÃO PARA DEPOIS
async function createTables() {
  try {
    await citiesTable();
    await zipCodesTable();
    await usersTable();
    await bookingTables();
    await servicesTable();
    await serviceRequestsTable();
    await notificationsTable();
  } catch (error) {
    console.log("Erro na inicialização das tabelas /db" + error);
  }
}

createTables();
module.exports = pool;
