const express = require("express");
const authMiddleware = require("../../middleware/auth");

let createNotification, getUserNotifications, markAsRead, deleteNotification;

try {
  const NotifRepo = require("./repository/Notifications");
  createNotification = NotifRepo.createNotification;
  getUserNotifications = NotifRepo.getUserNotifications;
  markAsRead = NotifRepo.markAsRead;
  deleteNotification = NotifRepo.deleteNotification;

  console.log("[NOTIFICATIONS ROUTES] Loaded functions:");
  console.log("  - createNotification:", typeof createNotification);
  console.log("  - getUserNotifications:", typeof getUserNotifications);
  console.log("  - markAsRead:", typeof markAsRead);
  console.log("  - deleteNotification:", typeof deleteNotification);
} catch (err) {
  console.error("[NOTIFICATIONS ROUTES] Error loading repository:", err);
}

const router = express.Router();

// POST - Criar notificação
router.post("/", createNotification);

// GET - Buscar notificações do usuário
router.get("/", authMiddleware, getUserNotifications);

// PATCH - Marcar como lida
router.patch("/:id/read", markAsRead);

// DELETE - Deletar notificação
router.delete("/:id", deleteNotification);

module.exports = router;
