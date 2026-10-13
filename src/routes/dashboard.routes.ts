import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import * as dashboardController from "../controllers/dashboard.controller";

const router = Router();

router.use(authMiddleware, adminMiddleware);

router.get("/summary", dashboardController.summary);
router.get("/operations", dashboardController.operations);
router.get("/waiters", dashboardController.waiters);
router.get("/finance", dashboardController.finance);

export default router;
