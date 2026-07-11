import { Router, Response } from 'express';
import { db } from '../config/firebase';
import { verifyToken, AuthRequest } from '../middleware/verifyToken';

const router = Router();

// POST /api/shipments
router.post('/', verifyToken, async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'sender')
    return res.status(403).json({ error: 'Only senders can create shipment requests' });

  const { tripId, parcelDescription, weightKg, pickupSpot, deliveryAddress, receiverPhone } = req.body;
  if (!tripId || !parcelDescription || !weightKg || !pickupSpot || !deliveryAddress)
    return res.status(400).json({ error: 'tripId, parcelDescription, weightKg, pickupSpot, deliveryAddress are required' });

  try {
    const tripDoc = await db().collection('trips').doc(tripId).get();
    if (!tripDoc.exists) return res.status(404).json({ error: 'Trip not found' });
    const trip = tripDoc.data()!;
    if (trip.status !== 'open') return res.status(400).json({ error: 'Trip is no longer accepting requests' });

    const senderDoc = await db().collection('users').doc(req.user!.uid).get();
    const sender = senderDoc.data();
    const amount = Math.round(Number(weightKg) * trip.pricePerKg * 100); // paise

    const shipRef = db().collection('shipments').doc();
    const shipment = {
      id: shipRef.id,
      tripId,
      travellerId: trip.travellerId,
      travellerName: trip.travellerName,
      travellerPhone: trip.travellerPhone || '',
      senderId: req.user!.uid,
      senderName: sender?.fullName || '',
      senderPhone: sender?.phone || '',
      from: trip.from, to: trip.to,
      departureDate: trip.departureDate,
      meansOfTravel: trip.meansOfTravel,
      parcelDescription,
      weightKg: Number(weightKg),
      pricePerKg: trip.pricePerKg,
      totalAmount: amount,
      pickupSpot,
      deliveryAddress,
      receiverPhone: receiverPhone || '',
      status: 'pending',
      paymentStatus: 'unpaid',
      razorpayOrderId: '',
      createdAt: new Date().toISOString(),
    };
    await shipRef.set(shipment);
    return res.status(201).json(shipment);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/shipments/my
router.get('/my', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const field = req.user!.role === 'sender' ? 'senderId' : 'travellerId';
    const snap = await db().collection('shipments')
      .where(field, '==', req.user!.uid)
      .orderBy('createdAt', 'desc')
      .get();
    return res.json(snap.docs.map(d => d.data()));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/shipments/:id
router.get('/:id', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const doc = await db().collection('shipments').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Shipment not found' });
    return res.json(doc.data());
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/shipments/:id/respond — traveller accepts or rejects
router.patch('/:id/respond', verifyToken, async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'traveller')
    return res.status(403).json({ error: 'Only travellers can respond' });

  const { action } = req.body;
  if (!['accept', 'reject'].includes(action))
    return res.status(400).json({ error: 'action must be accept or reject' });

  try {
    const doc = await db().collection('shipments').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Shipment not found' });
    const ship = doc.data()!;
    if (ship.travellerId !== req.user!.uid)
      return res.status(403).json({ error: 'Not your shipment' });
    if (ship.status !== 'pending')
      return res.status(400).json({ error: 'Already responded' });

    await doc.ref.update({
      status: action === 'accept' ? 'accepted' : 'rejected',
      respondedAt: new Date().toISOString(),
    });
    return res.json({ message: `Shipment ${action === 'accept' ? 'accepted' : 'rejected'}` });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/shipments/:id/status — traveller updates delivery progress
router.patch('/:id/status', verifyToken, async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'traveller')
    return res.status(403).json({ error: 'Only travellers can update status' });

  const { status } = req.body;
  if (!['picked_up', 'delivered'].includes(status))
    return res.status(400).json({ error: 'status must be picked_up or delivered' });

  try {
    const doc = await db().collection('shipments').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    if (doc.data()?.travellerId !== req.user!.uid)
      return res.status(403).json({ error: 'Not your shipment' });
    await doc.ref.update({ status, updatedAt: new Date().toISOString() });
    return res.json({ message: `Status updated to ${status}` });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/shipments/:id/confirm-delivery — sender confirms, credits traveller wallet
router.post('/:id/confirm-delivery', verifyToken, async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'sender')
    return res.status(403).json({ error: 'Only sender can confirm delivery' });

  try {
    const doc = await db().collection('shipments').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Not found' });
    const ship = doc.data()!;
    if (ship.senderId !== req.user!.uid)
      return res.status(403).json({ error: 'Not your shipment' });
    if (ship.status !== 'delivered')
      return res.status(400).json({ error: 'Shipment not yet marked as delivered' });
    if (ship.paymentStatus !== 'paid')
      return res.status(400).json({ error: 'Payment not completed' });

    const travellerRef = db().collection('users').doc(ship.travellerId);
    await db().runTransaction(async (t) => {
      const tDoc = await t.get(travellerRef);
      const current = tDoc.data()?.walletBalance || 0;
      t.update(travellerRef, { walletBalance: current + ship.totalAmount });
      t.update(doc.ref, { status: 'completed', completedAt: new Date().toISOString() });
    });
    return res.json({ message: 'Delivery confirmed. Wallet credited.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
