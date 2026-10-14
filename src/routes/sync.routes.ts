import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { syncKeyMiddleware } from "../middlewares/syncKey.middleware";
import { syncOrAdminMiddleware } from "../middlewares/syncOrAdmin.middleware";
import { reportUploadMiddleware } from "../middlewares/upload.middleware";
import * as syncController from "../controllers/sync.controller";

const router = Router();

// Sin JWT: lo llama el agente de cada local con la llave compartida.
router.post("/sales", syncKeyMiddleware, syncController.sales);
router.post("/heartbeat", syncKeyMiddleware, syncController.heartbeat);
router.get("/status", authMiddleware, adminMiddleware, syncController.status);
// El reporte de ventas de SmartMenu: lo sube el dueño desde el panel o el agente del local.
router.post("/upload", syncOrAdminMiddleware, reportUploadMiddleware, syncController.upload);

export default router;
