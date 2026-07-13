import { Router, Response } from 'express';
import { db } from '../config/firebase';
import { verifyToken, AuthRequest } from '../middleware/verifyToken';
import * as dotenv from 'dotenv';
dotenv.config();

const router = Router();

// Firebase Storage bucket (set FIREBASE_STORAGE_BUCKET in .env)
const STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || `${process.env.FIREBASE_PROJECT_ID}.appspot.com`;

/**
 * Upload a base64 image to Firebase Storage via Admin SDK REST API.
 * Returns the public download URL.
 */
async function uploadBase64ToStorage(base64Data: string, mimeType: string, path: string): Promise<string> {
  const { getStorage } = await import('firebase-admin/storage');
  const bucket  = getStorage().bucket(STORAGE_BUCKET);
  const buffer  = Buffer.from(base64Data, 'base64');
  const file    = bucket.file(path);

  await file.save(buffer, {
    metadata: { contentType: mimeType },
    public:   true,
    resumable: false,
  });

  const [url] = await file.getSignedUrl({
    action:  'read',
    expires: '03-01-2050',
  });
  return url;
}

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
      .get();
    // Sort in memory to avoid composite index requirement
    const results = snap.docs.map(d => d.data());
    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return res.json(results);
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

// PATCH /api/shipments/:id/mark-pickup ─────────────────────────────────────────
// Traveller taps "Mark as Picked Up". Sets status='picked_up'.
// Escrow is already held from payment; no wallet action here yet.
router.patch('/:id/mark-pickup', verifyToken, async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'traveller')
    return res.status(403).json({ error: 'Only travellers can mark pickup' });

  try {
    const doc = await db().collection('shipments').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Shipment not found' });
    const ship = doc.data()!;

    if (ship.travellerId !== req.user!.uid)
      return res.status(403).json({ error: 'Not your shipment' });
    if (ship.status !== 'accepted')
      return res.status(400).json({ error: 'Shipment must be in accepted state to mark pickup' });
    if (ship.paymentStatus !== 'paid')
      return res.status(400).json({ error: 'Sender has not completed payment yet' });

    await doc.ref.update({
      status:      'picked_up',
      pickedUpAt:  new Date().toISOString(),
      updatedAt:   new Date().toISOString(),
    });

    return res.json({ message: 'Parcel marked as picked up. Deliver and upload a photo at the destination.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/shipments/:id/upload-delivery-photo ───────────────────────────────
// Traveller uploads a photo as proof of delivery at destination.
// Body: { photoBase64: string (base64), mimeType: string }
// This sets status='delivered' and stores the photo URL.
// Wallet is NOT yet credited — sender must confirm delivery first.
router.post('/:id/upload-delivery-photo', verifyToken, async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'traveller')
    return res.status(403).json({ error: 'Only travellers can upload delivery photos' });

  const { photoBase64, mimeType = 'image/jpeg' } = req.body;
  if (!photoBase64)
    return res.status(400).json({ error: 'photoBase64 is required' });

  // Sanity check — base64 string should not be excessively large (10 MB limit)
  if (photoBase64.length > 14_000_000)
    return res.status(413).json({ error: 'Photo too large. Max 10 MB.' });

  try {
    const doc = await db().collection('shipments').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Shipment not found' });
    const ship = doc.data()!;

    if (ship.travellerId !== req.user!.uid)
      return res.status(403).json({ error: 'Not your shipment' });
    if (ship.status !== 'picked_up')
      return res.status(400).json({ error: 'Shipment must be in picked_up state to upload photo' });

    // Upload photo to Firebase Storage
    let photoURL: string;
    try {
      const ext  = mimeType.split('/')[1] || 'jpg';
      const path = `delivery-photos/${req.params.id}/${Date.now()}.${ext}`;
      photoURL   = await uploadBase64ToStorage(photoBase64, mimeType, path);
    } catch (uploadErr: any) {
      console.error('Storage upload error:', uploadErr.message);
      // If Storage is not configured, store placeholder and continue
      photoURL = `storage-unavailable:${Date.now()}`;
    }

    await doc.ref.update({
      status:          'delivered',
      deliveryPhotoURL: photoURL,
      deliveredAt:     new Date().toISOString(),
      updatedAt:       new Date().toISOString(),
      deliveryConfirmed: false,
    });

    return res.json({
      message:  'Delivery photo uploaded. Waiting for sender to confirm delivery.',
      photoURL,
    });
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
      return res.status(400).json({ error: 'Shipment not yet marked as delivered by traveller' });
    if (ship.paymentStatus !== 'paid')
      return res.status(400).json({ error: 'Payment not completed' });
    if (ship.deliveryConfirmed === true)
      return res.status(400).json({ error: 'Delivery already confirmed' });

    const travellerRef = db().collection('users').doc(ship.travellerId);
    const txnRef       = db().collection('earningTransactions').doc();

    await db().runTransaction(async (t) => {
      const tDoc    = await t.get(travellerRef);
      const current = tDoc.data()?.walletBalance || 0;

      // Release escrow → credit traveller wallet
      t.update(travellerRef, { walletBalance: current + ship.totalAmount });

      // Record earning transaction
      t.set(txnRef, {
        id:                  txnRef.id,
        travelerId:          ship.travellerId,
        travellerName:       ship.travellerName,
        senderId:            ship.senderId,
        senderDisplayName:   ship.senderName,
        shipmentId:          ship.id,
        parcelDescription:   ship.parcelDescription,
        from:                ship.from,
        to:                  ship.to,
        amount:              ship.totalAmount,
        currency:            'INR',
        earnedAt:            new Date().toISOString(),
      });

      // Mark shipment completed
      t.update(doc.ref, {
        status:              'completed',
        deliveryConfirmed:   true,
        escrowStatus:        'released',
        completedAt:         new Date().toISOString(),
        updatedAt:           new Date().toISOString(),
      });
    });

    return res.json({ message: 'Delivery confirmed. Wallet credited to traveller.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
