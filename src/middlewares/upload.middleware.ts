import { Request, Response, NextFunction } from "express";
import multer from "multer";
import { CustomError } from "../errors/customError.error";

// memoryStorage: el archivo llega en req.file.buffer y se sube a Cloudinary
// desde el service. En Vercel no hay disco persistente.
const storage = multer.memoryStorage();

export const uploadMiddleware = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

const REPORT_MAX_MB = 15;
const reportUpload = multer({ storage, limits: { fileSize: REPORT_MAX_MB * 1024 * 1024 } });

/**
 * Reporte de ventas de SmartMenu (campo `file`). El exporte de varios meses
 * pesa más que una foto de factura, por eso tiene su propio tope. Sin esto un
 * archivo grande respondería un 500 en inglés.
 */
export function reportUploadMiddleware(req: Request, res: Response, next: NextFunction) {
  reportUpload.single("file")(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      next(new CustomError(`El archivo pesa más de ${REPORT_MAX_MB} MB`, 413));
      return;
    }
    if (error instanceof multer.MulterError) {
      next(new CustomError("Sube el reporte en el campo «file»", 400));
      return;
    }
    next(error);
  });
}
