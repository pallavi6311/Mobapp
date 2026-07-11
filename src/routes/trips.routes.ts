import { Router, Response } from 'express';
import { db } from '../config/firebase';
import { verifyToken, AuthRequest } from '../middleware/verifyToken';

const router = Router();

// POST /api/trips — Traveller posts a trip
router.post('/', verifyToken, async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'traveller')
    return res.status(403).json({ error: 'Only travellers can post trips' });

  const { from, to, departureDate, departureTime, arrivalDate, arrivalTime, meansOfTravel, pricePerKg, availableWeight } = req.body;

  if (!from || !to || !departureDate || !meansOfTravel || !pricePerKg)
    return res.status(400).json({ error: 'from, to, departureDate, meansOfTravel, pricePerKg are required' });

  try {
    const travDoc = await db().collection('users').doc(req.user!.uid).get();
    const trav = travDoc.data();

    const tripRef = db().collection('trips').doc();
    const trip = {
      id: tripRef.id,
      travellerId: req.user!.uid,
      travellerName: trav?.fullName || '',
      travellerPhone: trav?.phone || '',
      from, to, departureDate,
      departureTime: departureTime || '',
      arrivalDate: arrivalDate || '',
      arrivalTime: arrivalTime || '',
      meansOfTravel,
      pricePerKg: Number(pricePerKg),
      availableWeight: Number(availableWeight) || 0,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    await tripRef.set(trip);
    return res.status(201).json(trip);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/trips
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query;
    const snap = await db().collection('trips')
      .where('status', '==', 'open')
      .get();

    let trips = snap.docs.map(d => d.data());
    // Sort in memory
    trips.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    if (from) trips = trips.filter(t => t.from.toLowerCase().includes((from as string).toLowerCase()));
    if (to)   trips = trips.filter(t => t.to.toLowerCase().includes((to as string).toLowerCase()));

    return res.json(trips);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/trips/my
router.get('/my', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const snap = await db().collection('trips')
      .where('travellerId', '==', req.user!.uid)
      .get();
    // Sort in memory - no composite index needed
    const results = snap.docs.map(d => d.data());
    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return res.json(results);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/trips/:id
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const doc = await db().collection('trips').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Trip not found' });
    return res.json(doc.data());
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/trips/:id/close
router.patch('/:id/close', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const doc = await db().collection('trips').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Trip not found' });
    if (doc.data()?.travellerId !== req.user!.uid)
      return res.status(403).json({ error: 'Not your trip' });
    await doc.ref.update({ status: 'closed' });
    return res.json({ message: 'Trip closed' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
