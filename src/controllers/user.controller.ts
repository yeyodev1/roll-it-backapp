import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";
import * as userService from "../services/user.service";

/** GET /api/users */
export async function list(_req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).json(await userService.listUsers());
  } catch (error) {
    next(error);
  }
}

/** POST /api/users — body: { email, password, name, accountType, branch? } */
export async function create(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(201).json(await userService.createPanelUser(req.body ?? {}));
  } catch (error) {
    next(error);
  }
}

/** PUT /api/users/:id — body: { name?, branch?, isActive?, password? } */
export async function update(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const user = await userService.updatePanelUser(
      String(req.params.id),
      req.body ?? {},
      req.user?.userId ?? "",
    );
    res.status(200).json(user);
  } catch (error) {
    next(error);
  }
}
