import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { authMiddleware } from "../middlewares/auth.middleware";
import { staffMiddleware } from "../middlewares/staff.middleware";
import { uploadMiddleware } from "../middlewares/upload.middleware";
import { CustomError } from "../errors/customError.error";
import * as invoiceController from "../controllers/invoice.controller";

const router = Router();

/** Traduce los errores de multer (foto muy pesada, campo equivocado) a mensajes para el personal. */
function uploadImage(req: Request, res: Response, next: NextFunction) {
  uploadMiddleware.single("image")(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE")
        return next(new CustomError("La foto pesa más de 10 MB", 413));
      return next(new CustomError("Sube la foto de la factura en el campo 'image'", 400));
    }
    next(error);
  });
}

router.use(authMiddleware, staffMiddleware);

router.get("/", invoiceController.list);
router.get("/:id", invoiceController.getById);
router.post("/", uploadImage, invoiceController.create);
router.put("/:id", invoiceController.update);
router.post("/:id/confirm", invoiceController.confirm);
router.post("/:id/reject", invoiceController.reject);

export default router;
