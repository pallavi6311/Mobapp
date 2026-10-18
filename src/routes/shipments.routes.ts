import { Router, Response } from 'express';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { db } from '../config/firebase';
import { verifyToken, AuthRequest } from '../middleware/verifyToken';
import * as dotenv from 'dotenv';
dotenv.config();

const router = Router();
const OTP_TTL_MS = 30 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_MS = 60 * 1000;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

function otpHash(shipmentId: string, purpose: 'pickup' | 'delivery', code: string): string {
  const secret = process.env.APP_SECRET || process.env.FIREBASE_PRIVATE_KEY;
  if (!secret) throw new Error('APP_SECRET must be configured to issue shipment OTPs');
  return createHmac('sha256', secret).update(`${shipmentId}:${purpose}:${code}`).digest('hex');
}

function isValidOtp(ship: FirebaseFirestore.DocumentData, shipmentId: string, purpose: 'pickup' | 'delivery', code: string): boolean {
  const hash = ship[`${purpose}OtpHash`];
  const expiresAt = Date.parse(ship[`${purpose}OtpExpiresAt`] || '');
  const attempts = Number(ship[`${purpose}OtpAttempts`] || 0);
  if (!hash || !/^\d{6}$/.test(code) || !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now() || attempts >= OTP_MAX_ATTEMPTS) return false;
  const actual = Buffer.from(otpHash(shipmentId, purpose, code), 'hex');
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function publicShipment(data: FirebaseFirestore.DocumentData): FirebaseFirestore.DocumentData {
  const {
    pickupOtpHash, pickupOtpExpiresAt, pickupOtpAttempts, pickupOtpIssuedAt, pickupOtpUsedAt,
    deliveryOtpHash, deliveryOtpExpiresAt, deliveryOtpAttempts, deliveryOtpIssuedAt, deliveryOtpUsedAt,
    ...shipment
  } = data;
  return shipment;
}

function validPhoto(photoBase64: unknown, mimeType: unknown): photoBase64 is string {
  if (typeof photoBase64 !== 'string' || typeof mimeType !== 'string' ||
      !ALLOWED_IMAGE_TYPES.includes(mimeType) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(photoBase64) ||
      !photoBase64) return false;
  return Buffer.from(photoBase64, 'base64').length <= MAX_PHOTO_BYTES;
}

async function issueOtp(req: AuthRequest, res: Response, purpose: 'pickup' | 'delivery') {
  if (req.user?.role !== 'sender')
    return res.status(403).json({ error: 'Only the sender can generate shipment OTPs' });

  try {
    const doc = await db().collection('shipments').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Shipment not found' });
    const ship = doc.data()!;
    const expectedStatus = purpose === 'pickup' ? 'accepted' : 'picked_up';
    if (ship.senderId !== req.user!.uid)
      return res.status(403).json({ error: 'Not your shipment' });
    if (ship.status !== expectedStatus || ship.paymentStatus !== 'paid')
      return res.status(400).json({ error: `Shipment must be paid and ${expectedStatus} before issuing this OTP` });
    if (ship[`${purpose}OtpUsedAt`])
      return res.status(400).json({ error: 'This OTP has already been used' });
    const lastIssuedAt = Date.parse(ship[`${purpose}OtpIssuedAt`] || '');
    if (Number.isFinite(lastIssuedAt) && Date.now() - lastIssuedAt < OTP_RESEND_MS)
      return res.status(429).json({ error: 'Please wait one minute before generating another OTP' });

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const issuedAt = new Date().toISOString();
    await doc.ref.update({
      [`${purpose}OtpHash`]: otpHash(ship.id, purpose, code),
      [`${purpose}OtpExpiresAt`]: new Date(Date.now() + OTP_TTL_MS).toISOString(),
      [`${purpose}OtpAttempts`]: 0,
      [`${purpose}OtpIssuedAt`]: issuedAt,
    });
    return res.json({
      code,
      expiresAt: new Date(Date.now() + OTP_TTL_MS).toISOString(),
      message: 'Share this code directly with the person who must confirm the handover. SMS is not configured.',
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

async function validateOtpAttempt(
  docRef: FirebaseFirestore.DocumentReference,
  shipmentId: string,
  purpose: 'pickup' | 'delivery',
  code: string
): Promise<boolean> {
  return db().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(docRef);
    if (!snapshot.exists) return false;
    const ship = snapshot.data()!;
    if (isValidOtp(ship, shipmentId, purpose, code)) return true;
    const attempts = Number(ship[`${purpose}OtpAttempts`] || 0);
    if (ship[`${purpose}OtpHash`] && attempts < OTP_MAX_ATTEMPTS) {
      transaction.update(docRef, { [`${purpose}OtpAttempts`]: attempts + 1 });
    }
    return false;
  });
}

// Firebase Storage bucket (set FIREBASE_STORAGE_BUCKET in .env)
const STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || `${process.env.FIREBASE_PROJECT_ID}.appspot.com`;

/**
 * Upload a base64 image to Firebase Storage via Admin SDK REST API.
 * Returns a signed read URL without making evidence photos public.
 */
async function uploadBase64ToStorage(base64Data: string, mimeType: string, path: string): Promise<string> {
  const { getStorage } = await import('firebase-admin/storage');
  const bucket  = getStorage().bucket(STORAGE_BUCKET);
  const buffer  = Buffer.from(base64Data, 'base64');
  const file    = bucket.file(path);

  await file.save(buffer, {
    metadata: { contentType: mimeType },
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

  const { tripId, parcelDescription, weightKg, pickupSpot, deliveryAddress, receiverPhone, sealNumber, declaredValue, acceptsNoInsurance } = req.body;
  if (!tripId || !parcelDescription || !weightKg || !pickupSpot || !deliveryAddress || !receiverPhone || !sealNumber)
    return res.status(400).json({ error: 'tripId, parcelDescription, weightKg, pickupSpot, deliveryAddress, receiverPhone and sealNumber are required' });
  if (!Number.isFinite(Number(weightKg)) || Number(weightKg) <= 0 ||
      String(sealNumber).trim().length < 3 || String(sealNumber).trim().length > 50)
    return res.status(400).json({ error: 'Weight must be positive and seal number must be 3 to 50 characters' });
  if (!Number.isFinite(Number(declaredValue)) || Number(declaredValue) <= 0 || acceptsNoInsurance !== true)
    return res.status(400).json({ error: 'A valid declared parcel value and acknowledgement that insurance is not provided are required' });

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
      sealNumber: String(sealNumber).trim(),
      declaredValue: Number(declaredValue),
      insuranceStatus: 'not_provided',
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
    const results = snap.docs.map(d => publicShipment(d.data()));
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
    const ship = doc.data()!;
    if (ship.senderId !== req.user!.uid && ship.travellerId !== req.user!.uid)
      return res.status(403).json({ error: 'Not your shipment' });
    return res.json(publicShipment(ship));
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

// Legacy status updates bypass the handover evidence checks.
router.patch('/:id/status', verifyToken, async (req: AuthRequest, res: Response) => {
  return res.status(410).json({ error: 'Direct status updates are disabled. Use the OTP-verified handover actions.' });
});

router.post('/:id/pickup-code', verifyToken, async (req: AuthRequest, res: Response) =>
  issueOtp(req, res, 'pickup'));

router.post('/:id/delivery-code', verifyToken, async (req: AuthRequest, res: Response) =>
  issueOtp(req, res, 'delivery'));

// Traveller confirms pickup with the sender's OTP, matching tamper seal, and photo evidence.
router.patch('/:id/mark-pickup', verifyToken, async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'traveller')
    return res.status(403).json({ error: 'Only travellers can mark pickup' });

  const { otp = '', sealNumber = '', photoBase64, mimeType = 'image/jpeg' } = req.body;
  if (!/^\d{6}$/.test(otp))
    return res.status(400).json({ error: 'A valid 6-digit sender OTP is required' });
  if (!validPhoto(photoBase64, mimeType))
    return res.status(400).json({ error: 'A valid JPEG, PNG or WebP photo under 10 MB is required' });

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
    if (String(sealNumber).trim() !== ship.sealNumber)
      return res.status(400).json({ error: 'The seal number does not match the sender’s recorded seal' });
    if (!await validateOtpAttempt(doc.ref, ship.id, 'pickup', otp))
      return res.status(400).json({ error: 'Pickup OTP is incorrect, expired or locked. Ask the sender to generate a new one.' });

    const photoURL = await uploadBase64ToStorage(
      photoBase64,
      mimeType,
      `pickup-photos/${ship.id}/${Date.now()}.${mimeType.split('/')[1]}`
    );
    const now = new Date().toISOString();
    const updated = await db().runTransaction(async (transaction) => {
      const fresh = await transaction.get(doc.ref);
      const latest = fresh.data();
      if (!latest || latest.status !== 'accepted' || latest.travellerId !== req.user!.uid ||
          latest.paymentStatus !== 'paid' || latest.sealNumber !== String(sealNumber).trim() ||
          !isValidOtp(latest, ship.id, 'pickup', otp)) return false;
      transaction.update(doc.ref, {
        status: 'picked_up',
        pickedUpAt: now,
        pickupPhotoURL: photoURL,
        pickupOtpUsedAt: now,
        updatedAt: now,
      });
      return true;
    });
    if (!updated) return res.status(400).json({ error: 'Pickup OTP expired or was already used. Ask the sender to generate a new one.' });

    return res.json({ message: 'Pickup verified. The parcel is now in transit.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Delivery is recorded only after the receiver's OTP, seal check, and photo evidence.
router.post('/:id/upload-delivery-photo', verifyToken, async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'traveller')
    return res.status(403).json({ error: 'Only travellers can upload delivery photos' });

  const { otp = '', sealNumber = '', photoBase64, mimeType = 'image/jpeg' } = req.body;
  if (!/^\d{6}$/.test(otp))
    return res.status(400).json({ error: 'A valid 6-digit receiver OTP is required' });
  if (!validPhoto(photoBase64, mimeType))
    return res.status(400).json({ error: 'A valid JPEG, PNG or WebP photo under 10 MB is required' });

  try {
    const doc = await db().collection('shipments').doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'Shipment not found' });
    const ship = doc.data()!;

    if (ship.travellerId !== req.user!.uid)
      return res.status(403).json({ error: 'Not your shipment' });
    if (ship.status !== 'picked_up')
      return res.status(400).json({ error: 'Shipment must be in picked_up state to upload photo' });
    if (String(sealNumber).trim() !== ship.sealNumber)
      return res.status(400).json({ error: 'The parcel seal is missing or does not match the pickup record' });
    if (!await validateOtpAttempt(doc.ref, ship.id, 'delivery', otp))
      return res.status(400).json({ error: 'Receiver OTP is incorrect, expired or locked. Ask the sender to generate a new one.' });

    const photoURL = await uploadBase64ToStorage(
      photoBase64,
      mimeType,
      `delivery-photos/${ship.id}/${Date.now()}.${mimeType.split('/')[1]}`
    );
    const now = new Date().toISOString();
    const updated = await db().runTransaction(async (transaction) => {
      const fresh = await transaction.get(doc.ref);
      const latest = fresh.data();
      if (!latest || latest.status !== 'picked_up' || latest.travellerId !== req.user!.uid ||
          latest.sealNumber !== String(sealNumber).trim() ||
          !isValidOtp(latest, ship.id, 'delivery', otp)) return false;
      transaction.update(doc.ref, {
        status: 'delivered',
        deliveryPhotoURL: photoURL,
        deliveredAt: now,
        deliveryOtpUsedAt: now,
        updatedAt: now,
        deliveryConfirmed: false,
      });
      return true;
    });
    if (!updated) return res.status(400).json({ error: 'Receiver OTP expired or was already used. Ask the sender to generate a new one.' });

    return res.json({
      message: 'Receiver OTP, seal and delivery evidence recorded. Waiting for sender to confirm delivery.',
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
      const [tDoc, currentShipment] = await Promise.all([t.get(travellerRef), t.get(doc.ref)]);
      const currentShip = currentShipment.data();
      if (!currentShip || currentShip.senderId !== req.user!.uid ||
          currentShip.status !== 'delivered' || currentShip.paymentStatus !== 'paid' ||
          currentShip.deliveryConfirmed === true)
        throw new Error('Shipment is no longer eligible for delivery confirmation');
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
