import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { adminMiddleware } from "../middlewares/admin.middleware";
import * as userController from "../controllers/user.controller";

const router = Router();

router.use(authMiddleware, adminMiddleware);

router.get("/", userController.list);
router.post("/", userController.create);
router.put("/:id", userController.update);

export default router;
