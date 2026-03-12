const express = require("express");
const app = express();
const PORT = 8000;
const cors = require("cors");
const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "../.env"),
  override: true,
});

const userRoutes = require("./routes/User/user.routes");
const cityRoutes = require("./routes/City/city.routes");
const serviceRoutes = require("./routes/Services/services.routes");
const hireServiceRoutes = require("./routes/HireServices/services.routes");
const notificationRoutes = require("./routes/Notifications/notifications.routes");
const paymentRoutes = require("./routes/Payments/payments.routes");
const bookingRoutes = require("./routes/Booking/booking.routes");

const pool = require("./database/db");

app.use(express.json());
app.use(
  cors({
    origin: (origin, callback) => callback(null, true),
    credentials: true,
  }),
);

// ROTAS PRINCIPAL

//Usuários
app.use("/users", userRoutes);

//Cidades
app.use("/cities", cityRoutes);

app.use("/api/user", userRoutes);

app.use("/services", serviceRoutes);

// Booking / agendamento
app.use("/", bookingRoutes);

// Service Requests Hiring
app.use("/service-requests", hireServiceRoutes);

// Notifications
app.use("/notifications", notificationRoutes);

// Payments (Checkout Pro + webhook)
app.use("/", paymentRoutes);

app.get("/", (req, res) => {
  res.send("API RODANDO AMIGO");
});

app.get("/db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      error: "Erro ao conectar no banco",
      details: error?.message || "Sem detalhes",
    });
  }
});

app.listen(PORT, () => {
  console.log("servidor rodando na porta " + PORT);
});
