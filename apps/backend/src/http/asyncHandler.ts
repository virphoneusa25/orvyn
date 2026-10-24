import type { Request, Response, NextFunction, RequestHandler } from "express";

/** Express 4 does not forward rejected promises to error middleware. */
export function asyncHandler<R extends Request = Request>(handler:(req:R,res:Response,next:NextFunction) => unknown): RequestHandler {
  return (req,res,next) => {
    try { Promise.resolve(handler(req as R,res,next)).catch(next); }
    catch (error) { next(error); }
  };
}
