import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { staffMiddleware } from "../middlewares/staff.middleware";
import * as waiterController from "../controllers/waiter.controller";

const router = Router();

router.get("/", authMiddleware, staffMiddleware, waiterController.list);
router.put("/:id", authMiddleware, adminMiddleware, waiterController.update);

export default router;
