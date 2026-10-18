import { Router, Request, Response } from 'express';
import { db, auth } from '../config/firebase';

const router = Router();

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response) => {
  const { email, password, fullName, phone, role } = req.body;

  if (!email || !password || !fullName || !role)
    return res.status(400).json({ error: 'email, password, fullName and role are required' });

  if (!['traveller', 'sender'].includes(role))
    return res.status(400).json({ error: 'role must be traveller or sender' });

  try {
    const userRecord = await auth().createUser({ email, password, displayName: fullName });
    await auth().setCustomUserClaims(userRecord.uid, { role });

    await db().collection('users').doc(userRecord.uid).set({
      uid: userRecord.uid,
      email,
      fullName,
      phone: phone || '',
      role,
      walletBalance: 0,
      createdAt: new Date().toISOString(),
    });

    return res.status(201).json({ message: 'User created', uid: userRecord.uid, role });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get('/me', async (req: Request, res: Response) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Unauthorized' });

  const token = header.split('Bearer ')[1];
  try {
    const decoded = await auth().verifyIdToken(token);
    const snap = await db().collection('users').doc(decoded.uid).get();
    if (!snap.exists) return res.status(404).json({ error: 'User not found' });
    return res.json(snap.data());
  } catch (err: any) {
    return res.status(401).json({ error: err.message });
  }
});

export default router;
