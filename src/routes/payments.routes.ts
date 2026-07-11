import { Router, Response } from 'express';
import * as crypto from 'crypto';
import { db } from '../config/firebase';
import { verifyToken, AuthRequest } from '../middleware/verifyToken';

const router = Router();

function getRazorpay() {
  const keyId     = process.env.RAZORPAY_KEY_ID || '';
  const keySecret = process.env.RAZORPAY_KEY_SECRET || '';
  if (!keyId || keyId.includes('XXXX')) {
    throw new Error('Razorpay credentials not configured in .env');
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Razorpay = require('razorpay');
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

// POST /api/payments/create-order
router.post('/create-order', verifyToken, async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'sender')
    return res.status(403).json({ error: 'Only senders can initiate payment' });

  const { shipmentId } = req.body;
  if (!shipmentId) return res.status(400).json({ error: 'shipmentId is required' });

  try {
    const doc = await db().collection('shipments').doc(shipmentId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Shipment not found' });
    const ship = doc.data()!;
    if (ship.senderId !== req.user!.uid) return res.status(403).json({ error: 'Not your shipment' });
    if (ship.status !== 'accepted') return res.status(400).json({ error: 'Shipment must be accepted before payment' });
    if (ship.paymentStatus === 'paid') return res.status(400).json({ error: 'Already paid' });

    const razorpay = getRazorpay();
    const order = await razorpay.orders.create({
      amount: ship.totalAmount,
      currency: 'INR',
      receipt: shipmentId,
      notes: { shipmentId, senderId: req.user!.uid, travellerId: ship.travellerId },
    });

    await doc.ref.update({ razorpayOrderId: order.id });

    return res.json({
      orderId: order.id,
      amount: ship.totalAmount,
      currency: 'INR',
      keyId: process.env.RAZORPAY_KEY_ID,
      shipmentId,
      description: `LoadLink: ${ship.from} → ${ship.to}`,
      senderName: ship.senderName,
      senderPhone: ship.senderPhone,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/verify
router.post('/verify', verifyToken, async (req: AuthRequest, res: Response) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, shipmentId } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !shipmentId)
    return res.status(400).json({ error: 'Missing payment verification fields' });

  // Allow mock payments (for test/demo mode)
  const isMock = razorpay_order_id.startsWith('mock_') || razorpay_payment_id.startsWith('mock_');

  if (!isMock) {
    // Real Razorpay signature verification
    if (!razorpay_signature) return res.status(400).json({ error: 'Missing signature' });
    const secret = process.env.RAZORPAY_KEY_SECRET || '';
    const body   = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    if (expected !== razorpay_signature)
      return res.status(400).json({ error: 'Payment signature verification failed' });
  }

  try {
    await db().collection('shipments').doc(shipmentId).update({
      paymentStatus: 'paid',
      razorpayPaymentId: razorpay_payment_id,
      paidAt: new Date().toISOString(),
    });
    return res.json({ message: 'Payment verified successfully' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/withdraw
router.post('/withdraw', verifyToken, async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'traveller')
    return res.status(403).json({ error: 'Only travellers can withdraw' });

  const { amount } = req.body;
  if (!amount || Number(amount) <= 0)
    return res.status(400).json({ error: 'Valid amount in paise is required' });

  try {
    const userRef = db().collection('users').doc(req.user!.uid);
    await db().runTransaction(async (t) => {
      const doc = await t.get(userRef);
      const balance = doc.data()?.walletBalance || 0;
      if (Number(amount) > balance) throw new Error('Insufficient wallet balance');
      t.update(userRef, { walletBalance: balance - Number(amount) });
      const wRef = db().collection('withdrawals').doc();
      t.set(wRef, {
        id: wRef.id,
        travellerId: req.user!.uid,
        amount: Number(amount),
        status: 'processing',
        requestedAt: new Date().toISOString(),
      });
    });
    return res.json({ message: 'Withdrawal request submitted. Processed within 24 hours.' });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// GET /api/payments/wallet
router.get('/wallet', verifyToken, async (req: AuthRequest, res: Response) => {
  try {
    const doc = await db().collection('users').doc(req.user!.uid).get();
    const balance = doc.data()?.walletBalance || 0;
    return res.json({ walletBalance: balance, walletBalanceFormatted: `₹${(balance / 100).toFixed(2)}` });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
