import { Request, Response, NextFunction } from 'express';
import { auth } from '../config/firebase';

export interface AuthRequest extends Request {
  user?: { uid: string; email?: string; role?: string; };
}

export async function verifyToken(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Unauthorized: No token provided' });

  const token = header.split('Bearer ')[1];
  try {
    const decoded = await auth().verifyIdToken(token);
    req.user = { uid: decoded.uid, email: decoded.email, role: decoded['role'] as string };
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}
