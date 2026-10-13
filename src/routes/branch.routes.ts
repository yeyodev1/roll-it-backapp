import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import { staffMiddleware } from "../middlewares/staff.middleware";
import * as branchController from "../controllers/branch.controller";

const router = Router();

router.get("/", authMiddleware, staffMiddleware, branchController.list);
router.post("/", authMiddleware, adminMiddleware, branchController.create);
router.put("/:id", authMiddleware, adminMiddleware, branchController.update);

export default router;
